const axios = require('axios')

const BASE_URL = 'https://www.joaoterraimoveis.com.br'

// Mapa de zonas de Londrina (mesmo do supabase.js)
const BAIRROS_POR_ZONA = {
  'zona norte': ['maria cecília','vista bela','flores do campo','semíramis','violin','aquiles stenghel','luiz de sá','parigot de souza','vivi xavier','joão paz','milton gavetti','jardim dos alpes','jardim pacaembu','jardim coliseu','heimtal','ouro verde','cinco conjuntos','conjunto violim','conjunto cafezal norte','jardim primavera','jardim planalto','jardim são jorge','parque industrial cacique','perobinha','são tomaz','residencial horizonte','residencial do café','conjunto josé giordano','cafezal','lindóia','lindoia','igapó','igapo','caiçaras','caicaras'],
  'zona sul': ['gleba palhano','gleba fazenda palhano','aurora','terra bonita','bela suíça','jardim tucanos','jardim cafezal','jardim piza','jardim itatiaia','colina verde','guanabara','vivendas do arvoredo','acapulco','esperança','nova esperança','saltinho','união da vitória','parque das indústrias','jardim marissol','jardim san fernando','jardim montecatini','jardim burle marx','royal park','alphaville','sun lake','parque tauá sul','alta boa vista','alto da boa vista','judith'],
  'zona leste': ['jardim morumbi','jardim interlagos','jardim antares','jardim ideal','jardim califórnia','jardim brasília','jardim santa fé','jardim marabá','pindorama','vila yara','vila santa terezinha','conjunto ernani moura lima','aeroporto','gleba lindóia','vila fraternidade','jardim são vicente','jardim santo andré','jardim do sol','parque das indústrias leves','residencial abussafe','jardim oriental','jardim santa rita'],
  'zona oeste': ['jardim bandeirantes','jardim sabará','jardim jamaica','jardim leonor','jardim olímpico','jardim presidente','jardim champagnat','shangri-lá','shangri-la','parque universidade','jardim columbia','jardim alvorada','jardim bancários','jardim hedy','jockey club','jardim versalhes','jardim barcelona','jardim monte belo','jardim tocantins','jardim santiago','cilo ii oeste','cilo iii','chácaras esperança','conjunto habitacional alexandre urbanas'],
  'centro': ['centro','centro histórico','vila casoni','vila brasil','vila nova','vila recreio','vila ipiranga','jardim higienópolis','jardim petrópolis','jardim quebec','jardim shangri-lá a','jardim shangrila a','jardim shanghai a','jardim américa','jardim claudia','jardim londrilar','jardim imperial','jardim agari','campos elíseos','santa rosa']
}

// Normaliza string para comparação (minúsculas, sem acentos)
function norm(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim()
}

// Detecta se um bairro pertence à zona solicitada
function bairroNaZona(bairro, zonaAlvo) {
  const bNorm = norm(bairro)
  const zona = norm(zonaAlvo)
    .replace(/^zn$/, 'zona norte')
    .replace(/^zs$/, 'zona sul')
    .replace(/^zl$/, 'zona leste')
    .replace(/^zo$/, 'zona oeste')
    .replace(/^norte$/, 'zona norte')
    .replace(/^sul$/, 'zona sul')
    .replace(/^leste$/, 'zona leste')
    .replace(/^oeste$/, 'zona oeste')

  const listaBairros = BAIRROS_POR_ZONA[zona]
  if (listaBairros) {
    return listaBairros.some(b => bNorm.includes(norm(b)) || norm(b).includes(bNorm))
  }
  // Fallback: comparação direta (bairro específico)
  return bNorm.includes(zona) || zona.includes(bNorm)
}

