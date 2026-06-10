const { createClient } = require('@supabase/supabase-js')
const ws = require('ws')

// Criação lazy — garante que as variáveis já estão disponíveis
let _supabase = null
function getClient() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!url || !key) {
      throw new Error(`Supabase não configurado. URL: ${url ? 'ok' : 'FALTANDO'} | KEY: ${key ? 'ok' : 'FALTANDO'}`)
    }
    _supabase = createClient(url, key, {
      global: { headers: {} },
      realtime: { transport: ws }
    })
  }
  return _supabase
}

// Busca sessão pelo número de telefone
async function getSession(phone) {
  const { data, error } = await getClient()
    .from('sessions')
    .select('*')
    .eq('phone', phone)
    .single()

  if (error && error.code !== 'PGRST116') {
    console.error('[Supabase] Erro ao buscar sessão:', error.message)
    return null
  }

  return data || null
}

// Cria nova sessão
async function createSession(phone) {
  const { data, error } = await getClient()
    .from('sessions')
    .insert({
      phone,
      state: 'INICIAL',
      profile: {},
      messages: [],
      follow_up_count: 0
    })
    .select()
    .single()

  if (error) {
    console.error('[Supabase] Erro ao criar sessão:', error.message)
    return null
  }

  console.log(`[Supabase] Nova sessão criada: ${phone}`)
  return data
}

// Atualiza sessão existente
async function updateSession(phone, updates) {
  const { data, error } = await getClient()
    .from('sessions')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('phone', phone)
    .select()
    .single()

  if (error) {
    console.error('[Supabase] Erro ao atualizar sessão:', error.message)
    return null
  }

  return data
}

// Adiciona mensagem ao histórico
async function addMessage(phone, role, content) {
  const session = await getSession(phone)
  if (!session) return null

  const messages = session.messages || []
  messages.push({
    role,
    content,
    timestamp: new Date().toISOString()
  })

  // Mantém apenas as últimas 20 mensagens para economizar contexto
  const trimmed = messages.slice(-20)

  return await updateSession(phone, { messages: trimmed })
}

// Busca ou cria sessão (helper principal)
async function getOrCreateSession(phone) {
  let session = await getSession(phone)
  if (!session) {
    session = await createSession(phone)
  }
  return session
}

// Mapa oficial de bairros de Londrina por zona (fornecido pelo operador)
const BAIRROS_POR_ZONA = {
  'Zona Norte': [
    'Maria Cecília', 'Vista Bela', 'Flores do Campo', 'Semíramis', 'Violin',
    'Aquiles Stenghel', 'Luiz de Sá', 'Parigot de Souza', 'Vivi Xavier',
    'João Paz', 'Milton Gavetti', 'Jardim dos Alpes', 'Jardim Pacaembu',
    'Jardim Coliseu', 'Heimtal', 'Ouro Verde', 'Cinco Conjuntos',
    'Conjunto Violim', 'Conjunto Cafezal Norte', 'Jardim Primavera',
    'Jardim Planalto', 'Jardim São Jorge', 'Parque Industrial Cacique',
    'Perobinha', 'São Tomaz', 'Residencial Horizonte', 'Residencial do Café',
    'Conjunto José Giordano'
  ],
  'Zona Sul': [
    'Gleba Palhano', 'Aurora', 'Terra Bonita', 'Bela Suíça', 'Jardim Tucanos',
    'Jardim Cafezal', 'Jardim Piza', 'Jardim Itatiaia', 'Colina Verde',
    'Guanabara', 'Vivendas do Arvoredo', 'Acapulco', 'Esperança',
    'Nova Esperança', 'Saltinho', 'União da Vitória', 'Parque das Indústrias',
    'Jardim Marissol', 'Jardim San Fernando', 'Jardim Montecatini',
    'Jardim Burle Marx', 'Royal Park', 'Alphaville', 'Sun Lake', 'Parque Tauá Sul'
  ],
  'Zona Leste': [
    'Jardim Morumbi', 'Jardim Interlagos', 'Jardim Antares', 'Jardim Ideal',
    'Jardim Califórnia', 'Jardim Brasília', 'Jardim Santa Fé', 'Jardim Marabá',
    'Pindorama', 'Vila Yara', 'Vila Santa Terezinha', 'Conjunto Ernani Moura Lima',
    'Aeroporto', 'Gleba Lindóia', 'Vila Fraternidade', 'Jardim São Vicente',
    'Jardim Santo André', 'Jardim do Sol', 'Parque das Indústrias Leves',
    'Residencial Abussafe', 'Jardim Oriental', 'Jardim Santa Rita'
  ],
  'Zona Oeste': [
    'Jardim Bandeirantes', 'Jardim Sabará', 'Jardim Jamaica', 'Jardim Leonor',
    'Jardim Olímpico', 'Jardim Presidente', 'Jardim Champagnat', 'Shangri-lá',
    'Parque Universidade', 'Jardim Columbia', 'Jardim Alvorada', 'Jardim Bancários',
    'Jardim Hedy', 'Jockey Club', 'Jardim Versalhes', 'Jardim Barcelona',
    'Jardim Monte Belo', 'Jardim Tocantins', 'Jardim Santiago', 'Cilo II Oeste',
    'Cilo III', 'Chácaras Esperança'
  ],
  'Centro': [
    'Centro', 'Centro Histórico', 'Vila Casoni', 'Vila Brasil', 'Vila Nova',
    'Vila Recreio', 'Vila Ipiranga', 'Jardim Higienópolis', 'Jardim Petrópolis',
    'Jardim Quebec', 'Jardim Shangri-lá A', 'Jardim América', 'Jardim Claudia',
    'Jardim Londrilar', 'Jardim Imperial', 'Jardim Agari', 'Campos Elíseos'
  ]
}

