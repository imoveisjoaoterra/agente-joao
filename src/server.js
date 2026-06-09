require('dotenv').config()
const express = require('express')
const { processMessage } = require('./agent')
const { normalizePhone, resolveLid } = require('./evolution')
const { getSession, updateSession, addMessage } = require('./supabase')
const { sendWhatsAppMessage } = require('./evolution')
const { transcribeAudio } = require('./transcribe')
const { processMessengerMessage } = require('./messenger-agent')

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

    // Ignora mensagens de grupos (@g.us)
    if (message.key?.remoteJid?.endsWith('@g.us')) return

    // Extrai texto da mensagem
    let text =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.buttonsResponseMessage?.selectedDisplayText

    // Trata mensagem de áudio — transcreve via Whisper
    if (!text && !message.key?.fromMe && message.message?.audioMessage) {
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

    // @lid não é um JID válido para ENVIO
    if (remoteJid.includes('@lid')) {
      const resolved = await resolveLid(remoteJid, pushName)
      if (resolved) {
        console.log(`[Webhook] @lid resolvido para número real: ${resolved} (${pushName})`)
        phone = resolved
      } else {
        console.log(`[Webhook] @lid não resolvido — seguindo com JID direto: ${phone} (${pushName})`)
      }
    }

    // Verifica se é comando /responder enviado pelo próprio João
    // IMPORTANTE: este check vem ANTES do filtro fromMe para que o João
    // consiga usar /responder a partir do seu próprio número
    const joaoPhone = process.env.JOAO_PHONE_NUMBER
    const normalizeForCompare = (n) => n.replace('@s.whatsapp.net', '').replace(/\D/g, '').replace(/^55(\d{2})9(\d{8})$/, '55$1$2')
    if (joaoPhone && normalizeForCompare(phone) === normalizeForCompare(joaoPhone)) {
      const cmd = parseResponderCommand(text, phone)
      if (cmd) {
        console.log(`[Responder] Comando detectado — target: ${cmd.targetPhone} | msg: "${cmd.message}"`)
        try {
          // Normaliza o número do cliente para bater com o que está na sessão
          const targetNorm = normalizePhone(cmd.targetPhone)
          console.log(`[Responder] Número normalizado: ${cmd.targetPhone} → ${targetNorm}`)
          const sent = await sendWhatsAppMessage(targetNorm, cmd.message)
          console.log(`[Responder] Envio: ${sent ? 'OK' : 'FALHOU'}`)
          await addMessage(targetNorm, 'assistant', cmd.message)
          // Retoma sessão no estado de triagem adequado (não hardcoded)
          const clientSession = await getSession(targetNorm)
          const resumeState = clientSession?.profile?.finalidade === 'venda'
            ? 'TRIAGEM_COMPRA' : 'TRIAGEM_LOCACAO'
          await updateSession(targetNorm, { state: resumeState })
          console.log(`[Responder] Sessão retomada em ${resumeState} para ${targetNorm}`)
        } catch (err) {
          console.error('[Responder] Erro ao processar comando:', err.message)
        }
        return
      }
      console.log(`[Responder] Mensagem do João não é /responder — ignorando`)
      return // Mensagens do próprio João que não são /responder não são processadas
    }

    // Ignora mensagens enviadas pelo próprio número (evita loop)
    if (message.key?.fromMe === true) return

    // Filtra: só inicia atendimento pra primeiro contato absoluto
    // Mas continua respondendo quem já tem sessão ATIVA (conversa em andamento)
    const existingSession = await getSession(phone)
    if (existingSession) {
      if (existingSession.state === 'ENCERRADO') {
        console.log(`[Webhook] Número ${phone} com sessão encerrada — ignorado`)
        return
      }
      // Sessão ativa — deixa passar pra continuar a conversa
    }

    console.log(`[Webhook] Nova mensagem | De: ${phone} (${pushName}) | Texto: "${text}"`)

    // Processa a mensagem no agente (passa pushName para salvar nome do WhatsApp no perfil)
    await processMessage(phone, text, pushName)

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

// Webhook Messenger — verificação (GET)
app.get('/webhook/messenger', (req, res) => {
  const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Messenger] Webhook verificado com sucesso')
    res.status(200).send(challenge)
  } else {
    console.error('[Messenger] Falha na verificação do webhook')
    res.sendStatus(403)
  }
})

// Webhook Messenger — recebe mensagens (POST)
app.post('/webhook/messenger', (req, res) => {
  res.status(200).send('EVENT_RECEIVED')

  const body = req.body
  if (body.object !== 'page') return

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      // Ignora eco das próprias mensagens enviadas pelo app
      if (event.message?.is_echo) continue
      // Só processa mensagens de texto
      if (!event.message?.text) continue

      const senderId = event.sender.id
      const text = event.message.text
      // senderName não vem no evento — será buscado via API se necessário
      const senderName = ''

      processMessengerMessage(senderId, text, senderName).catch(err => {
        console.error('[Messenger] Erro ao processar mensagem:', err.message)
      })
    }
  }
})

app.listen(PORT, () => {
  console.log(`[Servidor] Agente João Terra Imóveis v2.0 rodando na porta ${PORT}`)
  console.log(`[Servidor] Webhook WhatsApp:  POST /webhook`)
  console.log(`[Servidor] Webhook Messenger: GET|POST /webhook/messenger`)
  console.log(`[Servidor] Health: GET /health`)
  console.log(`[Servidor] Teste: POST /test`)
})
