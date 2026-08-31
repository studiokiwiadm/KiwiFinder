// Extração de resultados a partir do HTML de uma loja.
//
// É aqui que mora a promessa "loja nova entra sem tocar no núcleo": em vez de
// escrever um conector por loja, existe uma escada de estratégias, da mais
// confiável para a mais genérica. O conector da loja só precisa dizer a URL de
// busca — e, quando a escada não dá conta, aí sim ganha seletores próprios.
//
//   1. JSON-LD (schema.org/Product) ....... dado estruturado oficial
//   2. Estado embutido (__NEXT_DATA__ etc.) ... o JSON que a própria loja usa
//   3. Microdata (itemprop) .................. schema.org no HTML
//   4. Seletores configurados ................ escrito à mão para essa loja
//   5. Heurística de blocos repetidos ........ funciona sem saber nada da loja
//
// Qual estratégia funcionou é informação de produto, não detalhe interno: é o
// que separa loja ✅ compatível de ⚠️ parcial no teste de compatibilidade.

import { parse, elementos, textoLimpo, attr, classes, assinatura, selecionarTodos, decodificar } from './html.js'
import { resumirDescontos, aplicarCupom } from './cupom.js'

// ------------------------------------------------------------------- preços

const RE_PRECO = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+,\d{2}|\d{2,7}(?:\.\d{2})?)/g

