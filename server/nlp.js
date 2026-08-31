// Interpretação da consulta.
//
// O usuário digita "RTX 5070 Gigabyte 12GB" e não informa que "Gigabyte" é
// marca, "RTX 5070" é modelo e "12GB" é especificação. Quem descobre é isto
// aqui — e é o que decide, depois, o que é obrigatório num anúncio para ele
// poder ser considerado o mesmo produto.
//
// Decisão de escopo de 11/08/2026: consulta que é SÓ uma marca ("Apple") fica
// fora por enquanto. Marca continua valendo como qualificador ("Cafeteira
// Oster"). O bloqueio está em `interpretar()` e é devolvido com motivo.

export function semAcento (txt) {
  return String(txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function normalizar (txt) {
  return semAcento(String(txt || '').toLowerCase())
    // Aspas curvas viram aspas retas ANTES da limpeza: a limpeza apagava o ”
    // e, com ele, o tamanho de tela dos anúncios (14” virava só "14").
    .replace(/[”“„]/g, '"')
    .replace(/[^\w\s.,+"'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Forma compacta: "rtx 5070" e "rtx5070" viram a mesma coisa. */
export function compacto (txt) {
  return normalizar(txt).replace(/[\s.-]+/g, '')
}

const MARCAS = [
  // hardware / informática
  'gigabyte', 'asus', 'msi', 'zotac', 'evga', 'galax', 'pny', 'palit', 'sapphire', 'powercolor',
  'xfx', 'intel', 'amd', 'nvidia', 'corsair', 'kingston', 'crucial', 'adata', 'xpg', 'seagate',
  'western digital', 'wd', 'samsung', 'sandisk', 'logitech', 'razer', 'hyperx', 'redragon',
  'husky', 'pichau', 'rise mode', 'thermaltake', 'cooler master', 'noctua', 'deepcool', 'nzxt',
  'aoc', 'lg', 'benq', 'acer', 'dell', 'alienware', 'lenovo', 'hp', 'apple', 'positivo', 'vaio',
  'multilaser', 'tp-link', 'intelbras', 'mercusys', 'ubiquiti', 'asrock', 'biostar', 'gainward',
  // eletro / casa
  'oster', 'philips', 'walita', 'philips walita', 'electrolux', 'brastemp', 'consul', 'mondial',
  'britania', 'arno', 'cadence', 'delonghi', "de'longhi", 'nespresso', 'dolce gusto', 'tramontina',
  'panasonic', 'midea', 'springer', 'gree', 'fischer', 'atlas', 'itatiaia', 'esmaltec', 'nescafe',
  // celulares / eletrônicos
  'motorola', 'xiaomi', 'realme', 'sony', 'jbl',
  'anker', 'baseus', 'edifier', 'tcl', 'philco', 'aiwa', 'roku', 'amazon',
  // esporte / vestuário
  'nike', 'adidas', 'puma', 'olympikus', 'mizuno', 'asics', 'fila', 'new balance', 'under armour',
  'oakley', 'havaianas', 'vans', 'converse', 'reebok', 'topper', 'penalty'
]

const CATEGORIAS = [
  'cafeteira', 'cafeteira expresso', 'notebook', 'monitor', 'placa de video', 'placa mae',
  'processador', 'memoria ram', 'ssd', 'hd', 'fonte', 'gabinete', 'water cooler', 'cooler',
  'teclado', 'mouse', 'mousepad', 'headset', 'fone', 'fone de ouvido', 'caixa de som', 'webcam',
  'impressora', 'roteador', 'smartphone', 'celular', 'tablet', 'smartwatch', 'relogio',
  'televisao', 'tv', 'smart tv', 'geladeira', 'fogao', 'cooktop', 'micro-ondas', 'microondas',
  'lava-loucas', 'lava louças', 'maquina de lavar', 'lavadora', 'secadora', 'ar condicionado',
  'ventilador', 'aspirador', 'robo aspirador', 'liquidificador', 'batedeira', 'air fryer',
  'fritadeira', 'sanduicheira', 'panela', 'panela de pressao', 'jogo de panelas', 'chaleira',
  'torradeira', 'forno', 'purificador', 'tenis', 'camiseta', 'bermuda', 'jaqueta', 'mochila',
  'bicicleta', 'esteira', 'halter', 'cadeira gamer', 'cadeira de escritorio', 'mesa',
  'furadeira', 'parafusadeira', 'serra', 'lixadeira', 'compressor', 'multimetro', 'console',
  'controle', 'jogo', 'placa de captura', 'nobreak', 'estabilizador', 'filtro de linha'
]

// Linha de produto não é marca, mas revela a marca — e continua sendo palavra
// obrigatória no anúncio. "iPhone 17" é Apple; "Redmi Note 13" é Xiaomi.
const LINHAS = {
  iphone: 'apple', ipad: 'apple', macbook: 'apple', imac: 'apple', airpods: 'apple',
  watch: null, galaxy: 'samsung', redmi: 'xiaomi', poco: 'xiaomi', zenfone: 'asus',
  vivobook: 'asus', zenbook: 'asus', tuf: 'asus', rog: 'asus', thinkpad: 'lenovo',
  ideapad: 'lenovo', legion: 'lenovo', loq: 'lenovo', inspiron: 'dell', vostro: 'dell',
  latitude: 'dell', xps: 'dell', nitro: 'acer', predator: 'acer', aspire: 'acer',
  pavilion: 'hp', omen: 'hp', victus: 'hp', moto: 'motorola', nespresso: 'nespresso',
  playstation: 'sony', ps5: 'sony', xbox: 'microsoft', switch: 'nintendo'
}

const PARA_IGNORAR = new Set(['de', 'da', 'do', 'com', 'para', 'e', 'a', 'o', 'em', 'no', 'na',
  'por', 'ou', 'the', 'novo', 'nova'])

// Palavras que descrevem a unidade ou a categoria do atributo, não o produto.
// Se virarem exigência, cortam anúncios certos: nenhuma loja escreve "13
// polegadas" por extenso — todas usam 13" ou 13”.
const PALAVRAS_FRACAS = new Set(['polegadas', 'polegada', 'pol', 'gb', 'tb', 'mb', 'ram',
  'ssd', 'hd', 'memoria', 'armazenamento', 'tela', 'display', 'versao', 'geracao', 'ger',
  'ano', 'modelo', 'cor', 'unidade', 'unidades', 'produto', 'oficial', 'original',
  'lacrado', 'nacional', 'garantia', 'nf', 'nota', 'fiscal'])

// "12gb", "256 gb", "1tb", "127v", "27 polegadas", "4k", "ddr5", "500ml"
// "192bits" é barramento de memória, não modelo — sem `bits` aqui, ele entrava
// na identidade do produto e fazia placas diferentes virarem a mesma.
// As aspas curvas (”) contam como polegada: quase toda loja escreve 14” e não
// 14". Sem isso, o tamanho de tela do anúncio passava despercebido.
// O fim usa `(?![a-z0-9])` em vez de `\b`: depois de uma aspa não existe
// limite de palavra, então `14”` nunca casava e o tamanho de tela sumia.
const RE_SPEC = /\b(\d+(?:[.,]\d+)?)\s*(gb|tb|mb|ghz|mhz|bits|bit|w|v|hz|ml|l|kg|g|mm|cm|pol|polegadas|["”“]|k|p)(?![a-z0-9])/gi
const RE_SPEC_SECA = /\b(ddr\d|4k|8k|full hd|fhd|uhd|qhd|wifi\s?6e?|usb\s?c|type\s?c|bivolt|110v|127v|220v)\b/gi
const RE_MODELO = /\b([a-z]{0,6}\d{2,6}[a-z0-9]{0,6})\b/gi

/**
 * Num título de anúncio o fabricante quase sempre vem antes: "Notebook Asus
 * Vivobook ... Intel Core i3" é Asus, não Intel. Por isso a posição no texto
 * pesa mais que o tamanho do nome da marca.
 */
function acharMarca (txt) {
  const n = ' ' + normalizar(txt) + ' '
  const c = compacto(txt)
  let melhor = null
  for (const marca of MARCAS) {
    const nm = normalizar(marca)
    const escapada = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const casamento = n.match(new RegExp(`(^|\\s)${escapada}(\\s|$)`))
    let posicao = casamento ? casamento.index : -1
    if (posicao < 0 && nm.length >= 5 && c.includes(compacto(marca))) posicao = c.indexOf(compacto(marca)) + 1000
    if (posicao < 0) continue
    if (!melhor || posicao < melhor.posicao || (posicao === melhor.posicao && nm.length > melhor.marca.length)) {
      melhor = { marca, posicao }
    }
  }
  return melhor ? melhor.marca : null
}

function acharCategoria (txt) {
  const n = ' ' + normalizar(txt) + ' '
  let melhor = null
  for (const cat of CATEGORIAS) {
    const nc = normalizar(cat)
    if (n.includes(' ' + nc + ' ') || n.includes(' ' + nc + 's ')) {
      if (!melhor || nc.length > normalizar(melhor).length) melhor = cat
    }
  }
  return melhor
}

/**
 * No Brasil, 110V, 115V, 120V e 127V são a mesma tomada — lojas escrevem de
 * todo jeito. Sem normalizar, o mesmo aparelho anunciado como "110V" na
 * Carrefour e "127 v" na Amazon virava dois produtos diferentes.
 */
function normalizarVoltagem (spec) {
  const m = String(spec).match(/^(\d{2,3})v$/)
  if (!m) return spec
  const v = Number(m[1])
  if (v >= 100 && v <= 130) return '127v'
  if (v >= 200 && v <= 250) return '220v'
  return spec
}

function acharSpecs (txt) {
  const specs = new Set()
  const n = normalizar(txt)
  for (const m of n.matchAll(RE_SPEC)) {
    const unidade = m[2].toLowerCase().replace('polegadas', 'pol').replace('"', 'pol')
    specs.add(normalizarVoltagem(`${m[1].replace(',', '.')}${unidade}`))
  }
  for (const m of n.matchAll(RE_SPEC_SECA)) specs.add(normalizarVoltagem(m[1].replace(/\s+/g, '')))
  return [...specs]
}

/**
 * Devolve [{ c, t }] — `c` é a forma compacta usada para casar ("rtx5070") e
 * `t` é como o usuário escreveu ("rtx 5070"), que é o que se manda para a
 * busca da loja: buscador de loja odeia termo grudado.
 */
function acharModelos (txt, marca, specs) {
  const n = normalizar(txt)
  const specsCompactas = new Set(specs.map(compacto))
  const porCompacto = new Map()
  const anotar = (c, t) => { if (!porCompacto.has(c)) porCompacto.set(c, t) }

  const tokensMarca = new Set(marca ? tokensDe(marca) : [])
  for (const m of n.matchAll(RE_MODELO)) {
    const bruto = m[1]
    if (specsCompactas.has(compacto(bruto))) continue
    if (/^\d{1,2}$/.test(bruto)) continue                    // "2 unidades"
    if (/^\d+$/.test(bruto) && bruto.length < 3) continue    // "27" é medida, não modelo
    if (marca && compacto(marca).includes(compacto(bruto))) continue
    if (/^(19|20)\d{2}$/.test(bruto)) continue               // ano
    anotar(compacto(bruto), bruto)
  }
  // Junta prefixo de linha com número: "rtx 5070" -> rtx5070, exibido "rtx 5070".
  // Não junta quando o prefixo é a própria marca ("aoc 27") — aí o número é medida.
  for (const par of (n.match(/\b([a-z]{2,8})\s+(\d{2,5}[a-z]{0,3})\b/g) || [])) {
    const [pref, num] = par.split(/\s+/)
    if (PARA_IGNORAR.has(pref) || tokensMarca.has(pref)) continue
    if (specsCompactas.has(compacto(num))) continue
    porCompacto.delete(compacto(num))
    anotar(pref + compacto(num), `${pref} ${num}`)
  }
  return [...porCompacto].map(([c, t]) => ({ c, t }))
}

function acharLinha (txt) {
  const tokens = new Set(tokensDe(txt))
  for (const [linha, marca] of Object.entries(LINHAS)) {
    if (tokens.has(linha)) return { linha, marca }
  }
  return null
}

export function tokensDe (txt) {
  return normalizar(txt).split(/[\s,]+/).filter(t => t.length > 1 && !PARA_IGNORAR.has(t))
}

/**
 * Interpreta a consulta do usuário.
 * Devolve { tipo, marca, categoria, modelos, specs, obrigatorios, termosBusca, aceita, motivo }
 */
export function interpretar (texto) {
  const original = String(texto || '').trim()
  const n = normalizar(original)
  if (!n) {
    return { aceita: false, motivo: 'Escreva o que você quer acompanhar.', tipo: 'vazia', termosBusca: [] }
  }

  const linha = acharLinha(original)
  const marca = acharMarca(original) || (linha && linha.marca) || null
  const categoria = acharCategoria(original)
  const specs = acharSpecs(original)
  const paresModelo = acharModelos(original, marca, specs)
  const modelos = paresModelo.map(p => p.c)
  const modelosTexto = paresModelo.map(p => p.t)
  const tokens = tokensDe(original)

  const tokensMarca = marca ? new Set(tokensDe(marca)) : new Set()
  const sobra = tokens.filter(t => !tokensMarca.has(t))

  let tipo = 'termo'
  if (marca && !sobra.length) tipo = 'marca'
  else if (modelos.length && (marca || linha)) tipo = 'produto'
  else if (modelos.length) tipo = 'modelo'
  else if (categoria && marca) tipo = 'produto+marca'
  else if (categoria) tipo = 'categoria'
  else if (marca) tipo = 'produto+marca'

  // ---- decisão de escopo: marca sozinha fica fora por enquanto
  if (tipo === 'marca') {
    return {
      aceita: false,
      tipo,
      marca,
      categoria: null,
      modelos: [],
      specs: [],
      obrigatorios: [],
      termosBusca: [],
      motivo: `Busca só pela marca "${cap(marca)}" está fora do escopo por enquanto — ela devolve o ` +
        'catálogo inteiro da marca em cada loja, a cada rodada, e é onde o custo e o ruído explodem. ' +
        `Acrescente o que você procura: "Notebook ${cap(marca)}", "Fone ${cap(marca)}", ` +
        `"${cap(marca)} + modelo".`
    }
  }

  // ---- o que um anúncio precisa ter para ser candidato
  const obrigatorios = []
  for (const m of modelos) obrigatorios.push({ tipo: 'modelo', valor: m })
  for (const s of specs) obrigatorios.push({ tipo: 'spec', valor: s })
  if (linha) obrigatorios.push({ tipo: 'linha', valor: linha.linha })

  // Palavra que sobrou depois de identificar marca, categoria, modelo e specs
  // é palavra que o usuário escolheu de propósito — "Máxima" em "cafeteira
  // oster maxima" é o nome da linha do produto. Ela vira exigência: sem isso,
  // a busca devolvia a Oster inteira, porque marca e categoria batiam em tudo.
  const cobertas = new Set([
    ...(marca ? tokensDe(marca) : []),
    ...(categoria ? tokensDe(categoria) : []),
    ...(linha ? [linha.linha] : []),
    ...specs.map(s => normalizar(s)),
    ...modelos,
    ...modelosTexto.flatMap(t => tokensDe(t))
  ])
  const palavrasChave = tokens.filter(t => {
    if (cobertas.has(t) || /^\d+$/.test(t)) return false
    if (PALAVRAS_FRACAS.has(t)) return false          // unidade, não identidade
    if (modelos.some(m => m.includes(t))) return false
    if (specs.some(s => compacto(s).includes(t))) return false
    // "m5", "m4", "i7" têm duas letras e são o que mais identifica o produto —
    // o corte por tamanho jogava fora justamente o chip do MacBook.
    if (t.length < 3) return /^[a-z]\d[a-z]?$/.test(t)
    return true
  })
  for (const palavra of palavrasChave) obrigatorios.push({ tipo: 'palavra', valor: palavra })

  // ---- variações de busca a mandar para as lojas
  const termos = new Set()
  termos.add(original)
  // Termo curto: linha/marca + as palavras que identificam ("macbook pro m5").
  // Busca de loja engasga com frase longa — e loja que busca por JavaScript
  // costuma devolver recomendação genérica quando não entende o texto inteiro.
  const curto = [linha ? linha.linha : marca, ...palavrasChave].filter(Boolean).join(' ').trim()
  if (curto && curto.split(/\s+/).length >= 2) termos.add(curto)
  if (marca && modelosTexto.length) termos.add(`${modelosTexto.join(' ')} ${marca}`)
  if (modelosTexto.length) termos.add(modelosTexto.join(' '))
  if (categoria && marca) termos.add(`${categoria} ${marca}`)
  if (categoria && !marca) termos.add(categoria)
  if (marca && categoria && specs.length) termos.add(`${categoria} ${marca} ${specs[0]}`)
  const termosBusca = [...termos]
    .map(t => t.trim())
    .filter(Boolean)
    .filter((t, i, arr) => arr.findIndex(o => compacto(o) === compacto(t)) === i)
    .slice(0, 3)

  return {
    aceita: true,
    motivo: null,
    tipo,
    marca: marca || null,
    linha: linha ? linha.linha : null,
    categoria: categoria || null,
    modelos,
    modelosTexto,
    specs,
    tokens,
    palavrasChave,
    obrigatorios,
    termosBusca,
    especificidade: pontuarEspecificidade({ marca, categoria, modelos, specs, tokens, palavrasChave })
  }
}

/** 0 = muito ampla, 100 = anúncio único. Regula rigor da correspondência. */
function pontuarEspecificidade ({ marca, categoria, modelos, specs, tokens, palavrasChave = [] }) {
  let p = 0
  if (categoria) p += 20
  if (marca) p += 20
  p += Math.min(modelos.length, 2) * 22
  p += Math.min(specs.length, 3) * 8
  p += Math.min(tokens.length, 6) * 2
  // Palavra exigida restringe tanto quanto um modelo: "ninja creami" não é
  // busca ampla, é busca por um produto específico cujo nome não tem número.
  p += Math.min(palavrasChave.length, 2) * 14
  return Math.min(100, p)
}

function cap (t) {
  return String(t).replace(/(^|\s)\S/g, c => c.toUpperCase())
}

export const _interno = { MARCAS, CATEGORIAS, acharMarca, acharCategoria, acharSpecs, acharModelos }
