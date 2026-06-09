require('dotenv').config()
const express = require('express')
const { processMessage } = require('./agent')
const { normalizePhone, resolveLid } = require('./evolution')
const { getSession } = require('./supabase')

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
    const text =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.buttonsResponseMessage?.selectedDisplayText

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
