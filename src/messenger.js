require('dotenv').config()
const axios = require('axios')

const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN
const GRAPH_URL = 'https://graph.facebook.com/v19.0/me/messages'

// Envia mensagem de texto via Messenger (Graph API)
async function sendMessengerMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('[Messenger] MESSENGER_PAGE_ACCESS_TOKEN não configurado')
    return false
  }

  try {
    await axios.post(
      GRAPH_URL,
      {
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE'
      },
      {
        params: { access_token: PAGE_ACCESS_TOKEN },
        headers: { 'Content-Type': 'application/json' }
      }
    )
    console.log(`[Messenger] Mensagem enviada para ${recipientId}`)
    return true
  } catch (err) {
    console.error('[Messenger] Erro ao enviar mensagem:', err.message)
    if (err.response) {
      console.error('[Messenger] Detalhes:', JSON.stringify(err.response.data))
    }
    return false
  }
}

// Ativa o indicador de digitação (typing...)
async function sendTypingOn(recipientId) {
  try {
    await axios.post(
      GRAPH_URL,
      { recipient: { id: recipientId }, sender_action: 'typing_on' },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    )
  } catch (_) {}
}

module.exports = { sendMessengerMessage, sendTypingOn }
