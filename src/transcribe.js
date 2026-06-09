require('dotenv').config()
const axios = require('axios')
const FormData = require('form-data')
const { OpenAI } = require('openai')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME

// Baixa o áudio da Evolution API e transcreve via Whisper
async function transcribeAudio(mediaKey) {
  try {
    // Baixa o arquivo de mídia da Evolution API
    const mediaResponse = await axios.get(
      `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${INSTANCE}`,
      {
        headers: { apikey: EVOLUTION_KEY, 'Content-Type': 'application/json' },
        data: { message: { key: mediaKey } }
      }
    )

    const base64 = mediaResponse.data?.base64
    if (!base64) {
      console.error('[Transcribe] Base64 não encontrado na resposta')
      return null
    }

    // Converte base64 para buffer
    const buffer = Buffer.from(base64, 'base64')

    // Monta FormData para Whisper
    const form = new FormData()
    form.append('file', buffer, { filename: 'audio.ogg', contentType: 'audio/ogg' })
    form.append('model', 'whisper-1')
    form.append('language', 'pt')

    const transcription = await openai.audio.transcriptions.create({
      file: new File([buffer], 'audio.ogg', { type: 'audio/ogg' }),
      model: 'whisper-1',
      language: 'pt'
    })

    console.log(`[Transcribe] Áudio transcrito: "${transcription.text}"`)
    return transcription.text

  } catch (err) {
    console.error('[Transcribe] Erro ao transcrever áudio:', err.message)
    return null
  }
}

module.exports = { transcribeAudio }
