require('dotenv').config()
const express = require('express')
const { processMessage } = require('./agent')
const { normalizePhone, resolveLid } = require('./evolution')
const { getSession, updateSession, addMessage } = require('./supabase')
const { sendWhatsAppMessage } = require('./evolution')
const { transcribeAudio } = require('./transcribe')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    agent: 'João Terra Imóveis v2.0',
    timestamp: new Date().toISOString()
  })
})

// Webhook principal — Evolution API
app.post('/webhook', async (req, res) => {
  // Responde 200 imediatamente para a Evolution não retentar
  res.status(200).json({ received: true })

  try {
    const payload = req.body

    // Filtra apenas mensagens de texto recebidas
    const event = payload.event
    if (event !== 'messages.upsert') return

    const message = payload.data
    if (!message) return

    // Ignora mensagens enviadas pelo próprio número (evita loop)
    if (message.key?.fromMe === true) return

    // Extrai texto da mensagem
    let text =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.buttonsResponseMessage?.selectedDisplayText

    // Trata mensagem de áudio — transcreve via Whisper
    if (!text && message.message?.audioMessage) {
      console.log('[Webhook] Áudio recebido — transcrevendo...')
      const transcribed = await transcribeAudio(message.key)
      if (transcribed) {
        text = transcribed
        console.log(`[Webhook] Áudio transcrito: "${text}"`)
      } else {
        console.log('[Webhook] Falha na transcrição — áudio ignorado')
        return
      }
    }

    if (!text || text.trim() === '') return

    // Log completo para debug de @lid
    if (message.key?.remoteJid?.includes('@lid')) {
      const keys = Object.keys(message)
      console.log('[Debug @lid] Campos disponíveis:', keys.join(', '))
      console.log('[Debug @lid] pushName:', message.pushName)
      console.log('[Debug @lid] key:', JSON.stringify(message.key))
      console.log('[Debug @lid] messageStubParameters:', message.messageStubParameters)
    }

    // Extrai número do remetente
    const remoteJid = message.key?.remoteJid || ''
    const pushName = message.pushName || ''

    if (!remoteJid) {
      console.error('[Webhook] remoteJid ausente — mensagem ignorada')
      return
    }

    // Normaliza o número (@lid é passado diretamente para a Evolution API)
    let phone = normalizePhone(remoteJid)
    if (!phone) {
      console.error(`[Webhook] Número inválido após normalização: ${remoteJid}`)
      return
    }

    // @lid não é um JID válido para ENVIO (a Evolution API recebe mensagens
    // dele, mas reporta "exists: false" ao tentar mandar de volta — erro 400
    // visto em produção em 2026-06-07). Tenta resolver para o número de
    // telefone real via lista de contatos antes de seguir.
    if (remoteJid.includes('@lid')) {
      const resolved = await resolveLid(remoteJid, pushName)
      if (resolved) {
        console.log(`[Webhook] @lid resolvido para número real: ${resolved} (${pushName})`)
        phone = resolved
      } else {
        console.log(`[Webhook] @lid não resolvido — seguindo com JID direto (envio pode falhar): ${phone} (${pushName})`)
      }
    }

    // Verifica se é comando /responder enviado pelo próprio João
    const joaoPhone = process.env.JOAO_PHONE_NUMBER
    if (joaoPhone && phone === joaoPhone.replace('@s.whatsapp.net', '').replace(/\D/g, '')) {
      const cmd = parseResponderCommand(text, phone)
      if (cmd) {
        try {
          await sendWhatsAppMessage(cmd.targetPhone, cmd.message)
          await addMessage(cmd.targetPhone, 'assistant', cmd.message)
          await updateSession(cmd.targetPhone, { state: 'TRIAGEM_LOCACAO' })
          console.log(`[Responder] João respondeu para ${cmd.targetPhone}: "${cmd.message}"`)
        } catch (err) {
          console.error('[Responder] Erro ao processar comando:', err.message)
        }
        return
      }
    }

    // Filtra: só atende primeiro contato absoluto (sem sessão prévia no Supabase)
    const existingSession = await getSession(phone)
    if (existingSession) {
      console.log(`[Webhook] Número ${phone} já tem sessão — ignorado (não é primeiro contato)`)
      return
    }

    console.log(`[Webhook] Nova mensagem | De: ${phone} (${pushName}) | Texto: "${text}"`)

    // Processa a mensagem no agente
    await processMessage(phone, text)

  } catch (err) {
    console.error('[Webhook] Erro ao processar mensagem:', err.message)
  }
})

// Rota /responder — João envia resposta pra cliente pausado
// Uso: manda mensagem pro seu próprio WhatsApp: /responder 5543XXXXX sua resposta aqui
app.post('/responder', async (req, res) => {
  const { phone, message } = req.body
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone e message são obrigatórios' })
  }

  try {
    const session = await getSession(phone)
    if (!session) {
      return res.status(404).json({ error: 'Sessão não encontrada' })
    }

    // Envia a resposta ao cliente
    await sendWhatsAppMessage(phone, message)

    // Salva a resposta no histórico como se fosse do assistente
    await addMessage(phone, 'assistant', message)

    // Retoma a sessão (volta pro estado anterior ao AGUARDANDO_JOAO)
    await updateSession(phone, { state: 'TRIAGEM_LOCACAO' })

    console.log(`[Responder] João respondeu para ${phone}: "${message}"`)
    res.json({ success: true })
  } catch (err) {
    console.error('[Responder] Erro:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Também aceita via webhook quando João manda /responder pelo próprio WhatsApp
function parseResponderCommand(text, fromPhone) {
  if (!text || !text.startsWith('/responder')) return null
  const parts = text.replace('/responder', '').trim().split(' ')
  const targetPhone = parts[0]
  const message = parts.slice(1).join(' ')
  if (!targetPhone || !message) return null
  return { targetPhone, message }
}

module.exports.parseResponderCommand = parseResponderCommand

// Endpoint de teste manual (desenvolvimento)
app.post('/test', async (req, res) => {
  const { phone, message } = req.body
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone e message são obrigatórios' })
  }

  try {
    const response = await processMessage(phone, message)
    res.json({ success: true, response })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`[Servidor] Agente João Terra Imóveis v2.0 rodando na porta ${PORT}`)
  console.log(`[Servidor] Webhook: POST /webhook`)
  console.log(`[Servidor] Health: GET /health`)
  console.log(`[Servidor] Teste: POST /test`)
})
