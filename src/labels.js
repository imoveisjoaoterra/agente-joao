require('dotenv').config()
const axios = require('axios')

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME

const headers = {
  'apikey': EVOLUTION_KEY,
  'Content-Type': 'application/json'
}

// Mapa de estado → ID da etiqueta no WhatsApp Business
const STATE_LABEL_MAP = {
  INICIAL:              '38', // Novo Lead
  AGUARDANDO_NOME:      '38', // Novo Lead
  TRIAGEM_LOCACAO:      '39', // Em atendimento
  TRIAGEM_COMPRA:       '39', // Em atendimento
  APRESENTACAO_LOCACAO: '39', // Em atendimento
  CAPTACAO:             '39', // Em atendimento
  INQUILINO:            '39', // Em atendimento
  PROPRIETARIO:         '39', // Em atendimento
  GARANTIA:             '39', // Em atendimento
  AGUARDANDO_CPF:       '39', // Em atendimento
  AGUARDANDO_JOAO:      '39', // Em atendimento
  NOTIFICA_JOAO:        '41', // Visita Agendada
  VISITA_AGENDADA:      '41', // Visita Agendada
  ENCERRADO:            '43', // Encerrado
  // Negócio Fechado — ID será preenchido quando sincronizar
  NEGOCIO_FECHADO:      null
}

// Busca etiquetas atuais do contato
async function getCurrentLabels(remoteJid) {
  try {
    const res = await axios.get(
      `${EVOLUTION_URL}/label/findLabels/${INSTANCE}`,
      { headers }
    )
    return res.data || []
  } catch (err) {
    console.error('[Labels] Erro ao buscar etiquetas:', err.message)
    return []
  }
}

// Remove todas as etiquetas de fluxo do contato e aplica a nova
async function applyLabel(phone, state) {
  const newLabelId = STATE_LABEL_MAP[state]
  if (!newLabelId) return // etiqueta não mapeada ainda

  const remoteJid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`

  // IDs de todas as etiquetas de fluxo (para remover antes de aplicar nova)
  const flowLabelIds = Object.values(STATE_LABEL_MAP).filter(id => id !== null)

  try {
    // Remove etiquetas de fluxo existentes
    for (const labelId of [...new Set(flowLabelIds)]) {
      if (labelId === newLabelId) continue
      await axios.delete(
        `${EVOLUTION_URL}/label/handleLabel/${INSTANCE}`,
        {
          headers,
          data: { number: remoteJid, labelId }
        }
      ).catch(() => {}) // ignora erro se etiqueta não estava aplicada
    }

    // Aplica nova etiqueta
    await axios.post(
      `${EVOLUTION_URL}/label/handleLabel/${INSTANCE}`,
      { number: remoteJid, labelId: newLabelId },
      { headers }
    )

    console.log(`[Labels] Etiqueta aplicada: estado ${state} → label ${newLabelId} para ${phone}`)
  } catch (err) {
    console.error('[Labels] Erro ao aplicar etiqueta:', err.message)
    if (err.response) {
      console.error('[Labels] Detalhes:', JSON.stringify(err.response.data))
    }
  }
}

module.exports = { applyLabel }