export function lerPreco (txt) {
  if (txt === null || txt === undefined) return null
  if (typeof txt === 'number') return Number.isFinite(txt) && txt > 0 ? txt : null
  const limpo = String(txt).trim()
  if (!limpo) return null
  // Formato brasileiro: ponto separa milhar, vírgula separa centavos.
  const brasileiro = limpo.match(/(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})/)
  if (brasileiro) {
    const n = parseFloat(brasileiro[1].replace(/\./g, '').replace(',', '.'))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const milhar = limpo.match(/\d{1,3}(?:\.\d{3})+(?!\d)/)
  if (milhar) {
    const n = parseFloat(milhar[0].replace(/\./g, ''))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const simples = limpo.match(/\d+(?:\.\d{1,2})?/)
  if (simples) {
    const n = parseFloat(simples[0])
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return null
}

// Marcas de "preço de referência" (o riscado). A Amazon usa `a-text-price` e
// `data-a-strike` — sem reconhecer isso, o preço gravado era o DE e não o POR.
const DICAS_ANTIGO = /(old|antig|riscad|de-preco|preco-de|from|through|regular|list-price|precoDe|old-price|linethrough|strike|text-price|basePrice|listPrice|price-before|was-price)/i
const DICAS_ATUAL = /(sale|por|best|main|current|atual|final|new-price|price-value|precoPor|selling)/i
const DICAS_PARCELA = /(parcel|installment|vezes|x-de|prazo)/i
const DICAS_DESCONTO = /(economi|desconto|cashback|voc[êe] ganha|de volta|frete|poupe|cupom|coupon|save|voucher|abatimento|off\b)/i

// "10x de R$ 10,45" no cartão: o 10,45 não é o preço do produto. Reconhecer o
// parcelamento evita que uma cadeira de R$ 104,50 apareça como R$ 10,45 — foi
// exatamente o que a loja da Tramontina fez no primeiro teste.
const RE_PARCELA = /(\d{1,2})\s*x\s*(?:de\s*)?(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+,\d{2})/gi

// Todo rodapé de loja tem CNPJ, e "50.874.446/0001-13" lido como número vira um
// MacBook de R$ 50 milhões — foi o que a Go Imports produziu. CPF, CEP e
// telefone caem na mesma armadilha.
function ehDocumento (txt) {
  if (/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-?\d{2}\b/.test(txt)) return true // CNPJ
  if (/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(txt)) return true // CPF
  if (/\b\d{5}-\d{3}\b/.test(txt)) return true // CEP
  if (/\(\d{2}\)\s*\d{4,5}-?\d{4}/.test(txt)) return true // telefone
  if (/\b(cnpj|cpf|cep|telefone|whatsapp|copyright|©)\b/i.test(txt)) return true
  return false
}

function parcelasDoBloco (raiz) {
  const texto = textoLimpo(raiz)
  const achadas = []
  for (const m of texto.matchAll(RE_PARCELA)) {
    const vezes = Number(m[1])
    const valor = lerPreco(m[2])
    if (vezes >= 2 && valor) achadas.push({ vezes, valor, total: Number((vezes * valor).toFixed(2)) })
  }
  return achadas
}

function textoProprio (el) {
  let saida = ''
  for (const f of el.filhos) {
    if (f.tipo === 'elemento') continue
    saida += ' ' + (f.valor || '')
  }
  return decodificar(saida).replace(/\s+/g, ' ').trim()
}

function coletarPrecos (raiz) {
  const achados = []
  for (const el of elementos(raiz)) {
    // Só o texto PRÓPRIO do elemento, sem o dos filhos. Exigir folha pura
    // escondia o preço da Go Imports, escrito como
    // `<h2 class="price">R$ 17.299,00 <span>no pix</span></h2>`: o h2 tem filho
    // elemento e era descartado inteiro, sobrando só números avulsos da página.
    const txt = textoProprio(el)
    if (!txt || txt.length > 60) continue
    if (!/\d/.test(txt)) continue
    if (ehDocumento(txt)) continue
    const valor = lerPreco(txt)
    if (valor === null) continue
    const contexto = [el.tag, attr(el, 'class'), attr(el, 'id'),
      el.pai ? attr(el.pai, 'class') : ''].join(' ')
    // Riscado por `style` inline, não por tag nem classe: a Go Imports escreve
    // `<h5 style="text-decoration: line-through;">R$ 8.599,00</h5>` acima do
    // preço real de R$ 8.099 no Pix. Sem olhar o style, o app anunciava o preço
    // riscado — o contrário do que este app existe para fazer.
    const riscadoNoEstilo = /line-through/i.test(attr(el, 'style') + ' ' + (el.pai ? attr(el.pai, 'style') : ''))
    // O texto ao redor importa: "ECONOMIZE R$ 10,45" é desconto, não preço —
    // a loja da Tramontina virava uma cadeira de R$ 209 em R$ 10,45 por isso.
    const aoRedor = el.pai ? textoLimpo(el.pai).slice(0, 160) : ''
    const temCifrao = /R\$/.test(txt)
    achados.push({
      valor,
      texto: txt,
      antigo: el.tag === 'del' || el.tag === 's' || el.tag === 'strike' || riscadoNoEstilo || DICAS_ANTIGO.test(contexto),
      atual: DICAS_ATUAL.test(contexto),
      parcela: DICAS_PARCELA.test(contexto) || /\d+\s*x\s*(de)?/i.test(txt),
      desconto: DICAS_DESCONTO.test(contexto) || DICAS_DESCONTO.test(aoRedor),
      temCifrao
    })
  }
  return achados
}

/**
 * Um cartão de produto brasileiro costuma mostrar três números: o riscado, o
 * "por" e o preço no Pix. Escolher o menor faz o app inventar promoção; por
 * isso o preço de referência é o maior entre os que não são riscados nem
 * parcela, e o menor fica guardado à parte como preço à vista.
 */
export function escolherPreco (raiz, opcoes = {}) {
  let precos = coletarPrecos(raiz)
  if (!precos.length) return { preco: null }
  const comCifrao = precos.filter(p => p.temCifrao)
  if (comCifrao.length) precos = comCifrao

  // Loja brasileira escreve preço com centavos: "17.299,00". Quando o R$ mora
  // num elemento separado do número — a Go Imports faz isso — o cifrão não
  // ajuda a separar preço de qualquer outro número da página, e o app acabava
  // gravando um MacBook por "R$ 273". Havendo valores em formato de dinheiro,
  // só eles concorrem.
  const comCentavos = precos.filter(p => /\d,\d{2}(?!\d)/.test(p.texto))
  if (comCentavos.length) precos = comCentavos

  // Marca como parcela todo valor que aparece como "Nx de R$ valor".
  const parcelas = parcelasDoBloco(raiz)
  if (parcelas.length) {
    for (const p of precos) {
      if (parcelas.some(par => Math.abs(par.valor - p.valor) < 0.01)) p.parcela = true
    }
  }

  const antigos = precos.filter(p => p.antigo)
  const validos = precos.filter(p => !p.antigo && !p.parcela && !p.desconto)
  let pool = validos.length ? validos : precos.filter(p => !p.antigo && !p.desconto)

  // Só sobrou parcela? Então o preço cheio é a conta do parcelamento.
  if (!validos.length && parcelas.length) {
    const total = Math.max(...parcelas.map(p => p.total))
    if (total > 0) pool = [{ valor: total, texto: `${parcelas[0].vezes}x`, antigo: false, parcela: false, atual: true, temCifrao: true }]
  }
  if (!pool.length) return { preco: null }

  const marcados = pool.filter(p => p.atual)
  let base = marcados.length ? marcados : pool

  // Agora que o menor valor é o escolhido, qualquer número pequeno que escape
  // dos filtros vira "preço". A Amazon põe "cupom de R$ 20" dentro do cartão,
  // e o produto de R$ 1.839 virava R$ 20. Um preço de verdade não é uma fração
  // ínfima dos outros valores do mesmo cartão.
  const referencia = Math.max(...precos.map(p => p.valor))
  if (base.length > 1 && referencia > 0) {
    const filtrada = base.filter(p => p.valor >= referencia * 0.2)
    if (filtrada.length) base = filtrada
  }

  // Numa PÁGINA DE PRODUTO o menor preço da tela não é o preço do produto: a
  // página está cheia de acessório, "compre junto" e recomendação. Ali vale o
  // primeiro preço em ordem de documento, que é o da caixa de compra.
  if (opcoes.preferirPrimeiro && base.length > 1) {
    const primeiro = base[0]
    const total = parcelas.length ? Math.max(...parcelas.map(p => p.total)) : null
    // Conferência com o parcelamento: "11x de R$ 1.554" só faz sentido para um
    // produto de ~R$ 17.000. Se o preço escolhido for muito menor que isso, ele
    // é de outro item da página — fica o candidato mais próximo do total.
    if (total && primeiro.valor < total * 0.6) {
      const coerente = base
        .slice()
        .sort((a, b) => Math.abs(a.valor - total) - Math.abs(b.valor - total))[0]
      if (coerente) return finalizar(coerente, base, antigos, raiz)
    }
    return finalizar(primeiro, base, antigos, raiz)
  }

  const valores = base.map(p => p.valor).sort((a, b) => a - b)

  // O preço que vale é o MENOR entre os candidatos legítimos — não o maior.
  //
  // A regra anterior pegava o maior para ser conservadora, e isso gravava o
  // preço riscado da Amazon: numa promoção "-14%, R$ 1.878,90, De: R$ 2.199",
  // o app registrava R$ 2.199 e a promoção passava despercebida — justamente
  // o oposto do que este app existe para fazer.
  //
  // Riscado, parcela e desconto já saíram do bolo antes daqui; o que sobra são
  // preços que dá para pagar de verdade (à vista, Pix, cartão). Entre eles, o
  // menor é o que interessa a quem procura oportunidade.
  return finalizar(base.find(p => p.valor === valores[0]), base, antigos, raiz)
}

// precoAVista guarda o maior valor legítimo do bloco, para a interface poder
// mostrar "R$ X no Pix / R$ Y no cartão"; condicao e parcelamento são o que a
// pessoa precisa saber antes de clicar.

function finalizar (escolhido, base, antigos, raiz) {
  const outros = base.map(p => p.valor).filter(v => v !== escolhido.valor)
  const maior = outros.length ? Math.max(...outros) : null
  const precoDe = antigos.length ? Math.max(...antigos.map(p => p.valor)) : null
  return {
    preco: escolhido.valor,
    precoAVista: maior && maior > escolhido.valor ? maior : null,
    precoDe: precoDe && precoDe > escolhido.valor ? precoDe : null,
    condicao: condicaoDoPreco(raiz, escolhido),
    parcelamento: melhorParcelamento(raiz, escolhido.valor)
  }
}

/**
 * Em que condição o preço escolhido vale. A loja quase sempre escreve isso
 * grudado no número — "R$ 8.099,00 no pix", "à vista", "no boleto" — e sem
 * essa etiqueta a pessoa acha que o valor vale no cartão também.
 */
function condicaoDoPreco (raiz, escolhido) {
  const texto = textoLimpo(raiz)
  if (!escolhido) return null
  const idx = texto.indexOf(escolhido.texto)
  const janela = idx >= 0 ? texto.slice(idx, idx + 60) : texto.slice(0, 160)
  // "5% de desconto à vista no Pix" é oferta de desconto, não a condição do
  // preço mostrado — esse abatimento já é calculado à parte. Dizer "R$ 3.514,05
  // no Pix" aqui seria prometer o preço cheio como se fosse o com desconto.
  if (/\d+\s*%[^.]{0,30}(pix|à vista|a vista)/i.test(janela)) return null
  if (/\bno pix\b|\bpix\b/i.test(janela)) return 'no Pix'
  if (/\bà vista\b|\ba vista\b/i.test(janela)) return 'à vista'
  if (/\bboleto\b/i.test(janela)) return 'no boleto'
  if (/\btransfer[êe]ncia\b/i.test(janela)) return 'por transferência'
  return null
}

/** "em até 10x de R$ 1.691,08 sem juros" */
function melhorParcelamento (raiz, preco) {
  const texto = textoLimpo(raiz)
  const achadas = []
  for (const m of texto.matchAll(RE_PARCELA)) {
    const vezes = Number(m[1])
    const valor = lerPreco(m[2])
    if (!valor || vezes < 2) continue
    const janela = texto.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)
    achadas.push({ vezes, valor, semJuros: /sem juros/i.test(janela), total: Number((vezes * valor).toFixed(2)) })
  }
  if (!achadas.length) return null

  // O parcelamento tem que fechar com o preço. A página da Go Imports anuncia
  // "24x de R$ 196" de um acessório ao lado de um MacBook de R$ 17.299; sem
  // esta conferência o app oferecia esse parcelamento como se fosse do MacBook.
  // Sem juros o total bate com o preço; com juros ele passa, mas não dobra.
  const coerentes = Number.isFinite(preco) && preco > 0
    ? achadas.filter(p => p.total >= preco * 0.9 && p.total <= preco * 1.8)
    : achadas
  if (!coerentes.length) return null

  // O parcelamento que interessa é o de mais vezes sem juros; se não houver
  // nenhum sem juros, o de mais vezes mesmo.
  const semJuros = coerentes.filter(p => p.semJuros)
  const pool = semJuros.length ? semJuros : coerentes
  return pool.reduce((a, b) => (b.vezes > a.vezes ? b : a))
}

// ------------------------------------------------------------------ JSON-LD

function scriptsJson (raiz, tipoAttr) {
  const saida = []
  for (const el of elementos(raiz)) {
    if (el.tag !== 'script') continue
    const tipo = attr(el, 'type').toLowerCase()
    if (tipoAttr && !tipo.includes(tipoAttr)) continue
    const bruto = el.filhos.map(f => f.valor || '').join('').trim()
    if (!bruto) continue
    saida.push({ el, bruto })
  }
  return saida
}

function achatarJsonLd (no, saida = []) {
  if (!no || typeof no !== 'object') return saida
  if (Array.isArray(no)) { no.forEach(n => achatarJsonLd(n, saida)); return saida }
  saida.push(no)
  for (const chave of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasVariant', 'isSimilarTo']) {
    if (no[chave]) achatarJsonLd(no[chave], saida)
  }
  return saida
}

function ofertaDe (produto) {
  let ofertas = produto.offers || produto.Offers
  if (!ofertas) return {}
  if (Array.isArray(ofertas)) ofertas = ofertas[0]
  if (ofertas && ofertas['@type'] === 'AggregateOffer') {
    return {
      preco: lerPreco(ofertas.lowPrice ?? ofertas.price ?? ofertas.highPrice),
      moeda: ofertas.priceCurrency,
      disponivel: true
    }
  }
  const disp = String(ofertas.availability || '').toLowerCase()
  return {
    preco: lerPreco(ofertas.price ?? (ofertas.priceSpecification && ofertas.priceSpecification.price)),
    moeda: ofertas.priceCurrency || (ofertas.priceSpecification && ofertas.priceSpecification.priceCurrency),
    disponivel: disp ? !/(outofstock|soldout|discontinued)/.test(disp) : null,
    url: ofertas.url || null
  }
}

function textoDe (v) {
  if (!v) return ''
  if (typeof v === 'string') return decodificar(v).trim()
  if (typeof v === 'object') return textoDe(v.name || v.value || v['@id'] || '')
  return String(v)
}

/** Descarta foto de cliente venha ela de onde vier (JSON-LD, microdata, HTML). */
export function fotoAceitavel (src) {
  if (!src || typeof src !== 'string') return false
  return !IMAGEM_DE_CLIENTE.test(src) && !IMAGEM_LIXO.test(src)
}

function imagemDe (v) {
  if (!v) return null
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return imagemDe(v[0])
  if (typeof v === 'object') return v.url || v.contentUrl || null
  return null
}

function produtoDeJsonLd (no, urlBase) {
  const tipo = [].concat(no['@type'] || []).map(t => String(t).toLowerCase())
  if (!tipo.some(t => t === 'product' || t === 'productmodel' || t === 'individualproduct')) return null
  const oferta = ofertaDe(no)
  const nome = textoDe(no.name)
  if (!nome) return null
  return {
    nome,
    preco: oferta.preco,
    moeda: oferta.moeda || 'BRL',
    disponivel: oferta.disponivel,
    url: absoluta(no.url || oferta.url || no['@id'], urlBase),
    imagem: absoluta(imagemDe(no.image), urlBase),
    marca: textoDe(no.brand),
    fabricante: textoDe(no.manufacturer),
    modelo: textoDe(no.model),
    sku: textoDe(no.sku),
    mpn: textoDe(no.mpn),
    gtin: textoDe(no.gtin13 || no.gtin14 || no.gtin12 || no.gtin8 || no.gtin),
    categoria: textoDe(no.category),
    fonte: 'jsonld'
  }
}

export function extrairJsonLd (raiz, urlBase) {
  const produtos = []
  for (const { bruto } of scriptsJson(raiz, 'ld+json')) {
    let dados
    try {
      dados = JSON.parse(bruto)
    } catch {
      // JSON-LD quebrado é comum; tenta o maior objeto balanceado que existir.
      const tentativa = bruto.match(/\{[\s\S]*\}/)
      if (!tentativa) continue
      try { dados = JSON.parse(tentativa[0]) } catch { continue }
    }
    for (const no of achatarJsonLd(dados)) {
      const p = produtoDeJsonLd(no, urlBase)
      if (p) produtos.push(p)
    }
  }
  return produtos
}

// ------------------------------------------------- estado embutido (JS/JSON)

const CHAVES_NOME = ['name', 'productName', 'nome', 'title', 'titulo', 'displayName']
const CHAVES_PRECO = ['price', 'preco', 'sellingPrice', 'Price', 'bestPrice', 'priceValue',
  'finalPrice', 'salePrice', 'valor', 'currentPrice', 'precoAtual', 'priceWithDiscount']
const CHAVES_URL = ['url', 'link', 'linkText', 'href', 'productUrl', 'detailUrl', 'slug', 'permalink']
const CHAVES_IMG = ['image', 'imageUrl', 'imagem', 'thumbnail', 'thumb', 'picture', 'foto', 'images']

function primeiroDe (obj, chaves) {
  for (const c of chaves) {
    if (obj[c] !== undefined && obj[c] !== null && obj[c] !== '') return obj[c]
  }
  return null
}

function normalizarPrecoEstado (v) {
  if (v && typeof v === 'object') v = primeiroDe(v, ['value', 'amount', 'price', 'centsValue', 'raw'])
  const n = typeof v === 'number' ? v : lerPreco(v)
  if (n === null) return null
  // VTEX e afins às vezes guardam centavos como inteiro.
  if (Number.isInteger(n) && n > 100000) return n / 100
  return n
}

function varrerEstado (no, urlBase, achados, visto = new Set(), profundidade = 0) {
  if (!no || typeof no !== 'object' || profundidade > 14 || achados.length > 400) return achados
  if (visto.has(no)) return achados
  visto.add(no)
  if (Array.isArray(no)) {
    for (const item of no) varrerEstado(item, urlBase, achados, visto, profundidade + 1)
    return achados
  }
  const nome = primeiroDe(no, CHAVES_NOME)
  const precoBruto = primeiroDe(no, CHAVES_PRECO)
  if (typeof nome === 'string' && nome.length > 6 && nome.length < 300 && precoBruto !== null) {
    const preco = normalizarPrecoEstado(precoBruto)
    if (preco !== null && preco >= 1) {
      const url = primeiroDe(no, CHAVES_URL)
      const img = primeiroDe(no, CHAVES_IMG)
      achados.push({
        nome: decodificar(String(nome)).trim(),
        preco,
        moeda: no.currency || no.priceCurrency || 'BRL',
        disponivel: no.available ?? no.isAvailable ?? no.inStock ?? no.disponivel ?? null,
        url: absoluta(typeof url === 'string' ? url : null, urlBase),
        imagem: absoluta(typeof img === 'string' ? img : (Array.isArray(img) ? imagemDe(img) : null), urlBase),
        marca: textoDe(no.brand || no.marca || no.brandName),
        modelo: textoDe(no.model || no.modelo),
        sku: textoDe(no.sku || no.skuId || no.productId || no.id),
        mpn: textoDe(no.mpn || no.partNumber),
        gtin: textoDe(no.ean || no.gtin || no.gtin13 || no.barcode),
        categoria: textoDe(no.category || no.categoria),
        fonte: 'estado'
      })
    }
  }
  for (const valor of Object.values(no)) {
    if (valor && typeof valor === 'object') varrerEstado(valor, urlBase, achados, visto, profundidade + 1)
  }
  return achados
}

export function extrairEstado (raiz, urlBase) {
  const achados = []
  for (const { el, bruto } of scriptsJson(raiz, null)) {
    const id = attr(el, 'id')
    let json = null
    if (id === '__NEXT_DATA__' || attr(el, 'type').includes('json')) {
      try { json = JSON.parse(bruto) } catch { json = null }
    }
    if (!json) {
      // window.__X__ = {...};  /  self.__next_f.push([1,"..."])
      const atribuicao = bruto.match(/(?:window|self)\.__[A-Z_a-z0-9]+__\s*=\s*(\{[\s\S]*?\})\s*[;\n]/)
      if (atribuicao) {
        try { json = JSON.parse(atribuicao[1]) } catch { json = null }
      }
    }
    if (!json && bruto.length > 200 && bruto.length < 4_000_000) {
      const inicio = bruto.indexOf('{"')
      if (inicio >= 0) {
        const recorte = recortarJson(bruto, inicio)
        if (recorte) { try { json = JSON.parse(recorte) } catch { json = null } }
      }
    }
    if (json) varrerEstado(json, urlBase, achados)
    if (achados.length > 300) break
  }
  return deduplicar(achados)
}

// Recorta um objeto JSON balanceado começando em `inicio`, respeitando strings.
function recortarJson (txt, inicio) {
  let nivel = 0
  let emString = false
  let escapado = false
  for (let i = inicio; i < txt.length && i - inicio < 4_000_000; i++) {
    const c = txt[i]
    if (emString) {
      if (escapado) escapado = false
      else if (c === '\\') escapado = true
      else if (c === '"') emString = false
      continue
    }
    if (c === '"') emString = true
    else if (c === '{') nivel++
    else if (c === '}') {
      nivel--
      if (nivel === 0) return txt.slice(inicio, i + 1)
    }
  }
  return null
}

// ----------------------------------------------------------------- microdata

export function extrairMicrodata (raiz, urlBase) {
  const produtos = []
  const escopos = selecionarTodos(raiz, '[itemtype]').filter(el =>
    /schema.org\/(Product|IndividualProduct)/i.test(attr(el, 'itemtype')))
  for (const escopo of escopos) {
    const props = {}
    for (const el of elementos(escopo)) {
      const nome = attr(el, 'itemprop')
      if (!nome) continue
      const valor = attr(el, 'content') || attr(el, 'href') || attr(el, 'src') || textoLimpo(el)
      if (valor && props[nome] === undefined) props[nome] = valor
    }
    if (!props.name) continue
    produtos.push({
      nome: props.name,
      preco: lerPreco(props.price),
      moeda: props.priceCurrency || 'BRL',
      disponivel: props.availability ? !/outofstock|soldout/i.test(props.availability) : null,
      url: absoluta(props.url, urlBase),
      imagem: absoluta(props.image, urlBase),
      marca: props.brand || '',
      sku: props.sku || '',
      mpn: props.mpn || '',
      gtin: props.gtin13 || props.gtin || '',
      fonte: 'microdata'
    })
  }
  return produtos
}

// ------------------------------------------------------ seletores da própria loja

export function extrairPorSeletores (raiz, urlBase, seletores) {
  if (!seletores || !seletores.item) return []
  const itens = selecionarTodos(raiz, seletores.item)
  const saida = []
  for (const item of itens) {
    const nome = seletores.nome
      ? textoLimpo(selecionarTodos(item, seletores.nome)[0])
      : melhorNome(item)
    if (!nome) continue
    const precoEl = seletores.preco ? selecionarTodos(item, seletores.preco)[0] : null
    const precos = precoEl ? { preco: lerPreco(textoLimpo(precoEl)) } : escolherPreco(item)
    const link = seletores.link
      ? selecionarTodos(item, seletores.link)[0]
      : selecionarTodos(item, 'a')[0]
    saida.push({
      nome,
      preco: precos.preco,
      precoDe: precos.precoDe || null,
      precoAVista: precos.precoAVista || null,
      moeda: 'BRL',
      url: absoluta(link ? attr(link, 'href') : null, urlBase),
      imagem: melhorImagem(item, urlBase),
      fonte: 'seletores'
    })
  }
  return saida
}

// ------------------------------------------- heurística de blocos repetidos

// Texto de interface que a loja põe dentro do cartão e que não é nome de
// produto. Sem esta lista, a Amazon devolvia "Preço, página do produto" e
// "à vista no Pix ou NuPay" como se fossem os produtos.
const RUIDO = /^(pre[çc]o|à vista|a vista|no pix|nupay|frete|entrega|patrocinad|mais opç|ver opç|adicionar|comprar|avaliaç|em estoque|esgotado|economize|cupom|oferta do dia|resultados|classificaç|de r\$|por r\$|\d+\s*x\s)/i
const RUIDO_DENTRO = /(à vista no|no pix ou|página do produto|adicionar ao carrinho|frete grátis|ver todas as opções)/i

function pareceNomeDeProduto (txt) {
  if (!txt || txt.length < 15 || txt.length > 220) return false
  if (RUIDO.test(txt) || RUIDO_DENTRO.test(txt)) return false
  if (/R\$/.test(txt)) return false
  if (txt.split(/\s+/).length < 3) return false
  const letras = (txt.match(/[a-zA-ZÀ-ÿ]/g) || []).length
  // Exigir metade de letras derrubava nome de eletrônico, que é quase todo
  // número: `MacBook Air 13" (2026) M5 / 16GB / 512GB SSD` dá 41% de letras.
  // O que separa nome de lixo numérico é ter palavra de verdade, não densidade.
  const palavras = (txt.match(/[a-zA-ZÀ-ÿ]{3,}/g) || []).length
  return letras / txt.length > 0.35 && palavras >= 2
}

function melhorNome (bloco) {
  const candidatos = []
  for (const el of elementos(bloco)) {
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span', 'p', 'div'].includes(el.tag)) {
      const txt = textoLimpo(el)
      if (pareceNomeDeProduto(txt)) {
        let peso = 0
        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(el.tag)) peso += 34
        if (el.tag === 'a') peso += 18
        if (/(name|nome|title|titulo|product|produto|descricao)/i.test(attr(el, 'class'))) peso += 26
        if (attr(el, 'title')) peso += 6
        peso += Math.min(txt.length, 120) / 6
        candidatos.push({ txt, peso })
      }
    }
    const alt = attr(el, 'alt')
    if (el.tag === 'img' && pareceNomeDeProduto(alt)) candidatos.push({ txt: alt, peso: 24 })
    const titulo = attr(el, 'title')
    if (pareceNomeDeProduto(titulo)) candidatos.push({ txt: titulo, peso: 20 })
  }
  if (!candidatos.length) return ''
  candidatos.sort((a, b) => b.peso - a.peso)
  return candidatos[0].txt
}

