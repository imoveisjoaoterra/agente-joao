-- Schema do banco de dados — Agente João Terra Imóveis
-- Execute no SQL Editor do Supabase

-- Tabela de sessões de conversa
CREATE TABLE IF NOT EXISTS sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  state TEXT DEFAULT 'INICIAL' NOT NULL,
  profile JSONB DEFAULT '{}' NOT NULL,
  messages JSONB DEFAULT '[]' NOT NULL,
  follow_up_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index para busca por telefone (mais comum)
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);

-- Index para busca por estado (útil para follow-ups em massa)
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);

-- Atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Habilita Row Level Security
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Permite acesso total via service key (usada pelo agente)
CREATE POLICY "Service role full access" ON sessions
  FOR ALL
  USING (true)
  WITH CHECK (true);
