require('dotenv').config()
const { google } = require('googleapis')

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary'
const BUSINESS_START = 9   // 9h
const BUSINESS_END   = 18  // 18h
const SLOT_DURATION  = 60  // minutos

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS)
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  })
}

// Retorna "agora" no fuso de Brasília como objeto Date com horas corretas
function nowBrasilia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
}

// Converte data em fuso Brasília para ISO UTC (para enviar à API do Google)
function brasiliaToUTC(date) {
  // Brasília é UTC-3
  return new Date(date.getTime() + 3 * 3600000)
}

// Próximos N dias úteis (seg-sex) a partir de amanhã, no fuso de Brasília
function nextBusinessDays(n = 3) {
  const days = []
  const d = nowBrasilia()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 1) // começa amanhã
  while (days.length < n) {
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) days.push(new Date(d))
    d.setDate(d.getDate() + 1)
  }
  return days
}

// Formata data/hora em pt-BR legível: "sexta-feira, 20/06 às 10h"
function formatSlot(date) {
  const dias = ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado']
  const dia = dias[date.getDay()]
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${dia}, ${dd}/${mm} às ${hh}h${min === '00' ? '' : min}`
}

// Busca slots livres e retorna 2 sugestões: 1 manhã (9-12h) + 1 tarde (13-18h)
async function getAvailableSlots() {
  try {
    const auth = getAuth()
    const calendar = google.calendar({ version: 'v3', auth })

    const days = nextBusinessDays(3)
    // Converte meia-noite de Brasília para UTC para a query da API
    const timeMin = brasiliaToUTC(days[0]).toISOString()
    const timeMax = brasiliaToUTC(new Date(days[days.length - 1].getTime() + 86400000)).toISOString()

    // Busca eventos já agendados no período
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    })
    const events = res.data.items || []

    // Para cada dia, testa slots de 1h e verifica conflito
    const morningSlot = null
    const afternoonSlot = null
    const suggestions = []

    for (const day of days) {
      if (suggestions.length >= 2) break

      for (const startHour of [9, 10, 11, 14, 15, 16, 17]) {
        if (suggestions.length >= 2) break
        const isMorning = startHour < 12
        // Já temos sugestão desse turno?
        if (isMorning && suggestions.some(s => s.getHours() < 12)) continue
        if (!isMorning && suggestions.some(s => s.getHours() >= 12)) continue

        // slot em Brasília, convertido para UTC para comparar com eventos da API
        const slotBrasilia = new Date(day)
        slotBrasilia.setHours(startHour, 0, 0, 0)
        const slotStart = brasiliaToUTC(slotBrasilia)
        const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION * 60000)

        // Verifica conflito com eventos já agendados
        const busy = events.some(ev => {
          const evStart = new Date(ev.start?.dateTime || ev.start?.date)
          const evEnd = new Date(ev.end?.dateTime || ev.end?.date)
          return slotStart < evEnd && slotEnd > evStart
        })

        if (!busy) suggestions.push(slotBrasilia) // guarda em Brasília para formatação
      }
    }

    return suggestions.map(s => ({ date: s, label: formatSlot(s) }))
  } catch (err) {
    console.error('[Calendar] Erro ao buscar slots:', err.message)
    return []
  }
}

// Cria evento de visita na agenda
async function createVisitEvent({ nome, phone, imovel, datetime }) {
  try {
    const auth = getAuth()
    const calendar = google.calendar({ version: 'v3', auth })

    // datetime vem em representação "Brasília como UTC" — converte para UTC real
    const startUTC = brasiliaToUTC(new Date(datetime))
    const endUTC = new Date(startUTC.getTime() + SLOT_DURATION * 60000)

    const event = {
      summary: `Visita — ${nome || phone}`,
      description: `Cliente: ${nome || 'não informado'}\nWhatsApp: ${phone}\nImóvel: ${imovel || 'a confirmar'}`,
      start: { dateTime: startUTC.toISOString(), timeZone: 'America/Sao_Paulo' },
      end:   { dateTime: endUTC.toISOString(),   timeZone: 'America/Sao_Paulo' }
    }

    const res = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event })
    console.log(`[Calendar] Evento criado: ${res.data.id} — ${formatSlot(start)}`)
    return { ok: true, label: formatSlot(start), eventId: res.data.id }
  } catch (err) {
    console.error('[Calendar] Erro ao criar evento:', err.message)
    return { ok: false }
  }
}

// Detecta se o texto contém confirmação de horário (ex: "às 9h", "14h30", "segunda às 10")
function extractConfirmedDatetime(text, slots) {
  if (!slots || slots.length === 0) return null
  const lower = text.toLowerCase()

  // Verifica se o cliente escolheu "primeira", "primeira opção", "manhã", "tarde"
  if (/primeira|opção 1|opção um|manhã/.test(lower) && slots[0]) return slots[0].date
  if (/segunda|opção 2|opção dois|tarde/.test(lower) && slots[1]) return slots[1].date

  // Tenta match de hora numérica: 9h, 9:00, 14h, 14:30
  const hourMatch = text.match(/\b(\d{1,2})[h:](\d{2})?\b/)
  if (!hourMatch) return null
  const hour = parseInt(hourMatch[1])
  const min = parseInt(hourMatch[2] || '0')

  // Verifica se o horário corresponde a um dos slots sugeridos
  for (const slot of slots) {
    if (slot.date.getHours() === hour && slot.date.getMinutes() === min) {
      return slot.date
    }
  }
  return null
}

module.exports = { getAvailableSlots, createVisitEvent, extractConfirmedDatetime, formatSlot }
