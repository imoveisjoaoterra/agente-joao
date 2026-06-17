require('dotenv').config()
const Anthropic = require('@anthropic-ai/sdk')
const { buildContextPrompt } = require('../prompts/system-prompt')
const { getSession, getOrCreateSession, updateSession, addMessage, getClient } = require('./supabase')
const { searchImoveisLiveSite } = require('./scraper')
const { sendWhatsAppMessage, notifyJoao } = require('./evolution')
const { addLead, updateLead, stateToStatus, buildObservacoes } = require('./sheets')
const { applyLabel } = require('./labels')
const { getAvailableSlots, createVisitEvent, extractConfirmedDatetime } = require('./calendar')

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

// Detecta se deve acionar João (visita/agendar NÃO escalate — vão pro fluxo de calendário)
function shouldEscalateToJoao(text, state) {
  const triggers = [
    'falar com joão', 'falar com o joão', 'responsável', 'negociar',
    'desconto', 'reduzir', 'valor menor'
  ]
  const lower = text.toLowerCase()
  return triggers.some(t => lower.includes(t)) || state === STATES.NOTIFICA_JOAO
}

// Detecta intenção de agendar visita a imóvel
function wantsToScheduleVisit(text) {
  const lower = text.toLowerCase()
  return /\b(visitar|agendar|marcar|ver pessoalmente|quero ver|fazer uma visita|visita|quando posso ir|quando consigo ir)\b/.test(lower)
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
    'me mostra', 'pode enviar', 'fotos',
    'encontrou', 'achou', 'localizou', 'tem algum', 'algum disponível',
    'algum disponivel', 'ver opç', 'quais são', 'quais tem',
    'imóvel pra mim', 'imovel pra mim', 'tem pra mim'
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

  // Abertura — se já tem nome (contato salvo), pula direto para detecção de fluxo
  if (currentState === STATES.INICIAL) {
    if (profile.nome) {
      const flow = detectFlow(text)
      return flow || STATES.TRIAGEM_LOCACAO // nome já conhecido — não cai em AGUARDANDO_NOME
    }
    return STATES.AGUARDANDO_NOME
  }

  // Após saudação (sem nome ainda), tenta detectar fluxo na mesma mensagem
  if (currentState === STATES.AGUARDANDO_NOME) {
    const flow = detectFlow(text)
    if (flow) return flow
    return STATES.AGUARDANDO_NOME
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

// Extrai nome do cliente da mensagem (quando estado é AGUARDANDO_NOME)
function extractNome(text) {
  const trimmed = text.trim()
  // Padrões como "sou João", "me chamo Maria", "meu nome é Pedro"
  const patterns = [
    /(?:sou|me chamo|meu nome é|meu nome e|pode me chamar de)\s+([A-ZÀ-Ú][a-záàâãéèêíìîóòôõúùûç]+(?:\s+[A-ZÀ-Ú][a-záàâãéèêíìîóòôõúùûç]+)*)/i,
    /^([A-ZÀ-Ú][a-záàâãéèêíìîóòôõúùûç]+(?:\s+[A-ZÀ-Ú][a-záàâãéèêíìîóòôõúùûç]+){0,3})$/
  ]
  for (const pat of patterns) {
    const match = trimmed.match(pat)
    if (match) {
      const candidate = match[1].trim()
      // Descarta se parece uma frase (mais de 4 palavras ou começa com artigo)
      const words = candidate.split(' ')
      if (words.length <= 4 && !/^(o |a |os |as |de |da |do )/i.test(candidate)) {
        return candidate
      }
    }
  }
  return null
}

// Extrai orçamento da mensagem
function extractOrcamento(text) {
  const lower = text.toLowerCase()
  // "300mil", "300k", "R$ 1.200", "1200 reais", "até 800", etc.
  const patterns = [
    /r\$\s*([\d.,]+)\s*(?:mil)?/i,
    /([\d.,]+)\s*mil(?:\s*reais)?/i,
    /([\d.,]+)\s*k\b/i,
    /até\s*([\d.,]+)/i,
    /em torno de\s*([\d.,]+)/i,
    /([\d.]+)\s*reais/i
  ]
  for (const pat of patterns) {
    const match = text.match(pat)
    if (match) {
      let val = match[1].replace(/\./g, '').replace(',', '.')
      const num = parseFloat(val)
      if (!isNaN(num)) {
        // Normaliza: "1200" provavelmente é 1200 (aluguel), "300" com "mil" é 300000
        if (lower.includes('mil') || lower.includes('k')) return String(num * 1000)
        return String(num)
      }
    }
  }
  return null
}

// Extrai região/bairro da mensagem
function extractRegiao(text) {
  const lower = text.toLowerCase()
  const regioes = [
    { pattern: /\b(zn|zona norte|norte)\b/, value: 'Zona Norte' },
    { pattern: /\b(zs|zona sul|sul)\b/, value: 'Zona Sul' },
    { pattern: /\b(zl|zona leste|leste)\b/, value: 'Zona Leste' },
    { pattern: /\b(zo|zona oeste|oeste)\b/, value: 'Zona Oeste' },
    { pattern: /\b(centro)\b/, value: 'Centro' },
    { pattern: /\b(gleba palhano|palhano)\b/, value: 'Zona Sul' },
    { pattern: /\b(catuaí|catuai)\b/, value: 'Zona Sul' },
    { pattern: /\b(cafezal)\b/, value: 'Zona Norte' },
    { pattern: /\b(heimtal)\b/, value: 'Zona Norte' },
    { pattern: /\b(lindóia|lindoia)\b/, value: 'Zona Norte' },
    { pattern: /\b(cinco conjuntos)\b/, value: 'Zona Norte' },
  ]
  for (const r of regioes) {
    if (r.pattern.test(lower)) return r.value
  }
  return null
}

// Extrai dados de perfil da mensagem
function extractProfileData(text, currentProfile, currentState) {
  const lower = text.toLowerCase()
  const updated = { ...currentProfile }

  // Nome — captura quando estiver aguardando nome
  if (!updated.nome && currentState === STATES.AGUARDANDO_NOME) {
    const nome = extractNome(text)
    if (nome) updated.nome = nome
  }

  // Tipo de imóvel (ampliado para cobrir todos os tipos do site: terreno e comercial)
  if (!updated.tipo) {
    if (lower.includes('casa') || lower.includes('sobrado')) updated.tipo = 'casa'
    else if (lower.includes('apartamento') || lower.includes('apto') || lower.includes('apê') || lower.includes('ape')) updated.tipo = 'apartamento'
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
    else if (lower.includes('3 quartos') || lower.includes('três quartos') || lower.includes('tres quartos')) updated.quartos = '3'
    else if (lower.includes('4 quartos') || lower.includes('quatro quartos')) updated.quartos = '4'
  }

  // Região — extrai de abreviações e nomes de bairros/zonas
  if (!updated.regiao) {
    const regiao = extractRegiao(text)
    if (regiao) updated.regiao = regiao
  }

  // Orçamento
  if (!updated.orcamento) {
    const orcamento = extractOrcamento(text)
    if (orcamento) updated.orcamento = orcamento
  }

  // CPF
  const cpf = extractCPF(text)
  if (cpf) updated.cpf = cpf

  return updated
}

// Verifica se o agente está pausado globalmente (tabela config no Supabase)
async function isAgentPausedGlobally() {
  try {
    const sb = getClient()
    const { data } = await sb.from('config').select('value').eq('key', 'agent_paused').single()
    return data?.value === 'true'
  } catch (_) {
    return false
  }
}

// Motor principal do agente
async function processMessage(phone, userMessage, pushName, isAgendaContact = false) {
  console.log(`[Agente] Processando mensagem de ${phone}: "${userMessage}"`)

  // Verifica pausa global
  if (await isAgentPausedGlobally()) {
    console.log(`[Agente] Pausado globalmente — mensagem de ${phone} ignorada`)
    return null
  }

  // Busca ou cria sessão
  const isNewSession = !(await getSession(phone))
  const session = await getOrCreateSession(phone)
  if (!session) {
    console.error('[Agente] Não foi possível criar/buscar sessão')
    return null
  }

  // Novo lead — cria linha na planilha (com nome se já vier na 1ª mensagem ou do pushName)
  if (isNewSession) {
    const nomeInicial = extractNome(userMessage) || pushName || ''
    await addLead({ phone, nome: nomeInicial, origem: 'WhatsApp' })
  }

  // Extrai dados de perfil da mensagem (passa estado atual para captura de nome)
  let updatedProfile = extractProfileData(userMessage, session.profile || {}, session.state)

  // Captura primeiro nome do pushName do WhatsApp se ainda não tiver nome no perfil
  // pushName = nome salvo nos contatos de João (contato salvo) ou nome do WhatsApp do cliente
  if (!updatedProfile.nome && pushName) {
    updatedProfile.nome = pushName.trim().split(' ')[0] // só o primeiro nome
  }

  // Detecta próximo estado — se já tem nome (pushName), pula AGUARDANDO_NOME
  const nextState = detectNextState(userMessage, session.state, updatedProfile)

  // Salva mensagem do usuário
  await addMessage(phone, 'user', userMessage)

  // Verifica se deve acionar João
  const escalate = shouldEscalateToJoao(userMessage, nextState)

  // CPF recebido → notifica João mas NÃO bloqueia o agente
  const cpfRecebido = updatedProfile.cpf && !session.profile?.cpf
  if (cpfRecebido) {
    await notifyJoao(`#CPF — ${updatedProfile.nome || phone} (${phone}) — CPF: ${updatedProfile.cpf}`)
    console.log(`[Agente] CPF recebido de ${phone} — João notificado (sem bloquear)`)
  }

  // Fluxo de agendamento de visita via Google Calendar
  let calendarSlotsText = ''
  let confirmingVisit = false

  if (wantsToScheduleVisit(userMessage) && session.state !== STATES.VISITA_AGENDADA) {
    // Cliente quer agendar — busca slots disponíveis
    console.log(`[Agente] Intenção de visita detectada — buscando slots na agenda...`)
    const slots = await getAvailableSlots()
    if (slots.length >= 2) {
      updatedProfile.calendar_slots_pending = slots.map(s => ({ date: s.date.toISOString(), label: s.label }))
      calendarSlotsText = `\n\n[AGENDA DISPONÍVEL — injete esses horários na resposta, apresente como duas opções, não mencione calendário ou sistema]:\nOpção 1: ${slots[0].label}\nOpção 2: ${slots[1].label}\nPergunta ao cliente: qual desses horários fica melhor pra você?`
    } else if (slots.length === 1) {
      updatedProfile.calendar_slots_pending = slots.map(s => ({ date: s.date.toISOString(), label: s.label }))
      calendarSlotsText = `\n\n[AGENDA DISPONÍVEL — apenas 1 slot livre nos próximos dias]:\nOpção: ${slots[0].label}\nPergunte se esse horário serve.`
    } else {
      calendarSlotsText = `\n\n[SEM SLOTS DISPONÍVEIS — diga que vai verificar a agenda e retorna em breve. NÃO use [AGUARDANDO_JOAO].]`
    }
  } else if (session.profile?.calendar_slots_pending?.length) {
    // Cliente pode estar confirmando um horário já sugerido
    const pendingSlots = session.profile.calendar_slots_pending.map(s => ({ date: new Date(s.date), label: s.label }))
    const confirmedDate = extractConfirmedDatetime(userMessage, pendingSlots)
    if (confirmedDate) {
      confirmingVisit = true
      const imovelNome = updatedProfile.imovel_interesse || 'imóvel de interesse'
      const result = await createVisitEvent({
        nome: updatedProfile.nome || '',
        phone,
        imovel: imovelNome,
        datetime: confirmedDate
      })
      if (result.ok) {
        await notifyJoao(`#VISITA AGENDADA — ${updatedProfile.nome || phone} (${phone})\nHorário: ${result.label}\nImóvel: ${imovelNome}`)
        updatedProfile.calendar_slots_pending = null
        updatedProfile.visita_agendada = result.label
        calendarSlotsText = `\n\n[VISITA CONFIRMADA — evento criado na agenda para ${result.label}. Confirme ao cliente de forma natural, sem mencionar agenda/sistema. Diga que está marcado.]`
        console.log(`[Agente] Visita criada na agenda para ${phone}: ${result.label}`)
      } else {
        calendarSlotsText = `\n\n[ERRO AO CRIAR EVENTO — diga que vai confirmar e retorna em breve. NÃO use [AGUARDANDO_JOAO].]`
      }
    }
  }

  // Busca imóveis SOMENTE quando o cliente pedir explicitamente
  let imoveis
  if (wantsToSeeProperties(userMessage)) {
    imoveis = await searchImoveisLiveSite({
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
    state: confirmingVisit ? STATES.VISITA_AGENDADA : nextState,
    profile: updatedProfile,
    messages: [...(session.messages || []), { role: 'user', content: userMessage }],
    imoveis,
    isAgendaContact
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
      system: contextualPrompt + calendarSlotsText + `\n\nREGRAS ABSOLUTAS — SIGA EXATAMENTE:\n1. Se não houver imóveis na lista do contexto (lista vazia ou ausente), comece a resposta EXATAMENTE com [AGUARDANDO_JOAO]. Ex: "[AGUARDANDO_JOAO] Vou verificar aqui e te retorno em breve."\n2. Use [AGUARDANDO_JOAO] SOMENTE para dúvidas jurídicas, contratuais, situações completamente fora do roteiro ou negociação de valores. Para visitas, CPF e perguntas comuns: responda normalmente.\n3. NUNCA mencione imóveis que não estão na lista fornecida. NUNCA invente links.\n4. NUNCA use o nome do cliente, NUNCA use o nome "João" em nenhuma mensagem. Nunca mencione que vai "passar para alguém" ou "chamar alguém". Você é o atendimento — fale sempre em primeira pessoa.\n5. Respostas máximo 2 frases curtas. Sem emojis. Sem desculpas.\n6. O marcador [AGUARDANDO_JOAO] deve ser SEMPRE o início da resposta, nunca no meio ou no fim.`,
      messages: [{ role: 'user', content: userMessage }]
    })
    const raw = response.content[0].text
    if (raw.includes('[AGUARDANDO_JOAO]')) {
      needsJoao = true
      agentResponse = raw.replace(/\[AGUARDANDO_JOAO\]/g, '').trim()
    } else {
      agentResponse = raw
    }
  } catch (err) {
    console.error('[Agente] Erro na API Claude:', err.message)
    agentResponse = 'Oi! Tive um problema aqui. Pode repetir sua mensagem?'
  }

  // Define estado final
  let finalState = needsJoao ? STATES.AGUARDANDO_JOAO : nextState
  if (confirmingVisit && !needsJoao) finalState = STATES.VISITA_AGENDADA

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

  // Notifica João em outros casos de escalação (negociação, pedido de responsável)
  if (!needsJoao && escalate) {
    await notifyJoao(`#URGENTE — ${updatedProfile.nome || phone} (${phone})\n${userMessage}`)
    console.log(`[Agente] João notificado: escalação detectada para ${phone}`)
  }

  // Aplica etiqueta no WhatsApp Business conforme estado
  await applyLabel(phone, finalState)

  // Atualiza planilha com dados do perfil, status e resumo da conversa
  await updateLead(phone, {
    nome: updatedProfile.nome,
    regiao: updatedProfile.regiao,
    tipo: updatedProfile.tipo,
    quartos: updatedProfile.quartos,
    orcamento: updatedProfile.orcamento ? `R$ ${Number(updatedProfile.orcamento).toLocaleString('pt-BR')}` : undefined,
    cpf: updatedProfile.cpf ? (updatedProfile.cpfStatus || 'Aguardando') : undefined,
    status: stateToStatus(finalState),
    tipoContato: updatedProfile.finalidade === 'captacao' ? 'Proprietário' : 'Locatário',
    observacoes: buildObservacoes(updatedProfile, finalState)
  })

  console.log(`[Agente] Estado: ${session.state} → ${finalState} | Resposta enviada`)
  return agentResponse
}

module.exports = { processMessage, STATES }