// Bairros de alto padrão — usado internamente para direcionar buscas
// quando orçamento é elevado. NUNCA mencionar "alto padrão" ou "região nobre" ao cliente.
const BAIRROS_ALTO_PADRAO = [
  'Gleba Palhano', 'Bela Suíça', 'Alphaville', 'Royal Golf Residence',
  'Sun Lake', 'Aurora', 'Terra Bonita', 'Jardim Tucanos', 'Colina Verde',
  'Jardim Mediterrâneo', 'Jardim Presidente', 'Champagnat',
  'Jardim Higienópolis', 'Jardim Quebec', 'Guanabara'
]

// Detecta a zona de um bairro específico
function detectarZona(bairro) {
  const b = bairro.toLowerCase()
  for (const [zona, bairros] of Object.entries(BAIRROS_POR_ZONA)) {
    if (bairros.some(item => item.toLowerCase() === b || b.includes(item.toLowerCase()) || item.toLowerCase().includes(b))) {
      return zona
    }
  }
  return null
}

// Monta filtro OR de bairros para uma zona
function buildRegiaoFilter(regiao) {
  // Normaliza abreviações comuns
  const norm = regiao.toLowerCase()
    .replace(/^zn$/, 'zona norte')
    .replace(/^zs$/, 'zona sul')
    .replace(/^zl$/, 'zona leste')
    .replace(/^zo$/, 'zona oeste')
    .replace(/^norte$/, 'zona norte')
    .replace(/^sul$/, 'zona sul')
    .replace(/^leste$/, 'zona leste')
    .replace(/^oeste$/, 'zona oeste')

  // Tenta match exato na zona
  const match = Object.entries(BAIRROS_POR_ZONA).find(
    ([zona]) => zona.toLowerCase() === norm ||
                zona.toLowerCase().includes(norm) ||
                norm.includes(zona.toLowerCase().replace('zona ', ''))
  )
  if (match) {
    return match[1].map(b => `neighborhood_name.ilike.%${b}%`).join(',')
  }

  // Verifica se é um bairro específico — detecta a zona e busca por ela
  const zona = detectarZona(regiao)
  if (zona) {
    return BAIRROS_POR_ZONA[zona].map(b => `neighborhood_name.ilike.%${b}%`).join(',')
  }

  // Fallback: busca pelo nome direto
  return `neighborhood_name.ilike.%${regiao}%`
}

// Busca imóveis disponíveis que combinam com o perfil do cliente
// (tabela "imoveis" — espelha os imóveis cadastrados no site joao-terra-site,
// sincronizados via scripts/add-property.mjs. Ver schema em
// 06_OUTPUTS/2026-06-07_agente-imoveis-whatsapp/schema-supabase-imoveis.sql)
async function searchImoveis({ tipo, quartos, regiao, orcamento, finalidade } = {}) {
  const purpose = finalidade === 'venda' ? 'venda' : 'aluguel'

  let query = getClient()
    .from('imoveis')
    .select('*')
    .eq('status', 'disponivel')
    .eq('purpose', purpose)
    .limit(5)

  if (tipo) query = query.eq('type', tipo)
  if (quartos) query = query.gte('bedrooms', Number(quartos))

  const orcamentoNum = orcamento ? Number(orcamento) : null

  // Região: busca por todos os bairros da zona (não só nome exato)
  if (regiao) {
    const regiaoFilter = buildRegiaoFilter(regiao)
    query = query.or(regiaoFilter)
  } else if (orcamentoNum) {
    // Sem região definida + orçamento alto → prioriza bairros de alto padrão
    const isAltoOrcamento = (purpose === 'venda' && orcamentoNum >= 800000) ||
                            (purpose === 'aluguel' && orcamentoNum >= 3000)
    if (isAltoOrcamento) {
      const altoPadraoFilter = BAIRROS_ALTO_PADRAO.map(b => `neighborhood_name.ilike.%${b}%`).join(',')
      query = query.or(altoPadraoFilter)
    }
  }

  // Orçamento: aceita até 30% acima do valor informado pelo cliente
  if (orcamentoNum) {
    const maxPrice = Math.round(orcamentoNum * 1.3)
    query = query.lte('price', maxPrice)
  }

  const { data, error } = await query

  if (error) {
    console.error('[Supabase] Erro ao buscar imóveis:', error.message)
    return []
  }

  return data || []
}

module.exports = {
  getClient,
  getSession,
  createSession,
  updateSession,
  addMessage,
  getOrCreateSession,
  searchImoveis
}
