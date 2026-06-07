require('dotenv').config()
const Anthropic = require('@anthropic-ai/sdk')
const { buildContextPrompt } = require('../prompts/system-prompt')
const { getOrCreateSession, updateSession, addMessage, searchImoveis } = require('./supabase')
const { sendWhatsAppMessage, notifyJoao } = require('./evolution')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Estados do fluxo
const STATES = {
  INICIAL: 'INICIAL',
  TRIAGEM: 'TRIAGEM',
  FORA_PERFIL: 'FORA_PERFIL',
  APRESENTACAO: 'APRESENTACAO',
  // Estado próprio para quem quer COMPRAR — não passa por fiança/CPF
  // (esse fluxo é exclusivo de aluguel). Ver achado 1 do QA em
  // 06_OUTPUTS/2026-06-07_agente-imoveis-whatsapp/qa-revisao-fluxo-conversa.md
  INTERESSE_VENDA: 'INTERESSE_VENDA',
  GARANTIA: 'GARANTIA',
  AGUARDANDO_CPF: 'AGUARDANDO_CPF',
  NOTIFICA_JOAO: 'NOTIFICA_JOAO',
  CPF_APROVADO: 'CPF_APROVADO',
  CPF_REPROVADO: 'CPF_REPROVADO',
  VISITA_AGENDADA: 'VISITA_AGENDADA',
  ENCERRADO: 'ENCERRADO'
}

// Detecta se deve acionar João
function shouldEscalateToJoao(text, state) {
  // Gatilhos de alta intenção (ver achado 3 do QA — removidos 'quero ver' e
  // 'ver o imóvel' por se sobreporem a wantsToSeeProperties e gerarem
  // alerta em excesso para quem só está navegando opções)
  const triggers = [
    'visitar', 'visita', 'agendar',
    'falar com joão', 'falar com o joão', 'responsável', 'negociar',
    'desconto', 'reduzir', 'valor menor'
  ]
  const lower = text.toLowerCase()
  return triggers.some(t => lower.includes(t)) || state === STATES.NOTIFICA_JOAO
}

// Detecta CPF na mensagem
function extractCPF(text) {
  const cpfRegex = /\b\d{3}[\.\s-]?\d{3}[\.\s-]?\d{3}[\.\s-]?\d{2}\b/
  const match = text.match(cpfRegex)
  return match ? match[0].replace(/[\.\s-]/g, '') : null
}

// Detecta se o cliente quer ALUGAR ou COMPRAR — define qual ramo de
// conversa seguir (locação com fiança/CPF, ou venda com handoff direto)
function extractFinalidade(text, currentFinalidade) {
  if (currentFinalidade) return currentFinalidade
  const lower = text.toLowerCase()

  if (/\b(alugar|aluguel|locar|locação|loca[cç][aã]o)\b/.test(lower)) return 'aluguel'
  if (/\b(comprar|compra|à venda|a venda|vender|financiar|financiamento|adquirir)\b/.test(lower)) return 'venda'

  return null
}

// Detecta se o cliente está pedindo explicitamente para ver opções de imóveis
// (a busca só roda quando isso for verdade — decisão registrada em
// 07_LOGS/decisions.md, 2026-06-07)
function wantsToSeeProperties(text) {
  const lower = text.toLowerCase()
  const triggers = [
    'pode mandar', 'manda', 'mostra', 'tem algo', 'tem alguma', 'tem opç',
    'quero ver', 'pode ver', 'tem disponível', 'tem disponivel',
    'tem imóve', 'tem imove', 'opções disponíve', 'opcoes disponive',
    'me mostra', 'pode enviar', 'fotos'
  ]
  return triggers.some(t => lower.includes(t))
}

// Detecta próximo estado com base na mensagem e estado atual
function detectNextState(text, currentState, profile) {
  const lower = text.toLowerCase()

  if (currentState === STATES.INICIAL || currentState === STATES.TRIAGEM) {
    // Verifica se temos todas as informações de triagem
    const hasRegion = profile.regiao
    const hasTipo = profile.tipo
    const hasQuartos = profile.quartos
    const hasOrcamento = profile.orcamento

    if (hasRegion && hasTipo && hasQuartos && hasOrcamento) {
      return STATES.APRESENTACAO
    }
    return STATES.TRIAGEM
  }

  if (currentState === STATES.APRESENTACAO) {
    const showsInterest = lower.includes('gostei') || lower.includes('interesse') ||
        lower.includes('quero') || lower.includes('esse') ||
        lower.includes('visitar') || lower.includes('ver')

    if (showsInterest) {
      // Ramificação por finalidade: fiança/CPF é exclusivo de ALUGUEL.
      // Quem quer COMPRAR vai para um estado próprio, sem esse fluxo.
      return profile.finalidade === 'venda' ? STATES.INTERESSE_VENDA : STATES.GARANTIA
    }
  }

  if (currentState === STATES.GARANTIA) {
    const cpf = extractCPF(text)
    if (cpf) return STATES.AGUARDANDO_CPF
    return STATES.GARANTIA
  }

  if (currentState === STATES.AGUARDANDO_CPF) {
    const cpf = extractCPF(text)
    if (cpf) return STATES.NOTIFICA_JOAO
  }

  return currentState
}

