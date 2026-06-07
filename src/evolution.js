require('dotenv').config()
const axios = require('axios')

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME
const JOAO_PHONE = process.env.JOAO_PHONE_NUMBER

const headers = {
  'apikey': EVOLUTION_KEY,
  'Content-Type': 'application/json'
}

// Normaliza número: remove @s.whatsapp.net, @c.us
// Para @lid mantém o JID completo — Evolution API consegue enviar direto
function normalizePhone(raw) {
  if (!raw) return null
  let phone = raw.trim()

  // @lid — usa o JID completo diretamente
  if (phone.includes('@lid')) {
    return phone
  }

  // Remove sufixos comuns
  phone = phone
    .replace('@s.whatsapp.net', '')
    .replace('@c.us', '')
    .replace(/\D/g, '')

  // Garante código do país Brasil
  if (phone.length === 11 && !phone.startsWith('55')) {
    phone = `55${phone}`
  }

  return phone
}

// Envia mensagem de texto via Evolution API
async function sendWhatsAppMessage(phone, text) {
  const normalized = normalizePhone(phone)
  if (!normalized) {
    console.error(`[Evolution] Número inválido, mensagem não enviada: ${phone}`)
    return false
  }

  // Se já tem @ (ex: @lid ou @s.whatsapp.net), usa direto; senão adiciona sufixo
  const number = normalized.includes('@') ? normalized : `${normalized}@s.whatsapp.net`

  try {
    const response = await axios.post(
      `${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      { number, textMessage: { text } },
      { headers }
    )

    if (response.status === 200 || response.status === 201) {
      console.log(`[Evolution] Mensagem enviada para ${normalized}`)
      return true
    }

    console.error(`[Evolution] Falha ao enviar. Status: ${response.status}`)
    return false
  } catch (err) {
    console.error(`[Evolution] Erro ao enviar mensagem: ${err.message}`)
    if (err.response) {
      console.error(`[Evolution] Detalhes do erro (status ${err.response.status}): ${JSON.stringify(err.response.data)}`)
      console.error(`[Evolution] Payload enviado: ${JSON.stringify({ number, text })}`)
    }
    return false
  }
}

// Notifica João Terra
async function notifyJoao(message) {
  if (!JOAO_PHONE) {
    console.warn('[Evolution] JOAO_PHONE_NUMBER não configurado')
    return false
  }
  return await sendWhatsAppMessage(JOAO_PHONE, message)
}

// Tenta resolver @lid via API de contatos
async function resolveLid(lidJid, pushName) {
  if (!lidJid.includes('@lid')) return null

  try {
    // Endpoint correto é POST com corpo { where: {...} } — não GET com query
    // params (era a causa do 404 anterior). Doc oficial:
    // https://doc.evolution-api.com/v2/api-reference/chat-controller/find-contacts
    const response = await axios.post(
      `${EVOLUTION_URL}/chat/findContacts/${INSTANCE}`,
      { where: { pushName } },
      { headers }
    )

    const contacts = response.data
    if (Array.isArray(contacts) && contacts.length > 0) {
      const contact = contacts.find(c => c.pushName === pushName) || contacts[0]
      if (contact && contact.id) {
        return contact.id.replace('@s.whatsapp.net', '')
      }
    }
  } catch (err) {
    console.error(`[Evolution] Erro ao resolver @lid: ${err.message}`)
  }

  return null
}

module.exports = { sendWhatsAppMessage, notifyJoao, normalizePhone, resolveLid }
