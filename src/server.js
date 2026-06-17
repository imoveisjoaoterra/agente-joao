require('dotenv').config()
const express = require('express')
const { processMessage } = require('./agent')
const { normalizePhone, resolveLid, getAgendaName } = require('./evolution')
const { getSession, updateSession, addMessage, getClient } = require('./supabase')
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

    // Comandos do João via WhatsApp — ANTES do filtro fromMe
    const joaoPhone = process.env.JOAO_PHONE_NUMBER
    const normalizeForCompare = (n) => n.replace('@s.whatsapp.net', '').replace(/\D/g, '').replace(/^55(\d{2})9(\d{8})$/, '55$1$2')
    if (joaoPhone && normalizeForCompare(phone) === normalizeForCompare(joaoPhone)) {
      const handled = await handleJoaoCommand(text, phone)
      if (handled) return
      // Mensagem do João que não é comando — ignora
      console.log(`[Comandos] Mensagem do João ignorada (não é comando): "${text}"`)
      return
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

    // Prioridade: nome salvo na agenda de João → pushName do WhatsApp → null
    const agendaName = await getAgendaName(phone)
    const nomeEfetivo = agendaName || pushName
    console.log(`[Webhook] Nova mensagem | De: ${phone} | Agenda: ${agendaName || '-'} | WhatsApp: ${pushName || '-'} | Texto: "${text}"`)

    await processMessage(phone, text, nomeEfetivo, !!agendaName)

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

// Processa todos os comandos que João pode mandar pelo próprio WhatsApp
// Retorna true se o comando foi reconhecido e tratado
async function handleJoaoCommand(text, fromPhone) {
  if (!text) return false
  const trim = text.trim()

  // /responder 5543XXXXX mensagem
  if (trim.startsWith('/responder')) {
    const parts = trim.replace('/responder', '').trim().split(' ')
    const targetPhone = normalizePhone(parts[0])
    const message = parts.slice(1).join(' ')
    if (!targetPhone || !message) {
      await sendWhatsAppMessage(fromPhone, 'Uso: /responder [numero] [mensagem]')
      return true
    }
    const sent = await sendWhatsAppMessage(targetPhone, message)
    await addMessage(targetPhone, 'assistant', message)
    const clientSession = await getSession(targetPhone)
    const resumeState = clientSession?.profile?.finalidade === 'venda' ? 'TRIAGEM_COMPRA' : 'TRIAGEM_LOCACAO'
    await updateSession(targetPhone, { state: resumeState })
    await sendWhatsAppMessage(fromPhone, sent ? `Enviado para ${targetPhone}` : `Falha ao enviar para ${targetPhone}`)
    console.log(`[Comandos] /responder → ${targetPhone}: "${message}"`)
    return true
  }

  // /pausar geral
  if (trim === '/pausar geral') {
    const sb = getClient()
    await sb.from('config').upsert({ key: 'agent_paused', value: 'true' })
    await sendWhatsAppMessage(fromPhone, 'Agente pausado para todos os leads.')
    console.log('[Comandos] Agente pausado globalmente')
    return true
  }

  // /reativar geral
  if (trim === '/reativar geral') {
    const sb = getClient()
    await sb.from('config').upsert({ key: 'agent_paused', value: 'false' })
    await sendWhatsAppMessage(fromPhone, 'Agente reativado para todos os leads.')
    console.log('[Comandos] Agente reativado globalmente')
    return true
  }

  // /pausar 5543XXXXX
  if (trim.startsWith('/pausar ')) {
    const targetPhone = normalizePhone(trim.replace('/pausar', '').trim())
    if (!targetPhone) return false
    await updateSession(targetPhone, { state: 'AGUARDANDO_JOAO' })
    await sendWhatsAppMessage(fromPhone, `Atendimento pausado para ${targetPhone}.`)
    console.log(`[Comandos] /pausar → ${targetPhone}`)
    return true
  }

  // /reativar 5543XXXXX
  if (trim.startsWith('/reativar ')) {
    const targetPhone = normalizePhone(trim.replace('/reativar', '').trim())
    if (!targetPhone) return false
    const clientSession = await getSession(targetPhone)
    const resumeState = clientSession?.profile?.finalidade === 'venda' ? 'TRIAGEM_COMPRA' : 'TRIAGEM_LOCACAO'
    await updateSession(targetPhone, { state: resumeState })
    await sendWhatsAppMessage(fromPhone, `Atendimento retomado para ${targetPhone}.`)
    console.log(`[Comandos] /reativar → ${targetPhone}`)
    return true
  }

  // /contexto 5543XXXXX [informações]
  if (trim.startsWith('/contexto ')) {
    const rest = trim.replace('/contexto', '').trim()
    const parts = rest.split(' ')
    const targetPhone = normalizePhone(parts[0])
    const contexto = parts.slice(1).join(' ')
    if (!targetPhone || !contexto) {
      await sendWhatsAppMessage(fromPhone, 'Uso: /contexto [numero] [informações do cliente]')
      return true
    }
    // Garante que a sessão existe
    const { getOrCreateSession } = require('./supabase')
    const clientSession = await getOrCreateSession(targetPhone)
    const profile = clientSession?.profile || {}
    profile.contexto_manual = contexto
    await updateSession(targetPhone, { profile })
    // Registra como mensagem interna no histórico
    await addMessage(targetPhone, 'assistant', `[Contexto adicionado por João]: ${contexto}`)
    await sendWhatsAppMessage(fromPhone, `Contexto salvo para ${targetPhone}.`)
    console.log(`[Comandos] /contexto → ${targetPhone}: "${contexto}"`)
    return true
  }

  return false // comando não reconhecido
}

module.exports.handleJoaoCommand = handleJoaoCommand

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