// Imagens que não são o produto: sprites de interface, pixels transparentes,
// selos de "Prime"/"Frete grátis". A Amazon enche o cartão delas, e o app
// acabava mostrando um mosaico de ícones no lugar da foto.
const IMAGEM_LIXO = /(sprite|transparent-pixel|grey-pixel|pixel\.gif|blank\.|placeholder|loading|spinner|prime|badge|selo|icon|logo|star|rating|1x1|spacer)/i

// Foto tirada por cliente, não pela loja.
//
// A Amazon mistura, na mesma listagem, a foto oficial do produto e as fotos que
// compradores enviaram na avaliação — estas vêm marcadas com `aicid=community`.
// A Nespresso Essenza Mini no KiwiFinder acabou com três fotos amadorais, de
// 154x154 pixels, no meio de cards com foto de catálogo. Fica claro na tela que
// aquele produto "não é do mesmo lugar" que os outros.
const IMAGEM_DE_CLIENTE = /(aicid=community|user-?generated|customer-?image|review-?image)/i

// A loja diz qual é a foto principal — e é nisso que se deve confiar, não no
// tamanho.
//
// "A maior imagem da página" parecia um bom critério e não é: numa página da
// Amazon as fotos que clientes enviaram costumam ser MAIORES que a oficial. Na
// Nespresso Essenza Mini, a oficial é `51QP72LhToL` (marcada `landingImage`) e
// a maior da página era `71bmcVcL06L`, tirada por um comprador — que dá ao
// produto cara de usado.
const MARCA_PRINCIPAL = /(landingimage|landing-image|main-?image|product-?image|image-?block|gallery-?main|imagem-?principal|foto-?principal|hero-?image|primary-?image)/i

