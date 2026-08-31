// Parser de HTML e motor de seletores, escritos aqui de propósito.
//
// Por que não usar uma biblioteca: o protótipo roda sem `npm install` nenhum,
// então nada quebra por dependência offline ou versão. E como a extração
// precisa de coisas que biblioteca genérica não dá de graça — achar blocos
// repetidos que "parecem cartão de produto", medir densidade de preço —
// controlar o parser vale mais do que reaproveitar um.
//
// Não é um parser de HTML completo (não trata namespaces, entidades exóticas
// nem reconstrói tabelas malformadas). É tolerante a erro, que é o que importa
// para ler HTML de loja no mundo real.

const VAZIAS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'])
const TEXTO_CRU = new Set(['script', 'style', 'textarea', 'title'])
// Elementos que fecham implicitamente quando outro do mesmo tipo abre.
const AUTOFECHA = {
  li: new Set(['li']),
  p: new Set(['p', 'div', 'section', 'article', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  tr: new Set(['tr']),
  option: new Set(['option']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd'])
}

const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', aacute: 'á', acirc: 'â', atilde: 'ã', agrave: 'à',
  eacute: 'é', ecirc: 'ê', iacute: 'í', oacute: 'ó', ocirc: 'ô', otilde: 'õ',
  uacute: 'ú', ccedil: 'ç', Aacute: 'Á', Atilde: 'Ã', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Otilde: 'Õ', Uacute: 'Ú', Ccedil: 'Ç', reg: '®', copy: '©', deg: '°'
}

export function decodificar (texto) {
  if (!texto || !texto.includes('&')) return texto || ''
  return texto.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (todo, corpo) => {
    if (corpo[0] === '#') {
      const cod = corpo[1] === 'x' || corpo[1] === 'X'
        ? parseInt(corpo.slice(2), 16)
        : parseInt(corpo.slice(1), 10)
      return Number.isFinite(cod) ? String.fromCodePoint(cod) : todo
    }
    return ENTIDADES[corpo] !== undefined ? ENTIDADES[corpo] : todo
  })
}

function criarElemento (tag, attrs) {
  return { tipo: 'elemento', tag, attrs, filhos: [], pai: null }
}

export function parse (html) {
  const raiz = criarElemento('#raiz', {})
  const pilha = [raiz]
  const topo = () => pilha[pilha.length - 1]
  let i = 0

  const texto = (t) => {
    if (!t) return
    topo().filhos.push({ tipo: 'texto', valor: t, pai: topo() })
  }

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) { texto(html.slice(i)); break }
    if (lt > i) texto(html.slice(i, lt))

    if (html.startsWith('<!--', lt)) {
      const fim = html.indexOf('-->', lt + 4)
      i = fim < 0 ? html.length : fim + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const fim = html.indexOf('>', lt)
      i = fim < 0 ? html.length : fim + 1
      continue
    }
    if (html.startsWith('</', lt)) {
      const fim = html.indexOf('>', lt)
      if (fim < 0) { i = html.length; continue }
      const tag = html.slice(lt + 2, fim).trim().toLowerCase()
      // Fecha subindo até achar a tag; se não existir, ignora (HTML quebrado).
      for (let k = pilha.length - 1; k > 0; k--) {
        if (pilha[k].tag === tag) { pilha.length = k; break }
      }
      i = fim + 1
      continue
    }
    if (!/[a-zA-Z]/.test(html[lt + 1] || '')) { texto('<'); i = lt + 1; continue }

    const aberta = lerTagAberta(html, lt)
    if (!aberta) { texto('<'); i = lt + 1; continue }
    const { tag, attrs, fim, autofechada } = aberta
    i = fim

    const pai = topo()
    if (AUTOFECHA[pai.tag] && AUTOFECHA[pai.tag].has(tag)) pilha.pop()

    const el = criarElemento(tag, attrs)
    el.pai = topo()
    topo().filhos.push(el)

    if (TEXTO_CRU.has(tag)) {
      const alvo = new RegExp(`</${tag}\\s*>`, 'i')
      const resto = html.slice(i)
      const achou = resto.match(alvo)
      const conteudo = achou ? resto.slice(0, achou.index) : resto
      if (conteudo) el.filhos.push({ tipo: 'texto', valor: conteudo, pai: el })
      i += achou ? achou.index + achou[0].length : resto.length
      continue
    }
    if (!VAZIAS.has(tag) && !autofechada) pilha.push(el)
  }
  return raiz
}

function lerTagAberta (html, inicio) {
  let i = inicio + 1
  const inicioNome = i
  while (i < html.length && /[a-zA-Z0-9:-]/.test(html[i])) i++
  const tag = html.slice(inicioNome, i).toLowerCase()
  if (!tag) return null
  const attrs = {}
  let autofechada = false

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++
    if (html[i] === '>') { i++; break }
    if (html[i] === '/' && html[i + 1] === '>') { autofechada = true; i += 2; break }
    if (i >= html.length) break

    const inicioAttr = i
    while (i < html.length && !/[\s=>/]/.test(html[i])) i++
    const nome = html.slice(inicioAttr, i).toLowerCase()
    if (!nome) { i++; continue }

    while (i < html.length && /\s/.test(html[i])) i++
    let valor = ''
    if (html[i] === '=') {
      i++
      while (i < html.length && /\s/.test(html[i])) i++
      const aspas = html[i]
      if (aspas === '"' || aspas === "'") {
        const fim = html.indexOf(aspas, i + 1)
        valor = fim < 0 ? html.slice(i + 1) : html.slice(i + 1, fim)
        i = fim < 0 ? html.length : fim + 1
      } else {
        const inicioValor = i
        while (i < html.length && !/[\s>]/.test(html[i])) i++
        valor = html.slice(inicioValor, i)
      }
    } else {
      valor = nome
    }
    attrs[nome] = decodificar(valor)
  }
  return { tag, attrs, fim: i, autofechada }
}

