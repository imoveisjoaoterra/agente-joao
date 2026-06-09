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

// Mapa de regiões de Londrina → bairros pertencentes à zona
// Usado para ampliar a busca além do nome exato da região
const BAIRROS_POR_ZONA = {
  'Centro': [
    'Centro', 'Centro Cívico', 'Vila Nova', 'Jardim Agari', 'Jardim Higienópolis',
    'Jardim Higienopolis', 'Bela Suíça', 'Bela Suica', 'Calçada', 'Calcada',
    'Vilas do Arvoredo', 'Vila Casoni', 'Palhano', 'Gleba Palhano'
  ],
  'Zona Norte': [
    'Zona Norte', 'Cafezal', 'Jardim Cafezal', 'Heimtal', 'Cinco Conjuntos',
    'Lindóia', 'Lindoia', 'Conjunto Vivi Xavier', 'Jardim do Sol',
    'Jardim Piza', 'Parigot de Souza', 'Ana Botelho', 'Ernani Moura Lima',
    'Colinas', 'Jardim Colinas', 'Novo Bandeirantes', 'Bandeirantes',
    'Interlagos', 'Jardim Interlagos', 'Igapó', 'Igapo', 'União da Vitória',
    'Uniao da Vitoria', 'Antonio Zanello', 'São Luiz', 'Sao Luiz',
    'Pacaembu', 'Jardim Pacaembu'
  ],
  'Zona Sul': [
    'Zona Sul', 'Gleba Palhano', 'Palhano', 'Alto da Boa Vista',
    'Royal Park', 'Catuaí', 'Catuai', 'Jardim do Pão', 'Jardim do Pao',
    'Antares', 'Conjunto Habitacional', 'Patrimônio', 'Patrimonio',
    'Vale do Sol', 'Jardim Petrópolis', 'Jardim Petropolis',
    'Tucanos', 'Jardim Tucanos', 'Caminhos do Sol', 'Portal do Sol',
    'Morumbi', 'Jardim Morumbi', 'Lerroville', 'Espírito Santo', 'Espirito Santo'
  ],
  'Zona Leste': [
    'Zona Leste', 'Jardim Shangri-Lá', 'Shangri-La', 'Shangri La',
    'Jardim Shangri La', 'Universitário', 'Universitario', 'Hipica',
    'Hípica', 'Vivi Xavier', 'Conjunto Vivi Xavier', 'Jd. Pinheiros',
    'Jardim Pinheiros', 'Arapongas', 'Centenário', 'Centenario',
    'São Lourenço', 'Sao Lourenco', 'Warta', 'Espírito Santo', 'Espirito Santo'
  ],
  'Zona Oeste': [
    'Zona Oeste', 'Jardim Los Angeles', 'Los Angeles', 'Ouro Verde',
    'Jardim Ouro Verde', 'Piza', 'Jardim Piza', 'União da Vitória',
    'Armando Storani', 'São Jorge', 'Sao Jorge', 'Monte Belo',
    'Jardim Monte Belo', 'Maracanã', 'Maracana', 'Jardim Esperança',
    'Jardim Esperanca', 'Santa Fé', 'Santa Fe'
  ]
}

// Monta filtro OR de bairros para uma zona
function buildRegiaoFilter(regiao) {
  // Tenta match exato na zona primeiro
  const bairros = Object.entries(BAIRROS_POR_ZONA).find(
    ([zona]) => zona.toLowerCase() === regiao.toLowerCase() ||
                zona.toLowerCase().includes(regiao.toLowerCase()) ||
                regiao.toLowerCase().includes(zona.toLowerCase().replace('zona ', ''))
  )
  if (bairros) {
    return bairros[1].map(b => `neighborhood_name.ilike.%${b}%`).join(',')
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

  // Região: busca por todos os bairros da zona (não só nome exato)
  if (regiao) {
    const regiaoFilter = buildRegiaoFilter(regiao)
    query = query.or(regiaoFilter)
  }

  // Orçamento: aceita até 30% acima do valor informado pelo cliente
  if (orcamento) {
    const maxPrice = Math.round(Number(orcamento) * 1.3)
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
  getSession,
  createSession,
  updateSession,
  addMessage,
  getOrCreateSession,
  searchImoveis
}