// Seções de avaliação, onde moram as fotos de cliente.
const SECAO_DE_CLIENTE = /(review|customer|community|ugc|user-?image|depoimento|avaliacao|avaliação|coment)/i

function dentroDeSecaoDeCliente (el) {
  let atual = el
  for (let i = 0; i < 6 && atual; i++) {
    const marca = attr(atual, 'id') + ' ' + attr(atual, 'class') + ' ' + attr(atual, 'data-testid')
    if (SECAO_DE_CLIENTE.test(marca)) return true
    atual = atual.pai
  }
  return false
}

function melhorImagem (bloco, urlBase) {
  const candidatas = []
  for (const el of elementos(bloco)) {
    if (el.tag !== 'img') continue
    // `data-old-hires` é a versão em alta da foto OFICIAL; quando existe, é a
    // melhor fonte que a página oferece.
    const src = attr(el, 'data-old-hires') || attr(el, 'src') || attr(el, 'data-src') ||
      attr(el, 'data-original') ||
      (attr(el, 'srcset').split(',')[0] || '').trim().split(' ')[0]
    if (!src || src.startsWith('data:')) continue
    if (IMAGEM_LIXO.test(src)) continue
    if (IMAGEM_DE_CLIENTE.test(src)) continue
    if (dentroDeSecaoDeCliente(el)) continue
    // Miniatura declarada pequena não serve.
    const largura = Number(attr(el, 'width')) || 0
    const altura = Number(attr(el, 'height')) || 0
    if ((largura && largura < 60) || (altura && altura < 60)) continue
    const alt = attr(el, 'alt') || ''
    const marcas = [attr(el, 'id'), attr(el, 'class'), attr(el, 'data-a-image-name'),
      el.pai ? attr(el.pai, 'id') : '', el.pai ? attr(el.pai, 'class') : ''].join(' ')
    // O peso da marcação é maior que qualquer tamanho: é declaração da loja,
    // não palpite nosso.
    const principal = MARCA_PRINCIPAL.test(marcas) ? 10000 : 0
    candidatas.push({ src, peso: principal + Math.max(largura, altura) + (alt.length > 12 ? 40 : 0) })
  }
  if (candidatas.length) {
    candidatas.sort((a, b) => b.peso - a.peso)
    return absoluta(candidatas[0].src, urlBase)
  }
  const comFundo = elementos(bloco)
  for (const el of comFundo) {
    const estilo = attr(el, 'style')
    const m = estilo && estilo.match(/url\(['"]?([^'")]+)/)
    if (m) return absoluta(m[1], urlBase)
  }
  return null
}

export function extrairHeuristica (raiz, urlBase) {
  // 1. Onde há preço na página?
  const comPreco = []
  for (const el of elementos(raiz)) {
    if (el.filhos.some(f => f.tipo === 'elemento')) continue
    const txt = textoLimpo(el)
    if (txt.length > 40 || !/R\$/.test(txt)) continue
    if (lerPreco(txt) === null) continue
    comPreco.push(el)
  }
  // Busca específica costuma devolver UM resultado só — é o caso normal deste
  // app, não a exceção. Exigir três preços na página fazia a busca certeira
  // ("MacBook Air 13 M5 16GB 512GB" na Go Imports, um acerto exato) voltar
  // vazia, e a loja parecia não ter o produto.
  if (!comPreco.length) return []

  // 2. Sobe até um ancestral que tenha link, preço E um nome de produto
  //    plausível. Parar no primeiro ancestral com link não basta: na Amazon o
  //    preço fica dentro de um bloco que já tem link próprio, e esse bloco não
  //    contém o título — o resultado era cartão sem nome, descartado depois.
  const grupos = new Map()
  for (const preco of comPreco) {
    let atual = preco.pai
    let subidas = 0
    let reserva = null
    while (atual && subidas < 11) {
      const temLink = selecionarTodos(atual, 'a').length > 0
      const tamanho = textoLimpo(atual).length
      if (temLink && tamanho > 25 && tamanho < 2500) {
        if (melhorNome(atual)) {
          const chave = assinatura(atual)
          if (!grupos.has(chave)) grupos.set(chave, new Set())
          grupos.get(chave).add(atual)
          break
        }
        // Guarda o primeiro bloco com link como plano B, caso nenhum ancestral
        // acima tenha nome reconhecível.
        if (!reserva) reserva = atual
      }
      atual = atual.pai
      subidas++
      if (subidas === 11 && reserva) {
        const chave = assinatura(reserva)
        if (!grupos.has(chave)) grupos.set(chave, new Set())
        grupos.get(chave).add(reserva)
      }
    }
  }
  if (!grupos.size) return []

  // 3. O grupo campeão é o que tem mais irmãos parecidos.
  let melhor = null
  for (const [chave, conjunto] of grupos) {
    const blocos = [...conjunto]
    if (blocos.length < 2) continue
    const pontos = blocos.length * 10 + (chave.includes('.') ? 15 : 0)
    if (!melhor || pontos > melhor.pontos) melhor = { chave, blocos, pontos }
  }

  // Nenhum bloco se repete: ou a página não tem lista, ou a busca acertou em
  // cheio e devolveu um resultado só. Vale tentar o segundo caso — mas só com
  // bloco completo (nome, preço e link), para não transformar um banner
  // qualquer em produto.
  if (!melhor) {
    const solitarios = []
    for (const [chave, conjunto] of grupos) {
      for (const bloco of conjunto) {
        if (!melhorNome(bloco)) continue
        if (escolherPreco(bloco).preco === null) continue
        if (!selecionarTodos(bloco, 'a[href]').length) continue
        solitarios.push({ chave, blocos: [bloco], pontos: textoLimpo(bloco).length })
      }
    }
    // Entre eles, o mais enxuto: um cartão de produto é curto, um container que
    // engoliu a página inteira é longo.
    solitarios.sort((a, b) => a.pontos - b.pontos)
    melhor = solitarios[0] || null
  }
  if (!melhor) return []

  const saida = []
  for (const bloco of melhor.blocos) {
    const nome = melhorNome(bloco)
    if (!nome) continue
    const precos = escolherPreco(bloco)
    if (precos.preco === null) continue
    const link = selecionarTodos(bloco, 'a[href]')[0]
    saida.push({
      nome,
      preco: precos.preco,
      precoDe: precos.precoDe || null,
      precoAVista: precos.precoAVista || null,
      moeda: 'BRL',
      url: absoluta(link ? attr(link, 'href') : null, urlBase),
      imagem: melhorImagem(bloco, urlBase),
      disponivel: null,
      fonte: 'heuristica'
    })
  }
  return saida
}

/**
 * Acha a próxima página de resultados. Primeiro pelo caminho honesto
 * (`rel="next"`), depois pelo link cujo texto é o número da página seguinte, e
 * só então chutando o parâmetro na URL — nessa ordem porque as duas primeiras
 * vêm da própria loja e a terceira é adivinhação.
 */
export function proximaPagina (raiz, urlAtual, paginaAtual = 1) {
  const proximo = paginaAtual + 1

  const relNext = selecionarTodos(raiz, 'a[rel=next], link[rel=next]')[0]
  if (relNext && attr(relNext, 'href')) {
    const url = absoluta(attr(relNext, 'href'), urlAtual)
    if (url && url !== urlAtual) return url
  }

  for (const a of selecionarTodos(raiz, 'a[href]')) {
    if (textoLimpo(a) !== String(proximo)) continue
    const href = attr(a, 'href')
    if (!/(page|pagina|p=|offset|from)/i.test(href)) continue
    const url = absoluta(href, urlAtual)
    if (url && url !== urlAtual) return url
  }

  try {
    const u = new URL(urlAtual)
    const jaTem = ['page', 'pagina', 'p', 'pg'].find(p => u.searchParams.has(p))
    u.searchParams.set(jaTem || 'page', String(proximo))
    return u.href
  } catch { return null }
}

// -------------------------------------------------------------------- apoio

export function absoluta (url, base) {
  if (!url || typeof url !== 'string') return null
  const limpa = url.trim()
  if (!limpa || limpa.startsWith('javascript:') || limpa.startsWith('#')) return null
  try { return new URL(limpa, base).href } catch { return null }
}

function chaveItem (item) {
  return (item.url || '') + '|' + (item.nome || '').toLowerCase().slice(0, 80)
}

/**
 * Mede se um conjunto de resultados tem cara de listagem de produto de
 * verdade. Preço repetido em todos os itens é o sintoma clássico de campo
 * errado; falta de link é sintoma de objeto que não era produto.
 */
function qualidade (itens, comPreco) {
  const total = Math.max(itens.length, 1)
  const fracUrl = itens.filter(i => i.url).length / total
  const precos = comPreco.map(i => i.preco)
  const distintos = new Set(precos.map(p => Math.round(p * 100))).size
  const fracPrecoDistinto = precos.length ? distintos / precos.length : 0
  const nomesDistintos = new Set(itens.map(i => (i.nome || '').toLowerCase())).size / total
  const fator = (0.45 + 0.55 * fracUrl) *
    (0.25 + 0.75 * Math.min(1, fracPrecoDistinto * 1.6)) *
    (0.6 + 0.4 * nomesDistintos)
  return { fator, fracUrl, fracPrecoDistinto, nomesDistintos }
}

export function deduplicar (itens) {
  const vistos = new Map()
  for (const item of itens) {
    const chave = chaveItem(item)
    const anterior = vistos.get(chave)
    if (!anterior) { vistos.set(chave, item); continue }
    // Fica o mais completo dos dois.
    const conta = (i) => ['preco', 'url', 'imagem', 'marca', 'gtin', 'sku'].filter(c => i[c]).length
    if (conta(item) > conta(anterior)) vistos.set(chave, item)
  }
  return [...vistos.values()]
}

/**
 * Roda a escada inteira e devolve os resultados junto com o relatório de qual
 * estratégia funcionou — o teste de compatibilidade vive desse relatório.
 */
export function extrairResultados (html, urlBase, seletores = null) {
  const raiz = parse(html)
  const relatorio = { estrategias: {}, escolhida: null, temEstruturado: false }

  const tentativas = [
    ['jsonld', () => extrairJsonLd(raiz, urlBase)],
    ['estado', () => extrairEstado(raiz, urlBase)],
    ['microdata', () => extrairMicrodata(raiz, urlBase)],
    ['seletores', () => extrairPorSeletores(raiz, urlBase, seletores)],
    ['heuristica', () => extrairHeuristica(raiz, urlBase)]
  ]

  const resultados = {}
  for (const [nome, fn] of tentativas) {
    let itens = []
    try { itens = fn() } catch (erro) { relatorio.estrategias[nome] = { erro: erro.message, itens: 0 }; continue }
    itens = deduplicar(itens).filter(i => i.nome && i.nome.length > 4)
    const comPreco = itens.filter(i => i.preco !== null && i.preco !== undefined)
    relatorio.estrategias[nome] = { itens: itens.length, comPreco: comPreco.length }
    resultados[nome] = comPreco.length ? comPreco : itens
  }

  // Qual estratégia usar não é "quem achou mais": varredura de estado costuma
  // achar o triplo de itens e pegar o preço errado — todos iguais, sem link.
  // Então quantidade é multiplicada por qualidade medida no próprio resultado.
  const ordem = ['jsonld', 'estado', 'microdata', 'seletores', 'heuristica']
  const CONFIANCA = { jsonld: 1.35, microdata: 1.25, seletores: 1.15, estado: 1.0, heuristica: 0.95 }
  // Item sem link é quase inútil: não dá para abrir o anúncio nem reencontrá-lo
  // depois. Por isso a contagem que vale é a de itens com preço *e* endereço;
  // só quando nenhuma estratégia traz link é que se conta o resto.
  const usaveisPor = {}
  for (const nome of ordem) {
    usaveisPor[nome] = (resultados[nome] || []).filter(i => i.preco && i.url).length
  }
  const alguemTemLink = Object.values(usaveisPor).some(n => n > 0)

  let escolhida = null
  for (const nome of ordem) {
    const itens = resultados[nome] || []
    const comPreco = itens.filter(i => i.preco)
    if (!comPreco.length) continue
    const q = qualidade(itens, comPreco)
    const base = alguemTemLink ? usaveisPor[nome] : comPreco.length
    if (!base) continue
    const pontos = base * q.fator * CONFIANCA[nome]
    relatorio.estrategias[nome] = {
      ...relatorio.estrategias[nome],
      comLink: usaveisPor[nome],
      qualidade: Number(q.fator.toFixed(2)),
      pontos: Math.round(pontos)
    }
    if (!escolhida || pontos > escolhida.pontos) {
      escolhida = { nome, itens, comPreco: comPreco.length, pontos, qualidade: q }
    }
  }
  if (!escolhida) {
    for (const nome of ordem) {
      if ((resultados[nome] || []).length) { escolhida = { nome, itens: resultados[nome], comPreco: 0 }; break }
    }
  }

  relatorio.escolhida = escolhida ? escolhida.nome : null
  relatorio.temEstruturado = ['jsonld', 'microdata'].includes(relatorio.escolhida) ||
    (escolhida ? escolhida.itens.some(i => i.gtin || i.sku || i.marca) : false)

  return {
    itens: escolhida ? escolhida.itens : [],
    relatorio,
    raiz
  }
}

/**
 * Extração da página de um produto — mais rica que a da listagem: é onde
 * costumam aparecer EAN/GTIN, MPN e ficha técnica.
 */
export function extrairProduto (html, urlBase) {
  const raiz = parse(html)
  // Cupom e desconto à vista ficam fora do preço anunciado: a Amazon mostra
  // "Cupom de 10% aplicado" ao lado de um preço que ainda não desconta nada.
  // Quem procura oportunidade quer saber quanto sai de verdade.
  const porJsonLd = extrairJsonLd(raiz, urlBase)
  const porMicro = extrairMicrodata(raiz, urlBase)
  const base = porJsonLd[0] || porMicro[0] || null

  const ficha = {}
  for (const linha of selecionarTodos(raiz, 'tr')) {
    const celulas = linha.filhos.filter(f => f.tipo === 'elemento' && (f.tag === 'td' || f.tag === 'th'))
    if (celulas.length === 2) {
      const chave = textoLimpo(celulas[0]).replace(/:$/, '')
      const valor = textoLimpo(celulas[1])
      if (chave && valor && chave.length < 60 && valor.length < 200) ficha[chave] = valor
    }
  }

  const textoTodo = textoLimpo(raiz)
  const ean = textoTodo.match(/\b(?:ean|gtin|c[óo]digo de barras)\s*:?\s*(\d{8,14})\b/i)
  // Condição e parcelamento vêm sempre da leitura da página, mesmo quando o
  // preço veio do JSON-LD: o dado estruturado traz só o número.
  const daPagina = escolherPreco(raiz, { preferirPrimeiro: true })
  const precos = base && base.preco ? { ...daPagina, preco: base.preco } : daPagina

  return {
    nome: base ? base.nome : textoLimpo(selecionarTodos(raiz, 'h1')[0]),
    preco: base && base.preco ? base.preco : precos.preco,
    precoDe: precos.precoDe || null,
    disponivel: base ? base.disponivel : null,
    marca: base ? base.marca : (ficha.Marca || ficha.marca || ''),
    modelo: base ? base.modelo : (ficha.Modelo || ''),
    sku: base ? base.sku : (ficha.SKU || ficha.Código || ''),
    mpn: base ? base.mpn : (ficha.MPN || ''),
    gtin: (base && base.gtin) || (ean ? ean[1] : ''),
    imagem: base ? base.imagem : melhorImagem(raiz, urlBase),
    ficha,
    // Cupom e desconto à vista ficam FORA do preço anunciado: a Amazon mostra
    // "Cupom de 10% aplicado" ao lado de um preço que não desconta nada. Quem
    // procura oportunidade precisa saber quanto sai de verdade.
    condicao: precos.condicao || null,
    parcelamento: precos.parcelamento || null,
    descontos: descontosDaPagina(raiz, base && base.preco ? base.preco : precos.preco, precos.condicao),
    fonte: base ? base.fonte : 'pagina'
  }
}

/** Refaz o resumo tirando o desconto à vista, mantendo o cupom. */
function recalcularSemAVista (resumo, preco) {
  const cupom = resumo.cupons.find(c => c.aplicado) || resumo.cupons[0] || null
  if (!cupom) return null
  const melhorPreco = aplicarCupom(preco, cupom)
  const quanto = cupom.tipo === 'percentual'
    ? `${cupom.valor}% de cupom`
    : `R$ ${cupom.valor} de cupom`
  return {
    ...resumo,
    descontoAVista: null,
    melhorPreco,
    comoChegou: `${reaisSimples(melhorPreco)} com ${quanto}`
  }
}

function reaisSimples (v) {
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function descontosDaPagina (raiz, preco, condicao) {
  try {
    const resumo = resumirDescontos(raiz, Number.isFinite(preco) ? preco : null)
    if (!resumo) return null
    // Se o preço anunciado JÁ é o do Pix — a Amazon escreve "R$ 3.514,05 à
    // vista no Pix" — descontar de novo os 5% do Pix seria contar duas vezes e
    // prometer um preço que a loja não cobra.
    if (resumo.descontoAVista && /pix|à vista/i.test(condicao || '')) {
      return recalcularSemAVista(resumo, preco)
    }
    if (!resumo.cupons.length && !resumo.descontoAVista) return null
    return resumo
  } catch {
    return null   // desconto é bônus; nunca pode derrubar a leitura do produto
  }
}
