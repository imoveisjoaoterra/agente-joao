require('dotenv').config()
const Anthropic = require('@anthropic-ai/sdk')
const { getOrCreateSession, updateSession, addMessage, getSession } = require('./supabase')
const { sendMessengerMessage, sendTypingOn } = require('./messenger')
const { addLead, updateLead, stateToStatus, buildObservacoes } = require('./sheets')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Número do WhatsApp para o CTA (sem formatação)
const WHATSAPP_NUMBER = process.env.JOAO_PHONE_NUMBER || '554384853042'

// Prefixo para diferenciar sessões do Messenger das do WhatsApp no Supabase
const FB_PREFIX = 'fb_'

// Prompt do agente de pré-atendimento Messenger
function buildMessengerPrompt(session) {
  const { profile, messages, state } = session

  const now = new Date()
  const hour = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours()
  let saudacao = 'Boa noite'
  if (hour >= 5 && hour < 12) saudacao = 'Bom dia'
  else if (hour >= 12 && hour < 18) saudacao = 'Boa tarde'

  const profileText = Object.keys(profile || {}).length > 0
    ? `\nPerfil coletado até agora: ${JSON.stringify(profile)}`
    : ''

  const historyText = messages && messages.length > 0
    ? `\nHistórico:\n${messages.slice(-6).map(m => `${m.role === 'user' ? 'Cliente' : 'Atendimento'}: ${m.content}`).join('\n')}`
    : ''

  const waLink = `https://wa.me/${WHATSAPP_NUMBER.replace(/\D/g, '')}`

  return `Você é o pré-atendimento da João Terra Imóveis no Messenger do Facebook.

## Objetivo
Fazer uma qualificação rápida e direcionar o cliente para o WhatsApp, onde o atendimento completo acontece.

## Regras
- Máximo 1-2 frases por mensagem. Direto, seco, sem enrolação.
- PROIBIDO emojis.
- PROIBIDO mencionar "João" ou que vai "passar para alguém".
- Fale em primeira pessoa: "eu verifico", "deixa eu checar".
- Nunca invente imóveis, valores ou disponibilidade.

## Fluxo obrigatório (siga nessa ordem)
1. Saudação correta pelo horário: "${saudacao}, tudo bem?"
2. Após resposta: "Em que posso te ajudar?"
3. Entenda em até 2 perguntas: tipo de interesse (compra/aluguel/outra dúvida) + região/valor se possível
4. Assim que tiver o interesse básico, encaminhe para o WhatsApp:
   "Para continuar seu atendimento com mais agilidade, fala comigo pelo WhatsApp: ${waLink}"
5. Após enviar o link, encerre a conversa no Messenger educadamente.

## Quando encerrar
- Após enviar o link do WhatsApp, não continue respondendo — a conversa migrou.
- Se o cliente insistir em continuar no Messenger, reforce gentilmente que o atendimento completo é pelo WhatsApp.

Saudação correta agora: ${saudacao}
Estado atual: ${state}
${profileText}
${historyText}

Responda a próxima mensagem seguindo o fluxo acima.`
}

// Detecta finalidade básica da mensagem
function detectFinalidadeMessenger(text) {
  const lower = text.toLowerCase()
  if (/comprar|compra|à venda|a venda|financiar/.test(lower)) return 'venda'
  if (/alugar|aluguel|locar|locação/.test(lower)) return 'aluguel'
  if (/boleto|manutenção|rescisão|inquilino/.test(lower)) return 'inquilino'
  if (/colocar pra alugar|administrar|captar/.test(lower)) return 'captacao'
  return null
}

// Processa mensagem recebida pelo Messenger
async function processMessengerMessage(senderId, text, senderName) {
  const sessionKey = `${FB_PREFIX}${senderId}`
  console.log(`[Messenger] Mensagem de ${senderId} (${senderName}): "${text}"`)

  const isNew = !(await getSession(sessionKey))
  const session = await getOrCreateSession(sessionKey)
  if (!session) return

  // Cria lead na planilha na primeira mensagem
  if (isNew) {
    const primeiroNome = senderName ? senderName.split(' ')[0] : ''
    await addLead({ phone: sessionKey, nome: primeiroNome, origem: 'Messenger' })
  }

  // Atualiza perfil
  const profile = session.profile || {}
  if (!profile.nome && senderName) profile.nome = senderName.split(' ')[0]
  const finalidade = detectFinalidadeMessenger(text)
  if (finalidade && !profile.finalidade) profile.finalidade = finalidade

  // Se já enviou o link do WhatsApp, ignora mensagens seguintes
  if (session.state === 'MESSENGER_ENCERRADO') {
    console.log(`[Messenger] Conversa encerrada — mensagem ignorada para ${senderId}`)
    return
  }

  await addMessage(sessionKey, 'user', text)

  // Monta contexto e chama Claude
  const systemPrompt = buildMessengerPrompt({ ...session, profile, state: session.state || 'INICIAL' })

  let reply = ''
  let encerrar = false
  try {
    await sendTypingOn(senderId)
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }]
    })
    reply = response.content[0].text.trim()

    // Detecta se a resposta inclui o link do WhatsApp → encerra
    if (reply.includes('wa.me') || reply.includes('whatsapp') || reply.toLowerCase().includes('whatsapp')) {
      encerrar = true
    }
  } catch (err) {
    console.error('[Messenger] Erro Claude:', err.message)
    reply = 'Oi! Tive um probleminha aqui. Pode repetir?'
  }

  // Envia resposta
  await sendMessengerMessage(senderId, reply)
  await addMessage(sessionKey, 'assistant', reply)

  // Atualiza sessão
  const nextState = encerrar ? 'MESSENGER_ENCERRADO' : (session.state || 'INICIAL')
  await updateSession(sessionKey, { state: nextState, profile })

  // Atualiza planilha
  await updateLead(sessionKey, {
    nome: profile.nome,
    status: encerrar ? '🔵 Em Atendimento' : '🟡 Novo Lead',
    observacoes: buildObservacoes(profile, nextState),
    tipoContato: profile.finalidade === 'captacao' ? 'Proprietário' : 'Locatário'
  })

  console.log(`[Messenger] Resposta enviada | Estado: ${nextState}`)
}

module.exports = { processMessengerMessage }
