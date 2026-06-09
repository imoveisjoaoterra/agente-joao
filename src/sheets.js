require('dotenv').config()
const { google } = require('googleapis')

const SPREADSHEET_ID = '1VH5oNOM4zXqeEComqUpRV62ePxvTMW_n0zQ5Xgekxzk'
const SHEET_NAME = "'Triagem de Leads'"
const HEADER_ROWS = 4 // linhas 1-4 são cabeçalho — dados começam na linha 5

// Inicializa cliente Google Sheets via credencial da conta de serviço
function getClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS)
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })
  return google.sheets({ version: 'v4', auth })
}

// Busca a linha do cliente pelo telefone (coluna D = WhatsApp)
async function findRowByPhone(sheets, phone) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!D:D`
  })
  const rows = res.data.values || []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].replace(/\D/g, '').includes(phone.replace(/\D/g, ''))) {
      return i + 1 // linha no Sheets (1-based)
    }
  }
  return null
}

// Busca próxima linha vazia na coluna A
async function getNextRow(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:A`
  })
  const total = (res.data.values || []).length
  return Math.max(total + 1, HEADER_ROWS + 1)
}

// Cria ou atualiza lead (upsert por telefone)
// Se o telefone já existe na planilha, não cria nova linha — atualiza nome se estava vazio
async function addLead({ phone, nome, origem, tipo, finalidade }) {
  try {
    const sheets = getClient()

    // Verifica se telefone já tem linha
    const existingRow = await findRowByPhone(sheets, phone)
    if (existingRow) {
      // Já existe — atualiza nome se o campo estava vazio
      if (nome) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!B${existingRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[nome]] }
        })
        console.log(`[Sheets] Lead já existia na linha ${existingRow} — nome atualizado (${phone})`)
      } else {
        console.log(`[Sheets] Lead já existia na linha ${existingRow} — sem alteração (${phone})`)
      }
      return
    }

    // Não existe — cria nova linha
    const nextRow = await getNextRow(sheets)
    const hoje = new Date().toLocaleDateString('pt-BR')
    const tipoContato = finalidade === 'captacao' ? 'Proprietário' : 'Locatário'
    const statusInicial = '🟡 Novo Lead'

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${nextRow}:O${nextRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          nextRow - HEADER_ROWS, // #
          nome || '',            // Nome do Cliente
          origem || 'WhatsApp',  // Origem Lead
          phone,                 // WhatsApp
          hoje,                  // Data Entrada
          '',                    // Região / Bairro
          tipo || '',            // Tipo
          '',                    // Quartos
          '',                    // Orçamento
          '',                    // CPF
          statusInicial,         // Status Lead
          '',                    // Data Visita
          '',                    // Observações
          tipoContato,           // Tipo de Contato
          ''                     // Perfil Proprietário
        ]]
      }
    })

    console.log(`[Sheets] Novo lead criado: ${nome || phone} — linha ${nextRow}`)
  } catch (err) {
    console.error('[Sheets] Erro ao adicionar lead:', err.message)
  }
}

// Gera resumo automático da conversa para o campo Observações
function buildObservacoes(profile, state) {
  const partes = []

  // Finalidade
  if (profile.finalidade === 'venda') partes.push('Compra')
  else if (profile.finalidade === 'aluguel') partes.push('Locação')

  // Tipo + quartos
  if (profile.tipo && profile.quartos) {
    partes.push(`${profile.tipo} ${profile.quartos}q`)
  } else if (profile.tipo) {
    partes.push(profile.tipo)
  } else if (profile.quartos) {
    partes.push(`${profile.quartos} quartos`)
  }

  // Região
  if (profile.regiao) partes.push(profile.regiao)

  // Orçamento
  if (profile.orcamento) {
    const val = Number(profile.orcamento)
    if (val >= 1000) {
      partes.push(`até R$${(val / 1000).toLocaleString('pt-BR')}k`)
    } else {
      partes.push(`até R$${val.toLocaleString('pt-BR')}`)
    }
  }

  // CPF
  if (profile.cpf) partes.push('CPF recebido')

  // Estado
  const stateLabel = {
    TRIAGEM_LOCACAO: 'em triagem',
    TRIAGEM_COMPRA: 'em triagem',
    APRESENTACAO_LOCACAO: 'imóveis apresentados',
    GARANTIA: 'analisando garantia',
    AGUARDANDO_CPF: 'aguardando CPF',
    AGUARDANDO_JOAO: 'aguardando atendimento humano',
    VISITA_AGENDADA: 'visita agendada',
    NOTIFICA_JOAO: 'visita solicitada',
    CAPTACAO: 'captação',
    INQUILINO: 'inquilino',
    PROPRIETARIO: 'proprietário',
    ENCERRADO: 'encerrado'
  }
  if (stateLabel[state]) partes.push(stateLabel[state])

  return partes.length > 0 ? partes.join(' | ') : ''
}

// Atualiza campos de uma linha existente
async function updateLead(phone, updates) {
  try {
    const sheets = getClient()
    const row = await findRowByPhone(sheets, phone)
    if (!row) {
      console.warn(`[Sheets] Linha não encontrada para ${phone}`)
      return
    }

    const colMap = {
      nome: 'B', origem: 'C', regiao: 'F', tipo: 'G',
      quartos: 'H', orcamento: 'I', cpf: 'J',
      status: 'K', dataVisita: 'L', observacoes: 'M',
      tipoContato: 'N'
    }

    for (const [field, value] of Object.entries(updates)) {
      const col = colMap[field]
      if (!col || value === undefined || value === null || value === '') continue
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!${col}${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] }
      })
    }

    console.log(`[Sheets] Lead atualizado: ${phone} — linha ${row}`)
  } catch (err) {
    console.error('[Sheets] Erro ao atualizar lead:', err.message)
  }
}

// Mapeia estado do agente para status da planilha
function stateToStatus(state) {
  const map = {
    INICIAL: '🟡 Novo Lead',
    AGUARDANDO_NOME: '🟡 Novo Lead',
    TRIAGEM_LOCACAO: '🔵 Em Atendimento',
    TRIAGEM_COMPRA: '🔵 Em Atendimento',
    APRESENTACAO_LOCACAO: '🔵 Em Atendimento',
    CAPTACAO: '🔵 Em Atendimento',
    INQUILINO: '🔵 Em Atendimento',
    PROPRIETARIO: '🔵 Em Atendimento',
    GARANTIA: '🔵 Em Atendimento',
    AGUARDANDO_CPF: '🔵 Em Atendimento',
    NOTIFICA_JOAO: '🟢 Visita Agendada',
    AGUARDANDO_JOAO: '🔵 Em Atendimento',
    VISITA_AGENDADA: '🟢 Visita Agendada',
    ENCERRADO: '⚫ Encerrado'
  }
  return map[state] || '🔵 Em Atendimento'
}

module.exports = { addLead, updateLead, stateToStatus, buildObservacoes }
