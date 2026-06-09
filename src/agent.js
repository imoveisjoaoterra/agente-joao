require('dotenv').config()
const Anthropic = require('@anthropic-ai/sdk')
const { buildContextPrompt } = require('../prompts/system-prompt')
const { getOrCreateSession, updateSession, addMessage, searchImoveis } = require('./supabase')
const { sendWhatsAppMessage, notifyJoao } = require('./evolution')
const { addLead, updateLead, stateToStatus } = require('./sheets')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Estados do fluxo
const STATES = {
  // Abertura
  INICIAL: 'INICIAL',
  AGUARDANDO_NOME: 'AGUARDANDO_NOME',

  // Fluxos omnichannel
  INQUILINO: 'INQUILINO',
  PROPRIETARIO: 'PROPRIETARIO',
  CAPTACAO: 'CAPTACAO',

  // Fluxo locação
  TRIAGEM_LOCACAO: 'TRIAGEM_LOCACAO',
  APRESENTACAO_LOCACAO: 'APRESENTACAO_LOCACAO',
  GARANTIA: 'GARANTIA',
  AGUARDANDO_CPF: 'AGUARDANDO_CPF',
  NOTIFICA_JOAO: 'NOTIFICA_JOAO',
  CPF_APROVADO: 'CPF_APROVADO',
  CPF_REPROVADO: 'CPF_REPROVADO',

  // Fluxo compra
  TRIAGEM_COMPRA: 'TRIAGEM_COMPRA',
  INTERESSE_COMPRA: 'INTERESSE_COMPRA',

  AGUARDANDO_JOAO: 'AGUARDANDO_JOAO',
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

// Detecta fluxo pelo conteúdo da mensagem
function detectFlow(text) {
  const lower = text.toLowerCase()

  // Inquilino — menção a boleto, manutenção, conserto, rescisão, desocupação
  if (/boleto|2[aª] via|segunda via|vencimento|manutenção|manutencao|conserto|vazamento|infiltração|infiltracao|rescisão|rescisao|desocup|sair do imóvel|entregar o imóvel/.test(lower)) {
    return STATES.INQUILINO
  }

  // Proprietário — repasse, administração do imóvel que possui
  if (/repasse|quando (vou |eu )?(receber|cai|cair)|dia do pagamento|meu imóvel|minha casa|meu apartamento/.test(lower)) {
    return STATES.PROPRIETARIO
  }

  // Captação — quer deixar imóvel pra alugar
  if (/(quero |tenho um |tenho uma ).*(alugar|locar|colocar pra alugar|disponível pra|disponivel pra)|captar|administr.*imóvel|imóvel.*administr/.test(lower)) {
    return STATES.CAPTACAO
  }

  // Compra
  if (/comprar|compra|à venda|a venda|financiar|financiamento|adquirir/.test(lower)) {
    return STATES.TRIAGEM_COMPRA
  }

  // Locação
  if (/alugar|aluguel|locar|locação|locacao|quero (um |uma )?(casa|apê|apto|apartamento|kitnet)/.test(lower)) {
    return STATES.TRIAGEM_LOCACAO
  }

  return null
}

// Detecta próximo estado com base na mensagem e estado atual
function detectNextState(text, currentState, profile) {
  const lower = text.toLowerCase()

  // Abertura — aguardando nome
  if (currentState === STATES.INICIAL) {
    return STATES.AGUARDANDO_NOME
  }

  // Após nome, tenta detectar fluxo já na mesma mensagem
  if (currentState === STATES.AGUARDANDO_NOME) {
    const flow = detectFlow(text)
    if (flow) return flow
    return STATES.AGUARDANDO_NOME
  }

  // Tenta detectar fluxo em qualquer estado neutro
  if (currentState === STATES.AGUARDANDO_NOME) {
    const flow = detectFlow(text)
    return flow || STATES.AGUARDANDO_NOME
  }

  // Triagem locação → apresentação quando tiver perfil completo
  if (currentState === STATES.TRIAGEM_LOCACAO) {
    const { regiao, tipo, quartos, orcamento } = profile
    if (regiao && tipo && quartos && orcamento) return STATES.APRESENTACAO_LOCACAO
    return STATES.TRIAGEM_LOCACAO
  }

  // Apresentação locação → garantia ou compra
  if (currentState === STATES.APRESENTACAO_LOCACAO) {
    const showsInterest = /gostei|interesse|quero|esse|visitar|ver/.test(lower)
    if (showsInterest) {
      return profile.finalidade === 'venda' ? STATES.INTERESSE_COMPRA : STATES.GARANTIA
    }
  }

  // Garantia → aguardando CPF
  if (currentState === STATES.GARANTIA) {
    if (extractCPF(text)) return STATES.AGUARDANDO_CPF
    return STATES.GARANTIA
  }

  // CPF recebido → notifica João
  if (currentState === STATES.AGUARDANDO_CPF) {
    if (extractCPF(text)) return STATES.NOTIFICA_JOAO
  }

  // Tenta detectar mudança de fluxo em qualquer ponto
  const flow = detectFlow(text)
  if (flow && flow !== currentState) return flow

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
  const isNewSession = !(await getSession(phone))
  const session = await getOrCreateSession(phone)
  if (!session) {
    console.error('[Agente] Não foi possível criar/buscar sessão')
    return null
  }

  // Novo lead — cria linha na planilha
  if (isNewSession) {
    await addLead({ phone, nome: '', origem: 'WhatsApp' })
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

  // Se sessão está aguardando João, ignora mensagem do cliente
  if (session.state === STATES.AGUARDANDO_JOAO) {
    console.log(`[Agente] Sessão ${phone} aguardando João — mensagem ignorada`)
    return null
  }

  // Chama o Claude
  let agentResponse = ''
  let needsJoao = false
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: contextualPrompt + `\n\nSe não tiver informação suficiente para responder com precisão, responda EXATAMENTE com o texto: [AGUARDANDO_JOAO] seguido da mensagem pro cliente (ex: "[AGUARDANDO_JOAO] Deixa eu verificar aqui pra você. Só um momento! 😊"). Não use essa marcação em situações normais — só quando genuinamente precisar de uma informação que não tem.`,
      messages: [{ role: 'user', content: userMessage }]
    })
    const raw = response.content[0].text
    if (raw.startsWith('[AGUARDANDO_JOAO]')) {
      needsJoao = true
      agentResponse = raw.replace('[AGUARDANDO_JOAO]', '').trim()
    } else {
      agentResponse = raw
    }
  } catch (err) {
    console.error('[Agente] Erro na API Claude:', err.message)
    agentResponse = 'Oi! Tive um problema aqui. Pode repetir sua mensagem?'
  }

  // Define estado final
  const finalState = needsJoao ? STATES.AGUARDANDO_JOAO : nextState

  // Atualiza sessão
  await updateSession(phone, {
    state: finalState,
    profile: updatedProfile
  })

  // Salva resposta do agente
  await addMessage(phone, 'assistant', agentResponse)

  // Envia resposta ao cliente
  await sendWhatsAppMessage(phone, agentResponse)

  // Notifica João se entrou em modo de espera
  if (needsJoao) {
    const nome = updatedProfile.nome || 'sem nome'
    const alertMsg = `⏸ #AGUARDANDO — ${nome} (${phone})\n\nPergunta: "${userMessage}"\n\nPerfil: ${JSON.stringify(updatedProfile, null, 2)}\n\nResponda com:\n/responder ${phone} [sua resposta]`
    await notifyJoao(alertMsg)
    console.log(`[Agente] Sessão pausada — João notificado para ${phone}`)
  }

  // Notifica João em outros casos críticos
  if (!needsJoao && (escalate || nextState === STATES.NOTIFICA_JOAO)) {
    const cpf = updatedProfile.cpf || extractCPF(userMessage)
    const alertMsg = cpf
      ? `#VISITA — ${phone} — CPF: ${cpf} — pré-aprovação pendente — perfil: ${JSON.stringify(updatedProfile)}`
      : `#URGENTE — ${phone} — ${userMessage} — estado: ${nextState}`

    await notifyJoao(alertMsg)
    console.log(`[Agente] João notificado: ${alertMsg}`)
  }

  // Atualiza planilha com dados do perfil e status atual
  await updateLead(phone, {
    nome: updatedProfile.nome,
    regiao: updatedProfile.regiao,
    tipo: updatedProfile.tipo,
    quartos: updatedProfile.quartos,
    orcamento: updatedProfile.orcamento ? `R$ ${updatedProfile.orcamento}` : undefined,
    cpf: updatedProfile.cpf ? (updatedProfile.cpfStatus || 'Aguardando') : undefined,
    status: stateToStatus(finalState),
    tipoContato: updatedProfile.finalidade === 'captacao' ? 'Proprietário' : 'Locatário'
  })

  console.log(`[Agente] Estado: ${session.state} → ${finalState} | Resposta enviada`)
  return agentResponse
}

module.exports = { processMessage, STATES }
