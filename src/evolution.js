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

// Normaliza número: remove @s.whatsapp.net, @lid, etc.
function normalizePhone(raw) {
  if (!raw) return null
  let phone = raw
    .replace('@s.whatsapp.net', '')
    .replace('@c.us', '')
    .trim()

  // Se contém @lid, não conseguimos resolver aqui — retorna null
  if (phone.includes('@lid')) {
    console.warn(`[Evolution] Número @lid não resolvido: ${raw}`)
    return null
  }

  // Remove caracteres não numéricos
  phone = phone.replace(/\D/g, '')

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

  const number = `${normalized}@s.whatsapp.net`

  try {
    const response = await axios.post(
      `${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      { number, text },
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
    // Busca lista de contatos e cruza pelo pushName
    const response = await axios.get(
      `${EVOLUTION_URL}/chat/findContacts/${INSTANCE}`,
      { headers, params: { where: JSON.stringify({ pushName }) } }
    )

    const contacts = response.data
    if (contacts && contacts.length > 0) {
      const contact = contacts.find(c => c.pushName === pushName)
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