// ---------------------------------------------------------------- travessia

export function * elementos (no) {
  for (const filho of no.filhos || []) {
    if (filho.tipo === 'elemento') {
      yield filho
      yield * elementos(filho)
    }
  }
}

export function texto (no) {
  if (!no) return ''
  if (no.tipo === 'texto') return no.valor
  if (no.tag === 'script' || no.tag === 'style') return ''
  let saida = ''
  for (const filho of no.filhos || []) saida += texto(filho)
  return saida
}

export function textoLimpo (no) {
  return decodificar(texto(no)).replace(/\s+/g, ' ').trim()
}

export function attr (no, nome) {
  return no && no.attrs ? (no.attrs[nome] || '') : ''
}

export function classes (no) {
  return attr(no, 'class').split(/\s+/).filter(Boolean)
}

export function profundidade (no) {
  let n = 0
  let atual = no
  while (atual && atual.pai) { n++; atual = atual.pai }
  return n
}

export function assinatura (no) {
  // Identifica "o mesmo tipo de bloco" repetido na página: tag + classes
  // estáveis (descarta as que carregam id/hash, comuns em CSS-in-JS).
  const cls = classes(no)
    .filter(c => c.length > 2 && !/\d{3,}/.test(c))
    .slice(0, 3)
    .sort()
  return no.tag + (cls.length ? '.' + cls.join('.') : '')
}

// ---------------------------------------------------- seletores (subconjunto)
// Suporta: tag, .classe, #id, [attr], [attr=v], [attr*=v], [attr^=v], [attr$=v],
// descendente (espaço), filho direto (>) e grupos separados por vírgula.

function compilarComposto (txt) {
  const partes = { tag: null, classes: [], id: null, attrs: [] }
  const re = /([.#]?[\w-]+)|\[([\w-]+)(?:([*^$|~]?=)"?'?([^\]"']*)"?'?)?\]/g
  let m
  while ((m = re.exec(txt))) {
    if (m[1]) {
      if (m[1][0] === '.') partes.classes.push(m[1].slice(1))
      else if (m[1][0] === '#') partes.id = m[1].slice(1)
      else partes.tag = m[1].toLowerCase()
    } else if (m[2]) {
      partes.attrs.push({ nome: m[2].toLowerCase(), op: m[3] || null, valor: m[4] || '' })
    }
  }
  return partes
}

function casaComposto (no, c) {
  if (c.tag && no.tag !== c.tag) return false
  if (c.id && attr(no, 'id') !== c.id) return false
  if (c.classes.length) {
    const cls = classes(no)
    for (const need of c.classes) if (!cls.includes(need)) return false
  }
  for (const a of c.attrs) {
    const v = attr(no, a.nome)
    if (!a.op) { if (!(a.nome in (no.attrs || {}))) return false; continue }
    if (a.op === '=' && v !== a.valor) return false
    if (a.op === '*=' && !v.includes(a.valor)) return false
    if (a.op === '^=' && !v.startsWith(a.valor)) return false
    if (a.op === '$=' && !v.endsWith(a.valor)) return false
  }
  return true
}

function compilar (seletor) {
  return seletor.split(',').map(grupo => {
    const passos = []
    for (const token of grupo.trim().split(/\s+/)) {
      if (token === '>') { passos.push({ combinador: 'filho' }); continue }
      if (token.startsWith('>')) {
        passos.push({ combinador: 'filho' })
        passos.push({ composto: compilarComposto(token.slice(1)) })
        continue
      }
      passos.push({ composto: compilarComposto(token) })
    }
    // Normaliza para pares [composto, combinadorAntesDele]
    const cadeia = []
    let combinador = 'descendente'
    for (const p of passos) {
      if (p.combinador) { combinador = p.combinador; continue }
      cadeia.push({ composto: p.composto, combinador })
      combinador = 'descendente'
    }
    return cadeia
  }).filter(c => c.length)
}

function casaCadeia (no, cadeia) {
  let idx = cadeia.length - 1
  if (!casaComposto(no, cadeia[idx].composto)) return false
  const comb = cadeia[idx].combinador
  idx--
  if (idx < 0) return true
  if (comb === 'filho') return no.pai ? casaCadeia(no.pai, cadeia.slice(0, idx + 1)) : false
  let pai = no.pai
  while (pai) {
    if (casaCadeia(pai, cadeia.slice(0, idx + 1))) return true
    pai = pai.pai
  }
  return false
}

export function selecionarTodos (raiz, seletor) {
  const cadeias = compilar(seletor)
  if (!cadeias.length) return []
  const achados = []
  for (const el of elementos(raiz)) {
    for (const cadeia of cadeias) {
      if (casaCadeia(el, cadeia)) { achados.push(el); break }
    }
  }
  return achados
}

export function selecionar (raiz, seletor) {
  return selecionarTodos(raiz, seletor)[0] || null
}