// Extrai imóveis do HTML da página de listagem — parseia card a card
function parseImoveis(html) {
  const result = []
  const seenIds = new Set()

  // Divide o HTML em blocos de card pelo marcador data-link
  const cardSplit = html.split('<div class="imovelcard"')
  for (let i = 1; i < cardSplit.length; i++) {
    const chunk = cardSplit[i]

    // Link e ID
    const linkMatch = chunk.match(/data-link="(\/imovel\/(\d+)\/[^"]+)"/)
    if (!linkMatch) continue
    const id = linkMatch[2]
    if (seenIds.has(id)) continue
    seenIds.add(id)
    const path = linkMatch[1]

    // Bairro: <h2 class="imovelcard__info__local">BAIRRO, Londrina / PR</h2>
    const localMatch = chunk.match(/<h2 class="imovelcard__info__local">([^<]+)<\/h2>/)
    const bairroRaw = localMatch ? localMatch[1].trim() : ''
    let bairro = bairroRaw.split(',')[0].trim()
    // Fallback: extrai bairro do slug da URL quando o h2 captura título completo
    if (bairro.length > 40) {
      const slugParts = path.replace(/.*londrina-pr-/, '').replace(/.*locacao-/, '').replace(/.*venda-/, '').split('-')
      bairro = slugParts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    }

    // Preço: R$ X.XXX
    const precoMatch = chunk.match(/imovelcard__valor__valor[^>]*><span>R\$<\/span>\s*([\d.,]+)/)
    const preco = precoMatch ? parseFloat(precoMatch[1].replace(/\./g, '').replace(',', '.')) : null

    // Dormitórios: do atributo title "X dormitórios"
    const dormMatch = chunk.match(/(\d+)\s*dormit/)
    const quartos = dormMatch ? parseInt(dormMatch[1]) : null

    result.push({
      url: BASE_URL + path,
      id,
      bairro,
      preco,
      quartos
    })
  }

  return result
}

// Busca imóveis ao vivo no site joaoterraimoveis.com.br
async function searchImoveisLiveSite({ tipo, quartos, regiao, orcamento, finalidade } = {}) {
  const purpose = finalidade === 'venda' ? 'venda' : 'locacao'

  // Monta URL de listagem
  const tipoMap = { 'apartamento': 'apartamento', 'casa': 'casa', 'comercial': 'comercial', 'terreno': 'terreno' }
  const tipoSlug = tipoMap[norm(tipo || '')] || ''
  const listUrl = tipoSlug
    ? `${BASE_URL}/imovel/${purpose}/${tipoSlug}`
    : `${BASE_URL}/imovel/${purpose}`

  let html
  try {
    const resp = await axios.get(listUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JoaoTerraBot/1.0)' },
      timeout: 15000
    })
    html = resp.data
  } catch (err) {
    console.error('[Scraper] Erro ao buscar site:', err.message)
    return []
  }

  let imoveis = parseImoveis(html)
  console.log(`[Scraper] ${imoveis.length} imóveis encontrados em ${listUrl}`)

  // Filtro por região/bairro
  if (regiao) {
    const comRegiao = imoveis.filter(im => bairroNaZona(im.bairro, regiao))
    // Se não encontrou nada na zona, não aplica filtro de região (mantém tudo)
    if (comRegiao.length > 0) imoveis = comRegiao
  }

  // Filtro por quartos (mínimo)
  if (quartos) {
    const comQuartos = imoveis.filter(im => im.quartos === null || im.quartos >= Number(quartos))
    if (comQuartos.length > 0) imoveis = comQuartos
  }

  // Filtro por orçamento ±30%
  if (orcamento) {
    const orcNum = Number(orcamento)
    const minPrice = orcNum * 0.7
    const maxPrice = orcNum * 1.3
    const comPreco = imoveis.filter(im => im.preco === null || (im.preco >= minPrice && im.preco <= maxPrice))
    if (comPreco.length > 0) imoveis = comPreco
  }

  // Ordena por proximidade ao orçamento
  if (orcamento) {
    const orcNum = Number(orcamento)
    imoveis.sort((a, b) => {
      const da = a.preco ? Math.abs(a.preco - orcNum) : 99999
      const db = b.preco ? Math.abs(b.preco - orcNum) : 99999
      return da - db
    })
  }

  return imoveis.slice(0, 5).map(im => ({
    title: im.bairro.split(',')[0].trim(),
    neighborhood_name: im.bairro.split(',')[0].trim(),
    bedrooms: im.quartos,
    price: im.preco,
    slug: im.url, // URL completa — já pronta para enviar ao cliente
    url: im.url
  }))
}

module.exports = { searchImoveisLiveSite }
