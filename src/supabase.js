const { createClient } = require('@supabase/supabase-js')

// Criação lazy — garante que as variáveis já estão disponíveis
let _supabase = null
function getClient() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!url || !key) {
      throw new Error(`Supabase não configurado. URL: ${url ? 'ok' : 'FALTANDO'} | KEY: ${key ? 'ok' : 'FALTANDO'}`)
    }
    _supabase = createClient(url, key)
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

module.exports = {
  getSession,
  createSession,
  updateSession,
  addMessage,
  getOrCreateSession
}
