require('dotenv').config()
const axios = require('axios')
const { OpenAI, toFile } = require('openai')

// Groq é compatível com a interface OpenAI — só muda baseURL e modelo
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
})

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME

// Baixa o áudio da Evolution API e transcreve via Groq Whisper (gratuito)
async function transcribeAudio(mediaKey) {
  try {
    // Baixa o arquivo de mídia da Evolution API em base64
    const mediaResponse = await axios.post(
      `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${INSTANCE}`,
      { message: { key: mediaKey } },
      { headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' } }
    )

    const base64 = mediaResponse.data?.base64
    if (!base64) {
      console.error('[Transcribe] Base64 não encontrado na resposta')
      return null
    }

    // Converte base64 para buffer compatível com Node 18
    const buffer = Buffer.from(base64, 'base64')
    const audioFile = await toFile(buffer, 'audio.ogg', { type: 'audio/ogg' })

    // Transcreve com Groq Whisper — gratuito e rápido
    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      language: 'pt'
    })

    console.log(`[Transcribe] Áudio transcrito: "${transcription.text}"`)
    return transcription.text

  } catch (err) {
    console.error('[Transcribe] Erro ao transcrever áudio:', err.message)
    if (err.response) {
      console.error('[Transcribe] Detalhes:', JSON.stringify(err.response.data))
    }
    return null
  }
}

module.exports = { transcribeAudio }
