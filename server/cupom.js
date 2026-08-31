// Cupons e desconto à vista embutidos na página do produto.
//
// O problema real: a Amazon (e lojas parecidas) mostram um selo do tipo
// "Cupom: Cupom de 10% de desconto aplicado" bem ao lado do preço, mas o
// preço que `extract.js` lê NÃO inclui esse desconto — é só texto solto no
// HTML, não um cálculo. Este módulo lê esse texto e calcula o preço real.
//
// Mesma filosofia do resto do núcleo (ver `html.js`): nada de biblioteca,
// e a leitura é sobre texto visível de verdade, não sobre uma classe CSS
// específica de uma loja — porque a classe muda a cada troca de layout e o
// texto ("cupom", "%", "R$") não muda.
//
// Três armadilhas que o texto de loja arma de propósito ou por acidente:
//   1. Parcelamento ("10x de R$ 50") parece desconto em R$ mas não é.
//   2. Desconto à vista / Pix ("5% off à vista no Pix") não é cupom: é uma
//      forma de pagamento, e some se o cliente paga no cartão.
//   3. Cashback e frete grátis têm número do lado mas não abatem o preço
//      mostrado nem exigem cupom nenhum.
// A função `acharCupons` existe para NÃO cair em nenhuma das três.

import { elementos, textoLimpo, attr, decodificar } from './html.js'
import { pathToFileURL } from 'node:url'

// ------------------------------------------------------------------ texto

// Troca acentuada por não-acentuada preservando o tamanho da string (um
// caractere por um caractere), para que os índices batam com o texto
// original quando for preciso recortar um trecho depois.
const MAPA_ACENTOS = {
  á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u',
  ç: 'c'
}

function semAcento (s) {
  return String(s || '').replace(/[áàâãäéèêëíìîïóòôõöúùûüç]/gi, (ch) => {
    const baixo = ch.toLowerCase()
    const troca = MAPA_ACENTOS[baixo] || baixo
    return ch === baixo ? troca : troca.toUpperCase()
  })
}