// Extrai dados de perfil da mensagem
function extractProfileData(text, currentProfile) {
  const lower = text.toLowerCase()
  const updated = { ...currentProfile }

  // Tipo de imóvel (ampliado para cobrir todos os tipos do site: terreno e comercial)
  if (!updated.tipo) {
    if (lower.includes('casa') || lower.includes('sobrado')) updated.tipo = 'casa'
    else if (lower.includes('apartamento') || lower.includes('apto')) updated.tipo = 'apartamento'
    else if (lower.includes('kitnet') || lower.includes('studio') || lower.includes('estúdio')) updated.tipo = 'kitnet'
    else if (lower.includes('terreno') || lower.includes('lote')) updated.tipo = 'terreno'
    else if (lower.includes('comercial') || lower.includes('sala comercial') || lower.includes('loja') || lower.includes('galpão') || lower.includes('galpao') || lower.includes('ponto comercial')) updated.tipo = 'comercial'
  }

  // Finalidade (compra ou aluguel) — define o ramo de conversa
  const finalidade = extractFinalidade(text, currentProfile.finalidade)
  if (finalidade) updated.finalidade = finalidade

  // Quartos
  if (!updated.quartos) {
    const quartosMatch = text.match(/(\d)\s*(quarto|dormitório)/i)
    if (quartosMatch) updated.quartos = quartosMatch[1]
    else if (lower.includes('1 quarto') || lower.includes('um quarto')) updated.quartos = '1'
    else if (lower.includes('2 quartos') || lower.includes('dois quartos')) updated.quartos = '2'
    else if (lower.includes('3 quartos') || lower.includes('três quartos')) updated.quartos = '3'
  }

  // CPF
  const cpf = extractCPF(text)
  if (cpf) updated.cpf = cpf

  return updated
}

// Motor principal do agente
async function processMessage(phone, userMessage) {
  console.log(`[Agente] Processando mensagem de ${phone}: "${userMessage}"`)

  // Busca ou cria sessão
  const session = await getOrCreateSession(phone)
  if (!session) {
    console.error('[Agente] Não foi possível criar/buscar sessão')
    return null
  }

  // Extrai dados de perfil da mensagem
  const updatedProfile = extractProfileData(userMessage, session.profile || {})

  // Detecta próximo estado
  const nextState = detectNextState(userMessage, session.state, updatedProfile)

  // Salva mensagem do usuário
  await addMessage(phone, 'user', userMessage)

  // Verifica se deve acionar João
  const escalate = shouldEscalateToJoao(userMessage, nextState)

  // Busca imóveis SOMENTE quando o cliente pedir explicitamente
  // (decisão registrada em 07_LOGS/decisions.md, 2026-06-07 — evita
  // "empurrar" lista sem o cliente ter pedido)
  let imoveis
  if (wantsToSeeProperties(userMessage)) {
    imoveis = await searchImoveis({
      tipo: updatedProfile.tipo,
      quartos: updatedProfile.quartos,
      regiao: updatedProfile.regiao,
      orcamento: updatedProfile.orcamento,
      finalidade: updatedProfile.finalidade
    })
    console.log(`[Agente] Cliente pediu para ver imóveis — encontrados: ${imoveis.length}`)
  }

  // Monta contexto para o Claude
  const contextualPrompt = buildContextPrompt({
    ...session,
    state: nextState,
    profile: updatedProfile,
    messages: [...(session.messages || []), { role: 'user', content: userMessage }],
    imoveis
  })

  // Chama o Claude
  let agentResponse = ''
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: contextualPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
    agentResponse = response.content[0].text
  } catch (err) {
    console.error('[Agente] Erro na API Claude:', err.message)
    agentResponse = 'Oi! Tive um problema aqui. Pode repetir sua mensagem?'
  }

  // Atualiza sessão
  await updateSession(phone, {
    state: nextState,
    profile: updatedProfile
  })

  // Salva resposta do agente
  await addMessage(phone, 'assistant', agentResponse)

  // Envia resposta ao cliente
  await sendWhatsAppMessage(phone, agentResponse)

  // Notifica João se necessário
  if (escalate || nextState === STATES.NOTIFICA_JOAO) {
    const cpf = updatedProfile.cpf || extractCPF(userMessage)
    const alertMsg = cpf
      ? `#VISITA — ${phone} — CPF: ${cpf} — pré-aprovação pendente — perfil: ${JSON.stringify(updatedProfile)}`
      : `#URGENTE — ${phone} — ${userMessage} — estado: ${nextState}`

    await notifyJoao(alertMsg)
    console.log(`[Agente] João notificado: ${alertMsg}`)
  }

  console.log(`[Agente] Estado: ${session.state} → ${nextState} | Resposta enviada`)
  return agentResponse
}

module.exports = { processMessage, STATES }