// Leitor de número tolerante ao formato brasileiro (igual em espírito ao
// `lerPreco` de `extract.js`, mas este arquivo não importa de lá de
// propósito — cupom.js fica de pé sozinho, só com `html.js`).
function lerNumero (txt) {
  if (txt === null || txt === undefined) return null
  const limpo = String(txt).trim()
  if (!limpo) return null
  const brasileiro = limpo.match(/(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})/)
  if (brasileiro) {
    const n = parseFloat(brasileiro[1].replace(/\./g, '').replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  const milhar = limpo.match(/\d{1,3}(?:\.\d{3})+(?!\d)/)
  if (milhar) {
    const n = parseFloat(milhar[0].replace(/\./g, ''))
    return Number.isFinite(n) ? n : null
  }
  const simples = limpo.match(/\d+(?:[.,]\d{1,2})?/)
  if (simples) {
    const n = parseFloat(simples[0].replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

// Como `textoLimpo` concatena nós de texto sem separador nenhum, "Cupom"
// num <span> seguido de "R$ 50..." no <span> vizinho vira "CupomR$ 50..." —
// e a palavra "cupom" deixa de bater na fronteira de palavra (\b). Esta
// versão junta cada nó de texto com um espaço, só para a checagem de
// contexto (a extração do valor continua usando o texto original do nó).
function textoComEspacos (no) {
  if (!no) return ''
  const partes = []
  const andar = (n) => {
    if (n.tipo === 'texto') { partes.push(n.valor); return }
    if (n.tag === 'script' || n.tag === 'style') return
    for (const f of n.filhos || []) andar(f)
  }
  andar(no)
  return decodificar(partes.join(' ')).replace(/\s+/g, ' ').trim()
}

function formatarBRL (n) {
  return `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatarNumero (n) {
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
}

// -------------------------------------------------------------- candidatos

// Reúne trechos de texto curtos o bastante para serem um selo de cupom: o
// texto visível de elementos-folha (sem filho-elemento, do mesmo jeito que
// `coletarPrecos` faz em extract.js), `title`/`aria-label` de qualquer
// elemento, e o texto de contêineres pequenos cuja classe já denuncia que
// ali mora um selo de desconto. Varrer só isso em vez da página inteira
// evita o custo de calcular `textoLimpo` (que percorre a subárvore toda)
// em cada um dos milhares de elementos de uma página real.
const CLASSE_SELO = /cupom|coupon|desconto|discount|promo|badge/i

function candidatos (raiz) {
  const vistos = new Set()
  const lista = []
  const add = (texto, el) => {
    const t = (texto || '').trim()
    if (!t || t.length < 3 || t.length > 220) return
    if (vistos.has(t)) return
    vistos.add(t)
    lista.push({ texto: t, el })
  }
  for (const el of elementos(raiz)) {
    const folha = !el.filhos.some(f => f.tipo === 'elemento')
    if (folha) add(textoLimpo(el), el)
    const titulo = attr(el, 'title')
    if (titulo) add(titulo, el)
    const ariaLabel = attr(el, 'aria-label')
    if (ariaLabel) add(ariaLabel, el)
    if (!folha && CLASSE_SELO.test(attr(el, 'class'))) {
      const txt = textoLimpo(el)
      if (txt.length <= 220) add(txt, el)
    }
  }
  return lista
}

// ---------------------------------------------------------------- padrões

const RE_CUPOM_PALAVRA = /\bcupo(m|ns)\b|\bcoupon\b/
const RE_PAGAMENTO = /\bvista\b|\bpix\b|\bboleto\b/
const RE_CASHBACK = /cashback|de volta\b|dinheiro de volta/
const RE_PARCELA = /\d{1,2}\s*x\s*(de\s*)?(r\$\s*)?\d/
const RE_PERCENTUAL = /(-?\d{1,2}(?:[.,]\d{1,2})?)\s*%/g

// Extração de valor em R$ é de propósito mais restrita que a de preço em
// `extract.js`: um "R$" solto perto da palavra "cupom" costuma ser o preço
// FINAL ("Você paga R$ 3.329,00 com o cupom"), não o tamanho do desconto.
// Só conta como valor do cupom quando o texto liga R$ e desconto de um
// jeito inequívoco: "cupom de R$ 50", "R$ 50 de desconto", "desconto de
// R$ 50" ou "economize R$ 50".
const NUM = '(\\d{1,3}(?:\\.\\d{3})*(?:,\\d{2})?|\\d+,\\d{2}|\\d+)'
const RE_VALOR_CUPOM = new RegExp(
  `cupom\\s+de\\s+r\\$\\s*${NUM}` +
  `|r\\$\\s*${NUM}\\s+de\\s+desconto` +
  `|desconto\\s+de\\s+r\\$\\s*${NUM}` +
  `|economiz\\w*\\s+r\\$\\s*${NUM}`,
  'gi'
)

function calcAplicado (normTexto) {
  // "Aplicar cupom de 5%" é botão de ação: ainda não está no preço.
  if (/\baplicar\b/.test(normTexto)) return false
  // "Cupom de 10% de desconto aplicado" já foi selecionado pela loja.
  if (/aplicad[oa]/.test(normTexto)) return true
  // Sem verbo nenhum ("Economize 10% com cupom"), assume que não está no
  // preço mostrado — é a suposição mais segura para quem quer saber quanto
  // vai pagar de verdade.
  return false
}

function extrairCondicao (texto) {
  const m = texto.match(/(v[aá]lido[^.,;]*|compra m[ií]nima[^.,;]*|para (?:produtos|itens) selecionados[^.,;]*|ao finalizar a compra[^.,;]*|acima de\s*R\$\s*[\d.,]+[^.,;]*)/i)
  return m ? m[0].trim() : null
}

// Um contêiner de selo às vezes junta duas coisas na mesma string: o texto
// do badge ("...de desconto aplicado") e o do controle abaixo dele
// ("Aplicar cupom de 10%"), que fala do mesmo valor em dois estados
// diferentes. Olhar só as ~40 letras ao redor de CADA número (em vez do
// texto inteiro) faz cada ocorrência carregar o "aplicado"/"aplicar" que
// é realmente dela.
function aplicadoPertoDe (texto, indice) {
  const inicio = Math.max(0, indice - 40)
  const fim = Math.min(texto.length, indice + 40)
  return calcAplicado(semAcento(texto.slice(inicio, fim).toLowerCase()))
}

function registrar (achados, vistos, tipo, valor, texto, normTexto, aplicado) {
  const chave = tipo + '|' + valor + '|' + normTexto.slice(0, 120)
  if (vistos.has(chave)) return
  vistos.add(chave)
  achados.push({
    tipo,
    valor,
    texto,
    aplicado,
    condicao: extrairCondicao(texto)
  })
}

/**
 * Acha cupons de desconto mencionados na página (percentual ou em R$).
 *
 * Um trecho só vira cupom se a palavra "cupom"/"coupon" aparecer nele ou —
 * caso da loja separar o rótulo do valor em elementos diferentes, tipo
 * "Cupom" num <span> e "R$ 50 de desconto" no de baixo — no pai ou avô
 * dele. Isso é o que impede confundir "10x de R$ 50" (parcelamento),
 * "5% off à vista no Pix" (forma de pagamento) e "5% de cashback" (não é
 * desconto no preço) com um cupom de verdade.
 */
export function acharCupons (raiz, opcoes = {}) {
  const limite = opcoes.limite || 20
  const achados = []
  const vistos = new Set()

  for (const { texto, el } of candidatos(raiz)) {
    const normTexto = semAcento(texto.toLowerCase())

    if (RE_CASHBACK.test(normTexto)) continue
    if (/\bfrete\b/.test(normTexto) && !RE_CUPOM_PALAVRA.test(normTexto)) continue
    if (RE_PAGAMENTO.test(normTexto)) continue // "à vista"/"Pix"/"boleto": ver acharDescontoAVista
    if (RE_PARCELA.test(normTexto)) continue // "10x de R$ 50": parcelamento, não cupom

    let temCupom = RE_CUPOM_PALAVRA.test(normTexto)
    if (!temCupom) {
      const pai = el.pai
      const avo = pai && pai.pai
      const contexto = semAcento((
        (pai ? textoComEspacos(pai) : '') + ' ' + (avo ? textoComEspacos(avo) : '')
      ).toLowerCase()).slice(0, 300)
      if (!RE_CUPOM_PALAVRA.test(contexto)) continue
      // Ainda precisa parecer desconto, não qualquer número perto da
      // palavra "cupom" (ex.: um código alfanumérico do cupom).
      if (!/desconto|off\b|economiz/.test(normTexto)) continue
      temCupom = true
    }

    RE_PERCENTUAL.lastIndex = 0
    const percentuais = [...texto.matchAll(RE_PERCENTUAL)]
    for (const m of percentuais) {
      const valor = Math.abs(parseFloat(m[1].replace(',', '.')))
      if (valor > 0 && valor <= 90) {
        registrar(achados, vistos, 'percentual', valor, texto, normTexto, aplicadoPertoDe(texto, m.index))
      }
    }

    // Só procura valor em R$ se não achou percentual nesse trecho — evita
    // ler duas vezes o mesmo cupom quando o texto cita os dois formatos.
    if (!percentuais.length) {
      RE_VALOR_CUPOM.lastIndex = 0
      for (const m of texto.matchAll(RE_VALOR_CUPOM)) {
        const bruto = m[1] || m[2] || m[3] || m[4]
        const valor = lerNumero(bruto)
        if (valor && valor > 0 && valor < 100000) {
          registrar(achados, vistos, 'valor', valor, texto, normTexto, aplicadoPertoDe(texto, m.index))
        }
      }
    }
  }

  return achados.slice(0, limite)
}

/**
 * Aplica um cupom a um preço. Sem cupom, devolve o preço original; nunca
 * deixa o resultado negativo (cupom de R$ maior que o preço zera, não
 * inverte o sinal).
 */
export function aplicarCupom (preco, cupom) {
  if (preco === null || preco === undefined || !Number.isFinite(preco)) return preco
  if (!cupom || !cupom.tipo) return Number(preco.toFixed(2))
  let resultado = preco
  if (cupom.tipo === 'percentual') resultado = preco * (1 - cupom.valor / 100)
  else if (cupom.tipo === 'valor') resultado = preco - cupom.valor
  return Number(Math.max(0, resultado).toFixed(2))
}

/**
 * Acha desconto de pagamento à vista ("5% off à vista no Pix", "-5% no
 * boleto"). É deliberadamente separado de `acharCupons`: um cupom precisa
 * ser aplicado/resgatado, desconto à vista é automático na forma de
 * pagamento — por isso nunca soma os dois como se fossem a mesma coisa.
 */
export function acharDescontoAVista (raiz) {
  for (const { texto } of candidatos(raiz)) {
    const normTexto = semAcento(texto.toLowerCase())
    if (RE_CUPOM_PALAVRA.test(normTexto)) continue // isso é cupom, não desconto à vista
    if (!RE_PAGAMENTO.test(normTexto)) continue
    const m = normTexto.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*%/)
    if (!m) continue
    const valor = parseFloat(m[1].replace(',', '.'))
    if (!(valor > 0 && valor <= 50)) continue
    let forma = 'à vista'
    if (/\bpix\b/.test(normTexto)) forma = 'pix'
    else if (/\bboleto\b/.test(normTexto)) forma = 'boleto'
    return { percentual: valor, forma }
  }
  return null
}

/**
 * Junta cupom e desconto à vista num preço final só. A regra de combinação
 * é a que evita otimismo: aplica o melhor cupom primeiro (o que resulta no
 * menor preço), depois o desconto à vista SOBRE o resultado — nunca soma
 * dois cupons entre si.
 */
export function resumirDescontos (raiz, precoBase) {
  const cupons = acharCupons(raiz)
  const descontoAVista = acharDescontoAVista(raiz)
  const temBase = Number.isFinite(precoBase)

  let melhorCupom = null
  if (cupons.length && temBase) {
    melhorCupom = cupons.reduce((melhor, atual) => {
      if (!melhor) return atual
      return aplicarCupom(precoBase, atual) < aplicarCupom(precoBase, melhor) ? atual : melhor
    }, null)
  }

  let melhorPreco = temBase ? precoBase : null
  if (melhorPreco !== null && melhorCupom) melhorPreco = aplicarCupom(melhorPreco, melhorCupom)
  if (melhorPreco !== null && descontoAVista) {
    melhorPreco = Number(Math.max(0, melhorPreco * (1 - descontoAVista.percentual / 100)).toFixed(2))
  }

  const partes = []
  if (melhorCupom) {
    partes.push(melhorCupom.tipo === 'percentual'
      ? `${formatarNumero(melhorCupom.valor)}% de cupom`
      : `${formatarBRL(melhorCupom.valor)} de cupom`)
  }
  if (descontoAVista) {
    const sufixo = descontoAVista.forma === 'pix' ? ' no Pix' : descontoAVista.forma === 'boleto' ? ' no boleto' : ''
    partes.push(`${formatarNumero(descontoAVista.percentual)}% à vista${sufixo}`)
  }
  const comoChegou = melhorPreco !== null
    ? formatarBRL(melhorPreco) + (partes.length ? ` com ${partes.join(' e ')}` : '')
    : null

  return {
    precoBase: temBase ? precoBase : null,
    cupons,
    descontoAVista,
    melhorPreco,
    comoChegou
  }
}

// ------------------------------------------------------------------ autoteste

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { parse } = await import('./html.js')

  let ok = 0
  let total = 0
  const checar = (nome, cond) => {
    total++
    if (cond) { ok++; console.log(`✓ ${nome}`) } else { console.log(`✗ ${nome}`) }
  }

  const raizDe = (html) => parse(`<div>${html}</div>`)

  // 1. cupom percentual, já aplicado
  {
    const raiz = raizDe('<span>Cupom de 10% de desconto aplicado</span>')
    const cupons = acharCupons(raiz)
    checar('cupom de 10% de desconto aplicado', cupons.length === 1 &&
      cupons[0].tipo === 'percentual' && cupons[0].valor === 10 && cupons[0].aplicado === true)
  }

  // 2. cupom percentual em title, "no cupom"
  {
    const raiz = raizDe('<div title="10% de desconto no cupom">ver oferta</div>')
    const cupons = acharCupons(raiz)
    checar('10% de desconto no cupom (via title)', cupons.length === 1 &&
      cupons[0].tipo === 'percentual' && cupons[0].valor === 10)
  }

  // 3. cupom em R$
  {
    const raiz = raizDe('<span>Cupom de R$ 50</span>')
    const cupons = acharCupons(raiz)
    checar('cupom de R$ 50', cupons.length === 1 &&
      cupons[0].tipo === 'valor' && cupons[0].valor === 50)
  }

  // 4. R$ 50 de desconto, separado do rótulo "Cupom" num elemento vizinho
  {
    const raiz = raizDe('<div><span>Cupom</span><span>R$ 50 de desconto</span></div>')
    const cupons = acharCupons(raiz)
    checar('R$ 50 de desconto (rótulo cupom no elemento pai)', cupons.some(c =>
      c.tipo === 'valor' && c.valor === 50))
  }

  // 5. "Aplicar cupom de 5%" - ação pendente, não aplicado
  {
    const raiz = raizDe('<button>Aplicar cupom de 5%</button>')
    const cupons = acharCupons(raiz)
    checar('aplicar cupom de 5% (ainda não aplicado)', cupons.length === 1 &&
      cupons[0].valor === 5 && cupons[0].aplicado === false)
  }

  // 6. "-10% com cupom"
  {
    const raiz = raizDe('<span>-10% com cupom</span>')
    const cupons = acharCupons(raiz)
    checar('-10% com cupom', cupons.length === 1 && cupons[0].valor === 10)
  }

  // 7. parcelamento não é cupom
  {
    const raiz = raizDe('<span>10x de R$ 50,00 sem juros</span>')
    const cupons = acharCupons(raiz)
    checar('parcelamento (10x de R$ 50) NÃO é cupom', cupons.length === 0)
  }

  // 8. desconto à vista no Pix não é cupom, mas é achado por acharDescontoAVista
  {
    const raiz = raizDe('<span>5% off à vista no Pix</span>')
    const cupons = acharCupons(raiz)
    const avista = acharDescontoAVista(raiz)
    checar('5% à vista no Pix não vira cupom', cupons.length === 0)
    checar('5% à vista no Pix é achado como desconto à vista', avista &&
      avista.percentual === 5 && avista.forma === 'pix')
  }

  // 9. cashback não é cupom
  {
    const raiz = raizDe('<span>5% de cashback</span>')
    const cupons = acharCupons(raiz)
    checar('cashback NÃO é cupom', cupons.length === 0)
  }

  // 10. frete grátis não é cupom
  {
    const raiz = raizDe('<span>Frete grátis para todo o Brasil</span>')
    const cupons = acharCupons(raiz)
    checar('frete grátis NÃO é cupom', cupons.length === 0)
  }

  // 11. aplicarCupom: percentual, valor em R$, sem cupom e nunca negativo
  checar('aplicarCupom percentual: 100 - 10% = 90', aplicarCupom(100, { tipo: 'percentual', valor: 10 }) === 90)
  checar('aplicarCupom valor: 100 - R$ 30 = 70', aplicarCupom(100, { tipo: 'valor', valor: 30 }) === 70)
  checar('aplicarCupom sem cupom devolve o preço original', aplicarCupom(100, null) === 100)
  checar('aplicarCupom nunca fica negativo', aplicarCupom(20, { tipo: 'valor', valor: 500 }) === 0)

  // 12. resumirDescontos combina cupom (primeiro) e à vista (depois), sem somar cupons
  {
    const raiz = raizDe('<span>Cupom de 10% de desconto aplicado</span><span>5% off à vista no Pix</span>')
    const resumo = resumirDescontos(raiz, 200)
    const esperado = Number((200 * 0.9 * 0.95).toFixed(2)) // 171.00
    checar('resumirDescontos combina cupom + à vista na ordem certa', resumo.melhorPreco === esperado &&
      resumo.comoChegou === `${formatarBRL(esperado)} com 10% de cupom e 5% à vista no Pix`)
  }

  console.log(`\nPlacar: ${ok}/${total}`)
  if (ok !== total) process.exitCode = 1
}
