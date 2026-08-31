// Correspondência: decidir se um anúncio é o que o usuário procura, e se dois
// anúncios de lojas diferentes são o mesmo produto.
//
// É o item que a nota do vault chama de coração do produto. A ordem de
// prioridade é a da spec: EAN/GTIN, depois MPN, depois atributos técnicos,
// depois dado estruturado da loja, depois comparação de texto. IA entraria só
// no que sobra ambíguo — o gancho existe em `precisaDeDesempate()` e hoje
// resolve por heurística, sem chamar modelo nenhum.

import { normalizar, compacto, tokensDe, _interno } from './nlp.js'

const { acharMarca, acharCategoria, acharSpecs } = _interno

// Marcas de anúncio importado, cujo preço exibido não é o que se paga: falta
// imposto de importação e frete internacional.
const INTERNACIONAL = ['importado', 'importada', 'versao internacional', 'versão internacional',
  'global version', 'international version', 'envio do exterior', 'produto importado',
  'imported', 'eu plug', 'us plug', 'plugue americano', 'plug americano']

// Palavras que denunciam acessório do produto, não o produto.
const ACESSORIOS = ['suporte', 'capa', 'case ', 'capinha', 'pelicula', 'película', 'cabo',
  'adaptador', 'carregador', 'fonte para', 'bateria para', 'protetor', 'skin', 'adesivo',
  'bolsa', 'estojo', 'filtro para', 'refil', 'kit de limpeza', 'porta ', 'organizador',
  'mousepad', 'base para', 'mesa para', 'bag', 'sleeve', 'controle remoto para',
  // impressora 3D tem um ecossistema inteiro de acessório que usa o nome dela
  'gabinete', 'enclosure', 'bandeja', 'bico ', 'nozzle', 'hotend', 'placa de construcao',
  'filamento', 'spool', 'ventilacao', 'ventilação',
  // peças e consumíveis: o que aparece quando se procura por eletrodoméstico
  'pote', 'potes', 'tampa', 'tampas', 'reposicao', 'reposição', 'acessorio', 'acessório',
  'pacote com', 'unidades', 'peças de', 'pecas de', 'compativel com', 'compatível com',
  'manual do', 'guia de', 'receitas', 'livro',
  // Livro de receita da marca é a armadilha da Amazon: uma busca por "ninja
  // creami" devolvia 16 livros e 2 máquinas. Como os livros eram maioria, nem
  // o filtro de preço salvava — a mediana virava preço de livro.
  'cookbook', 'cook book', 'recipe', 'recipes', 'receituario', 'receituário',
  'ebook', 'e-book', 'kindle', 'paperback', 'hardcover', 'edicao revisada',
  'beginners', 'guide to', 'guia completo', 'livre de recettes', 'recettes']

const USADOS = ['usado', 'seminovo', 'semi-novo', 'recondicionado', 'vitrine', 'outlet',
  'reembalado', 'open box', 'com avaria', 'defeito', 'para retirada de peças']

// Sufixos que mudam o produto: RTX 5070 e RTX 5070 Ti não são a mesma placa.
// "OC" ficou fora de propósito — é overclock de fábrica do mesmo chip, e quem
// procura "RTX 5070" quer ver as OC também.
const SUFIXOS_COLADOS = ['ti', 'super', 'xt', 'xtx', 's']
const VARIANTES_SOLTAS = ['ti', 'super', 'xt', 'xtx', 'pro', 'max', 'plus', 'ultra', 'mini', 'air']

// Marketplace costuma pôr o *vendedor* no campo de marca — a KaBuM devolve
// "FLER EQUIPAMENTOS E INTERMEDIACAO DE NEGOCIOS LTDA" como brand de uma placa
// Gigabyte. Quando o campo tem cara de razão social, ou quando o título revela
// uma marca conhecida, o título ganha.
const RAZAO_SOCIAL = /(ltda|s\.?a\.?$|eireli|mei\b|comercio|comércio|industria|indústria|distribuidora|importacao|importação|servicos|serviços|intermedia|negocios|negócios|me\b|epp\b)/i
// Campos que a loja preenche quando não sabe a marca. Virava chip "Não Informado".
const MARCA_VAZIA = /^(n[ãa]o informad[oa]|sem marca|generic[oa]?|outros?|diversos?|marca)$/i

export function marcaConfiavel (item, loja = null) {
  const doTitulo = acharMarca(item.nome || '')
  const daLoja = String(item.marca || '').trim()
  if (doTitulo) return doTitulo
  if (!daLoja) return ''
  if (RAZAO_SOCIAL.test(daLoja) || MARCA_VAZIA.test(daLoja.trim()) || daLoja.length > 28) return ''
  // A loja NÃO é a marca. A KaBuM! preenche o campo de marca com "KaBuM" em
  // parte do catálogo, e isso vazava para a identidade do produto: o mesmo
  // MacBook Pro virava `marca:kabum` de um lado e `marca:apple` do outro, e os
  // dois nunca se encontravam. Resultado visível: dois cartões idênticos, cada
  // um com a mesma oferta da Go Imports contada como se fossem lojas
  // diferentes.
  if (loja && ehNomeDaLoja(daLoja, loja)) return ''
  return daLoja
}

function ehNomeDaLoja (marca, loja) {
  const limpar = (t) => String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '')
  const m = limpar(marca)
  if (!m) return false
  if (m === limpar(loja.nome)) return true
  // Também compara com o domínio: "goimports" bate com goimports.com.br.
  const host = limpar(String(loja.host || loja.origem || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0])
  return Boolean(host) && m === host
}

/**
 * Palavra exigida está no anúncio? Aceita diferença de uma letra em palavras
 * de 5+ caracteres, porque "expresso" e "espresso" convivem nas lojas e
 * exigir grafia exata reprovaria o produto certo.
 */
function contemPalavra (tokensTitulo, tituloComp, palavra) {
  if (tokensTitulo.has(palavra) || tituloComp.includes(palavra)) return true
  if (palavra.length < 5) return false
  for (const t of tokensTitulo) {
    if (Math.abs(t.length - palavra.length) > 1) continue
    if (distanciaAte1(t, palavra)) return true
  }
  return false
}

/** Levenshtein truncado: só responde se a distância é 0 ou 1. */
function distanciaAte1 (a, b) {
  if (a === b) return true
  const [curta, longa] = a.length <= b.length ? [a, b] : [b, a]
  if (longa.length - curta.length > 1) return false
  let i = 0
  let j = 0
  let erros = 0
  while (i < curta.length && j < longa.length) {
    if (curta[i] === longa[j]) { i++; j++; continue }
    if (++erros > 1) return false
    if (curta.length === longa.length) { i++; j++ } else { j++ }
  }
  return erros + (longa.length - j) + (curta.length - i) <= 1
}

export function similaridade (a, b) {
  const ta = new Set(tokensDe(a))
  const tb = new Set(tokensDe(b))
  if (!ta.size || !tb.size) return 0
  let comuns = 0
  for (const t of ta) if (tb.has(t)) comuns++
  const jaccard = comuns / (ta.size + tb.size - comuns)
  const cobertura = comuns / Math.min(ta.size, tb.size)
  return 0.45 * jaccard + 0.55 * cobertura
}

/**
 * Procura o modelo respeitando limite de palavra — grudar o título inteiro
 * ("rtx507012gventus") faz "12g" parecer sufixo de variante e derruba anúncio
 * certo. Aqui a busca é por token e por par de tokens vizinhos, porque a loja
 * escreve tanto "RTX 5070" quanto "RTX5070".
 *
 * Devolve { achou, variante } — `variante` é o sufixo que muda o produto
 * (o "Ti" de RTX 5070 Ti), quando existir.
 */
function acharModeloNoTitulo (tituloNorm, modelo) {
  // Quebra por qualquer pontuação: "RTX 5070 Ti, W11" tem que virar
  // [...,'rtx','5070','ti','w11'] — com a vírgula grudada, o "ti" deixa de ser
  // reconhecido como variante e um anúncio de 5070 Ti passaria por 5070.
  const tokens = tituloNorm.split(/[^a-z0-9]+/i).filter(Boolean)
  let variante = null
  for (let i = 0; i < tokens.length; i++) {
    for (const [texto, proximoIdx] of [[tokens[i], i + 1], [tokens[i] + (tokens[i + 1] || ''), i + 2]]) {
      if (!texto.startsWith(modelo)) continue
      const resto = texto.slice(modelo.length)
      if (resto) {
        const colado = SUFIXOS_COLADOS.find(s => resto === s)
        if (colado) { variante = variante || colado; continue }
        continue // "rtx50701" não é o modelo, é outro número
      }
      const seguinte = tokens[proximoIdx]
      const solta = seguinte && VARIANTES_SOLTAS.includes(seguinte) ? seguinte : null
      if (!solta) return { achou: true, variante: null }
      variante = variante || solta
    }
  }
  return { achou: Boolean(variante), variante }
}

function specsDoTitulo (titulo) {
  return acharSpecs(titulo)
}

// O degrau "atributos técnicos" da spec. Num notebook, memória e SSD não
// bastam: Ryzen 5, Core i3 e Celeron são três produtos diferentes com o mesmo
// nome de linha, mesma marca e mesma quantidade de RAM.
const RE_PROCESSADOR = /\b(ryzen\s*[3579]|core\s*i[3579]|core\s*ultra\s*[579]|celeron|athlon|pentium|snapdragon|dimensity|apple\s*m[1234])\b/gi

export function processadoresDoTitulo (titulo) {
  const achados = new Set()
  for (const m of normalizar(titulo).matchAll(RE_PROCESSADOR)) {
    achados.add(m[1].replace(/\s+/g, ''))
  }
  return [...achados]
}

/** Duas listas de specs brigam entre si? 8GB de um lado, 16GB do outro. */
function specsConflitam (a = [], b = []) {
  const unidade = (s) => (String(s).match(/[a-z"]+$/i) || [''])[0]
  const unidades = new Set([...a, ...b].map(unidade).filter(Boolean))
  for (const u of unidades) {
    const setA = a.filter(s => unidade(s) === u)
    const setB = b.filter(s => unidade(s) === u)
    if (!setA.length || !setB.length) continue
    // "GB" serve para RAM e para armazenamento ao mesmo tempo, então um
    // anúncio citar 4GB e o outro citar 4GB + 128GB não é divergência: é o
    // segundo sendo mais detalhado. Só briga quando nenhum contém o outro.
    const aContemB = setB.every(s => setA.includes(s))
    const bContemA = setA.every(s => setB.includes(s))
    if (!aContemB && !bContemA) return true
  }
  return false
}

/** Mesma unidade, valor diferente: 12GB pedido, 16GB no anúncio. */
function conflitoDeSpec (specsConsulta, specsItem) {
  const unidade = (s) => (String(s).match(/[a-z"]+$/i) || [''])[0]
  for (const pedida of specsConsulta) {
    const u = unidade(pedida)
    if (!u || u === 'v') continue                    // voltagem some do título direto demais
    const mesmasUnidades = specsItem.filter(s => unidade(s) === u)
    if (!mesmasUnidades.length) continue
    if (!mesmasUnidades.includes(pedida)) return { pedida, achadas: mesmasUnidades }
  }
  return null
}

/**
 * Pontua um anúncio contra a consulta interpretada.
 * Devolve { score 0-100, aceito, motivos[], alerta }.
 */
export function pontuar (interp, item, config = {}) {
  const limiarBase = config.limiarAceite ?? 62
  const titulo = String(item.nome || '')
  const tituloNorm = normalizar(titulo)
  const tituloComp = compacto(titulo)
  const consultaComp = compacto([interp.marca, ...(interp.modelosTexto || []), ...(interp.specs || []),
    interp.categoria].filter(Boolean).join(' '))
  const motivos = []
  let score = 0

  // ---------------------------------------------------------- eliminatórias
  const usado = USADOS.find(u => tituloNorm.includes(u))
  if (usado) return { score: 0, aceito: false, motivos: [`anúncio de ${usado}`], eliminado: true }

  // Anúncio importado: o preço da tela não é o preço final.
  //
  // A Amazon lista vendedor internacional junto com o nacional, e ali o valor
  // exibido ainda vai receber imposto de importação e frete internacional —
  // que podem passar de 90% do produto. Comparar esse número com o de uma loja
  // brasileira é comparar coisas diferentes, e um comparador que faz isso está
  // mentindo mesmo com o número certo.
  //
  // Some do comparativo em vez de aparecer com ressalva: quem procura preço
  // quer saber quanto vai pagar, e esse número o anúncio não dá.
  const importado = INTERNACIONAL.find(t => tituloNorm.includes(t))
  if (importado) {
    return {
      score: 0,
      aceito: false,
      motivos: [`anúncio importado ("${importado}") — o preço não inclui imposto de importação`],
      eliminado: true
    }
  }

  const acessorio = ACESSORIOS.find(a => tituloNorm.includes(normalizar(a)))
  const pediuAcessorio = acessorio && normalizar(interp.tokens ? interp.tokens.join(' ') : '').includes(normalizar(acessorio).trim())
  if (acessorio && !pediuAcessorio) {
    return { score: 0, aceito: false, motivos: [`parece acessório ("${acessorio.trim()}")`], eliminado: true }
  }

  // "PARA" é o acessório se anunciando.
  //
  // Nenhuma lista de palavras dá conta: "TopCube Gabinete Para Impressora 3D
  // Bambu Lab A1 Combo" tem todas as palavras da busca e passava direto, virando
  // um produto com preço de R$ 919 no lugar de uma impressora de R$ 5.500.
  //
  // O padrão é da língua, não do catálogo: acessório se descreve como "X PARA
  // Y", e o que a pessoa procurou é o Y. Quando as palavras da busca só
  // aparecem DEPOIS do "para", o anúncio é de outra coisa — a menos que a
  // própria busca tenha um "para" (alguém procurando "capa para iphone").
  const marcador = tituloNorm.match(/\b(para|compativel com|compatível com)\b/)
  // Quem procurou "capa para iphone" quer mesmo o acessório: nesse caso a
  // regra não vale. A busca já foi interpretada, então a pista está nos tokens.
  const buscaTemPara = /\b(para|compativel|acessorio|capa|suporte|gabinete)\b/
    .test(normalizar((interp.tokens || []).join(' ')))
  if (marcador && !buscaTemPara) {
    const antes = tituloNorm.slice(0, marcador.index)
    const depois = tituloNorm.slice(marcador.index)
    const chaves = (interp.tokens || []).filter(t => t.length > 1)
    // Contar dos dois lados, e não exigir "nenhuma antes": em "Combo De
    // Impressora 3d Unitak3d PARA Bambu Lab A1 Combo", a palavra "combo"
    // aparece dos dois lados e sozinha derrubava a regra. O que denuncia o
    // acessório é o produto procurado estar concentrado DEPOIS do "para".
    const naFrente = chaves.filter(t => antes.includes(t)).length
    const atras = chaves.filter(t => depois.includes(t)).length
    if (atras >= 2 && atras > naFrente) {
      return {
        score: 0,
        aceito: false,
        motivos: [`é acessório "para" o produto, não o produto`],
        eliminado: true
      }
    }
  }

  const tokensConsultaSet = new Set(interp.tokens || [])
  const tokensTitulo = new Set(tituloNorm.split(/[^a-z0-9]+/i).filter(Boolean))
  for (const obrig of interp.obrigatorios || []) {
    if (obrig.tipo === 'modelo') {
      const achado = acharModeloNoTitulo(tituloNorm, obrig.valor)
      if (!achado.achou) {
        return { score: 0, aceito: false, motivos: [`não traz o modelo ${obrig.valor}`], eliminado: true }
      }
      // Anúncio é de uma variante (Ti, XT, Pro) que a consulta não pediu.
      if (achado.variante && !tokensConsultaSet.has(achado.variante) && !consultaComp.includes(obrig.valor + achado.variante)) {
        return {
          score: 0,
          aceito: false,
          eliminado: true,
          motivos: [`é a versão ${achado.variante.toUpperCase()} de ${obrig.valor}, não a que você pediu`]
        }
      }
      // O contrário: consulta pediu a variante e o anúncio é a versão base.
      const pedidaNaConsulta = VARIANTES_SOLTAS.find(v => tokensConsultaSet.has(v))
      if (pedidaNaConsulta && !achado.variante && !tokensTitulo.has(pedidaNaConsulta)) {
        return {
          score: 0,
          aceito: false,
          eliminado: true,
          motivos: [`você pediu a versão ${pedidaNaConsulta.toUpperCase()} e este é o modelo base`]
        }
      }
      score += 26
      motivos.push(`modelo ${obrig.valor} confere`)
    }
    if (obrig.tipo === 'linha' && !tituloComp.includes(compacto(obrig.valor))) {
      return { score: 0, aceito: false, motivos: [`não é da linha ${obrig.valor}`], eliminado: true }
    }
    if (obrig.tipo === 'palavra') {
      if (!contemPalavra(tokensTitulo, tituloComp, obrig.valor)) {
        return { score: 0, aceito: false, motivos: [`não menciona "${obrig.valor}"`], eliminado: true }
      }
      score += 14
    }
  }

  const specsItem = specsDoTitulo(titulo)
  const conflito = conflitoDeSpec(interp.specs || [], specsItem)
  if (conflito) {
    return {
      score: 0,
      aceito: false,
      eliminado: true,
      motivos: [`pedido ${conflito.pedida}, anúncio traz ${conflito.achadas.join('/')}`]
    }
  }

  // ------------------------------------------------------------- pontuação
  const marcaItem = normalizar(marcaConfiavel(item))
  if (interp.marca) {
    // Quando a marca foi deduzida da linha ("macbook" → Apple), ver a linha no
    // título já confirma a marca: nenhuma loja escreve "Apple MacBook Pro 14”",
    // e cobrar a palavra "Apple" reprovava o produto certo.
    const linhaNoTitulo = interp.linha && tituloComp.includes(compacto(interp.linha))
    if (marcaItem && compacto(marcaItem).includes(compacto(interp.marca))) {
      score += 22
      motivos.push('marca confere')
    } else if (tituloComp.includes(compacto(interp.marca)) || linhaNoTitulo) {
      score += 18
      motivos.push(linhaNoTitulo ? `linha ${interp.linha} confere` : 'marca aparece no título')
    } else {
      score -= 12
      motivos.push('marca não aparece')
    }
  }

  for (const spec of interp.specs || []) {
    if (tituloComp.includes(compacto(spec))) { score += 8; motivos.push(`${spec} confere`) }
  }

  if (interp.categoria) {
    const catItem = acharCategoria(titulo) || (item.categoria ? acharCategoria(item.categoria) : null)
    if (catItem && (catItem === interp.categoria || catItem.includes(interp.categoria) || interp.categoria.includes(catItem))) {
      score += 16
      motivos.push('categoria confere')
    } else if (tituloComp.includes(compacto(interp.categoria))) {
      score += 12
    } else if (interp.tipo === 'categoria') {
      score -= 18
      motivos.push('categoria não confere')
    }
  }

  // Cobertura: quanto da consulta aparece no anúncio.
  const tokensConsulta = (interp.tokens || []).filter(t => t.length > 2)
  if (tokensConsulta.length) {
    const presentes = tokensConsulta.filter(t => tituloComp.includes(compacto(t))).length
    const cobertura = presentes / tokensConsulta.length
    score += Math.round(cobertura * 34)
    if (cobertura < 0.4) motivos.push('pouca semelhança com o que você pediu')
  }

  // Dado estruturado é sinal de anúncio bem descrito.
  if (item.gtin) { score += 6; motivos.push('anúncio traz EAN/GTIN') }
  else if (item.mpn) { score += 4 }

  score = Math.max(0, Math.min(100, Math.round(score)))

  // Consulta ampla não pode exigir o mesmo rigor de uma consulta específica.
  const limiar = interp.especificidade >= 55
    ? limiarBase
    : Math.round(limiarBase * (interp.especificidade >= 30 ? 0.8 : 0.62))

  return {
    score,
    limiar,
    aceito: score >= limiar,
    ambiguo: score >= limiar - 14 && score < limiar,
    motivos
  }
}

/**
 * Preço fora de esquadro denuncia o que o texto não denunciou: se a consulta é
 * específica e o item custa 15% da mediana dos aceitos, é brinde, acessório ou
 * anúncio errado. Só se aplica a consulta específica — categoria tem faixa
 * larga de preço por natureza.
 */
export function filtrarPorSanidadeDePreco (aceitos, interp) {
  // Consulta muito ampla ("cafeteira expresso") tem faixa de preço larga por
  // natureza e não pode ser filtrada assim. Da especificidade média para cima,
  // o filtro entra — com banda larga quando a consulta é menos específica.
  // Busca por um produto específico ("ninja creami") pode ter poucos
  // resultados e mesmo assim ter um intruso gritante — um livro de receitas de
  // R$ 200 no meio de máquinas de R$ 2.000. Com 3 itens já dá para ver isso.
  const minimoDeItens = interp.especificidade >= 55 ? 3 : ((interp.palavrasChave || []).length ? 3 : 6)
  if (interp.especificidade < 30 || aceitos.length < minimoDeItens) return { mantidos: aceitos, descartados: [] }
  const precos = aceitos.map(a => a.item.preco).filter(Boolean).sort((x, y) => x - y)
  if (precos.length < minimoDeItens) return { mantidos: aceitos, descartados: [] }
  const mediana = precos[Math.floor(precos.length / 2)]
  const largo = interp.especificidade < 55
  const poucos = precos.length < 5
  // Com poucos itens a mediana é frágil, então a banda é mais generosa nas
  // pontas — corta só o que está claramente fora de categoria.
  const piso = mediana * (poucos ? 0.3 : (largo ? 0.22 : 0.35))
  const teto = mediana * (poucos ? 3.6 : (largo ? 3.4 : 2.6))
  const mantidos = []
  const descartados = []
  for (const a of aceitos) {
    const p = a.item.preco
    if (p && (p < piso || p > teto)) {
      descartados.push({ ...a, motivoDescarte: `preço fora da faixa (mediana R$ ${mediana.toFixed(0)})` })
    } else {
      mantidos.push(a)
    }
  }
  return { mantidos, descartados, mediana }
}

/**
 * Identidade do produto — o que sobrevive à troca de anúncio e de URL.
 * `forte` diz se a chave é confiável o bastante para juntar anúncios de lojas
 * diferentes sem olhar mais nada.
 */
export function chaveProduto (item) {
  const titulo = String(item.nome || '')
  const marca = normalizar(marcaConfiavel(item))
  const specs = acharSpecs(titulo).sort()
  const modelosNaOrdem = extrairModelosDoTitulo(titulo, marca)
  const modelos = [...modelosNaOrdem].sort()
  // Todos os caminhos devolvem a mesma forma (marca, modelos, specs, cpus):
  // quem compara dois produtos conta com esses campos existirem sempre.
  const comum = { marca, modelos, specs, cpus: processadoresDoTitulo(titulo).sort(), linha: null }

  const gtin = String(item.gtin || '').replace(/\D/g, '')
  if (gtin.length >= 8) return { ...comum, chave: 'gtin:' + gtin, forte: true, base: 'EAN/GTIN' }

  if (item.mpn && String(item.mpn).length >= 4 && marca) {
    return { ...comum, chave: `mpn:${compacto(marca)}:${compacto(item.mpn)}`, forte: true, base: 'MPN' }
  }
  const cpus = processadoresDoTitulo(titulo).sort()
  if (modelos.length) {
    // A âncora da linha é o modelo PRINCIPAL (o primeiro na ordem em que foi
    // achado, não em ordem alfabética). Ancorar no alfabético fazia a linha de
    // "RTX 5070 WINDFORCE" ser lida como "dlss".
    //
    // E só vale quando esse modelo é distintivo de verdade: com âncora fraca,
    // "linha" vira a primeira palavra qualquer do título e cria conflito onde
    // não há — foi o que separou dois anúncios da mesma sorveteira.
    const ancora = modelosNaOrdem[0]
    const ancoraForte = ancora.length >= 5 && /\d{3,}/.test(ancora)
    const linha = ancoraForte ? linhaDepoisDoModelo(titulo, ancora) : null
    return {
      chave: `mod:${compacto(marca)}:${modelos.join('-')}:${specs.join('-')}:${linha || ''}:${cpus.join('-')}`,
      forte: true,
      base: linha ? 'marca + modelo + linha + specs' : 'marca + modelo + specs',
      marca,
      modelos,
      specs,
      linha,
      cpus
    }
  }
  const nucleo = tokensDe(titulo).filter(t => t.length > 2).slice(0, 6).sort().join('-')
  return {
    chave: `txt:${compacto(marca)}:${nucleo}:${cpus.join('-')}`,
    forte: false,
    base: 'texto do anúncio',
    marca,
    modelos: [],
    specs,
    cpus
  }
}

// Palavras que aparecem em todo anúncio da categoria e não distinguem nada.
// "gaming" ficou de fora desta lista de propósito: na Gigabyte, "Gaming OC" é
// linha de produto de verdade, e tratá-la como ruído fazia a Gaming virar a
// mesma placa que a WINDFORCE.
const RUIDO_LINHA = new Set(['oc', 'placa', 'video', 'geforce', 'nvidia', 'amd', 'radeon', 'intel',
  'gamer', 'notebook', 'com', 'para', 'de', 'da', 'do', 'ram', 'ssd', 'hd', 'ddr',
  'gddr', 'gddr6', 'gddr7', 'ddr4', 'ddr5', 'bits', 'core', 'dual', 'edition', 'nova', 'novo',
  'super', 'pro', 'max', 'ultra', 'lite', 'plus', 'ti',
  // nomes de processador não são linha de produto
  'ryzen', 'celeron', 'athlon', 'pentium', 'snapdragon', 'dimensity', 'silver', 'tela', 'memoria',
  // tecnologias e siglas de marketing que aparecem logo depois do modelo
  'dlss', 'ray', 'tracing', 'sff', 'wuxga', 'oled', 'ips', 'led', 'lcd', 'fhd', 'uhd', 'qhd',
  'wifi', 'bluetooth', 'rgb', 'ghz', 'mhz', 'bits', 'windows', 'linux', 'home', 'pro64'])

/**
 * A palavra logo depois do modelo costuma ser a linha do produto: EAGLE, AERO,
 * WINDFORCE, VENTUS, PRIME. Sem ela, "Gigabyte RTX 5070 Eagle" e "Gigabyte RTX
 * 5070 Aero" têm chave idêntica e viram o mesmo produto — e não são.
 */
function linhaDepoisDoModelo (titulo, modelo) {
  const tokens = normalizar(titulo).split(/[^a-z0-9]+/i).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const um = compacto(tokens[i])
    const dois = um + compacto(tokens[i + 1] || '')
    const bate = um.startsWith(modelo) ? i + 1 : (dois.startsWith(modelo) ? i + 2 : -1)
    if (bate < 0) continue
    for (let k = bate; k < Math.min(bate + 4, tokens.length); k++) {
      const t = tokens[k]
      if (!/^[a-z]{3,}$/i.test(t)) continue
      if (RUIDO_LINHA.has(t.toLowerCase())) continue
      // "AERO" e "AERO OC" são SKUs diferentes, com preços diferentes. Juntar
      // os dois inventa queda de preço — o pior erro possível aqui.
      const temOC = tokens.slice(k + 1, k + 3).some(x => x.toLowerCase() === 'oc')
      return t.toLowerCase() + (temOC ? '+oc' : '')
    }
    return null
  }
  return null
}

// 110, 127, 220… são voltagem, não modelo. Sem isso, "Creami 110V" gerava o
// modelo falso "creami110" e brigava com o "NC301" do mesmo aparelho.
const VOLTAGEM = /^(110|115|120|127|220|240)v?$/

function extrairModelosDoTitulo (titulo, marca) {
  const n = normalizar(titulo)
  const specs = new Set(acharSpecs(titulo).map(compacto))
  const achados = new Set()
  for (const m of n.matchAll(/\b([a-z]{0,6}\d{2,6}[a-z0-9]{0,5})\b/g)) {
    const v = compacto(m[1])
    if (specs.has(v)) continue
    if (/^\d{1,2}$/.test(v)) continue
    if (VOLTAGEM.test(v)) continue
    if (/^(19|20)\d{2}$/.test(v)) continue
    if (marca && compacto(marca).includes(v)) continue
    achados.add(v)
  }
  // Junta "rtx 5070" / "go 15". Estes entram na frente: prefixo + número é o
  // pedaço mais distintivo do título, e a lista é cortada logo abaixo — foi
  // por esse corte que "go15" sumia da chave e o mesmo notebook aparecia duas
  // vezes, uma por loja.
  const juntos = []
  for (const par of (n.match(/\b([a-z]{2,8})\s+(\d{2,5}[a-z]{0,3})\b/g) || [])) {
    const [pref, num] = par.split(/\s+/)
    if (specs.has(compacto(num))) continue
    if (VOLTAGEM.test(compacto(num))) continue
    if (marca && compacto(marca) === pref) continue
    if (RUIDO_LINHA.has(pref)) continue
    achados.delete(compacto(num))
    juntos.push(pref + compacto(num))
  }
  return [...new Set([...juntos, ...achados])].slice(0, 5)
}

/**
 * Dois anúncios são o mesmo produto? Ordem: GTIN, MPN, chave forte igual,
 * e só então semelhança de texto com confirmação por preço.
 */
export function mesmoProduto (a, b, opcoes = {}) {
  const ga = String(a.gtin || '').replace(/\D/g, '')
  const gb = String(b.gtin || '').replace(/\D/g, '')
  if (ga.length >= 8 && gb.length >= 8) {
    return { igual: ga === gb, confianca: 1, base: 'EAN/GTIN' }
  }
  const ka = chaveProduto(a)
  const kb = chaveProduto(b)
  if (ka.forte && kb.forte) {
    if (ka.chave === kb.chave) return { igual: true, confianca: 0.92, base: ka.base }

    // Duas lojas descrevem o mesmo notebook de jeitos diferentes: uma põe o
    // código "E1504FA" no título e a outra não. Chave idêntica é raro entre
    // lojas — então, quando as chaves são fortes mas diferentes, ainda vale
    // comparar por dentro: mesma marca, algum modelo em comum, nenhuma spec
    // conflitante e preço na mesma faixa.
    if (ka.chave.startsWith('mod:') && kb.chave.startsWith('mod:')) {
      const marcasBatem = !ka.marca || !kb.marca || compacto(ka.marca) === compacto(kb.marca)
      // Coincidir num token curto e genérico ("g10", "12g") não prova nada:
      // o modelo em comum precisa ser distintivo para valer como identidade.
      const distintivo = (m) => m.length >= 5 && /\d{3,}/.test(m)
      const comuns = ka.modelos.filter(m => kb.modelos.includes(m) && distintivo(m))
      const conflitoSpec = specsConflitam(ka.specs, kb.specs)
      const linhasBrigam = ka.linha && kb.linha && ka.linha !== kb.linha
      if (linhasBrigam) return { igual: false, confianca: 0.8, base: `linhas diferentes (${ka.linha} × ${kb.linha})` }
      const cpusBrigam = ka.cpus?.length && kb.cpus?.length && !ka.cpus.some(c => kb.cpus.includes(c))
      if (cpusBrigam) return { igual: false, confianca: 0.85, base: `processadores diferentes (${ka.cpus[0]} × ${kb.cpus[0]})` }

      // Títulos praticamente iguais são o mesmo produto, mesmo que um cite
      // "15 Bar" e o outro "1,4L" e isso gere listas de modelo diferentes.
      // Sem esta saída, o mesmo anúncio da Carrefour virava quatro produtos.
      if (similaridade(a.nome, b.nome) >= 0.88) {
        return { igual: true, confianca: 0.88, base: 'mesmo anúncio, título com variação' }
      }
      const precoOk = !a.preco || !b.preco ||
        Math.abs(a.preco - b.preco) / Math.max(a.preco, b.preco) <= (opcoes.tolerancia ?? 0.35)
      // Um modelo em comum não basta: "PC Gamer Ryzen 7 7800X3D" e "Kit Upgrade
      // Ryzen 7 7800X3D" compartilham o processador e não são o mesmo produto.
      // O texto precisa se parecer também — sem esta trava, os dois viravam um
      // só e cada rodada inventava uma queda de 27%.
      const parecidos = similaridade(a.nome, b.nome) >= 0.5
      if (marcasBatem && comuns.length && !conflitoSpec && precoOk && parecidos) {
        return { igual: true, confianca: 0.78, base: `modelo ${comuns[0]} em comum` }
      }
      if (marcasBatem && comuns.length && !parecidos) {
        return { igual: false, confianca: 0.8, base: 'mesmo componente, produtos diferentes' }
      }
      return { igual: false, confianca: 0.85, base: conflitoSpec ? 'configurações diferentes' : 'modelos diferentes' }
    }
  }
  // Mesmo no caminho por texto, processador diferente encerra o assunto.
  if (ka.cpus?.length && kb.cpus?.length && !ka.cpus.some(c => kb.cpus.includes(c))) {
    return { igual: false, confianca: 0.85, base: `processadores diferentes (${ka.cpus[0]} × ${kb.cpus[0]})` }
  }
  // Nem título quase igual junta 110V com 220V: são compras diferentes.
  if (specsConflitam(ka.specs, kb.specs)) {
    return { igual: false, confianca: 0.85, base: 'versões diferentes (voltagem ou capacidade)' }
  }
  const sim = similaridade(a.nome, b.nome)
  const precoOk = !a.preco || !b.preco ||
    Math.abs(a.preco - b.preco) / Math.max(a.preco, b.preco) <= (opcoes.tolerancia ?? 0.35)
  if (sim >= 0.82 && precoOk) return { igual: true, confianca: sim, base: 'texto muito parecido' }
  if (sim >= 0.7 && precoOk) return { igual: true, confianca: sim, base: 'texto parecido + preço compatível', fraco: true }
  return { igual: false, confianca: 1 - sim, base: 'texto diferente' }
}

/**
 * Regra específica para quando a busca mira UM produto ("cafeteira oster
 * maxima", "ninja creami"): aí o padrão se inverte. Cada loja escreve o mesmo
 * aparelho de um jeito — "Ninja Máquina de Sorvete Creami 110V" na Carrefour,
 * "Ninja, Sorveteira, Creami, 7 Programas Auto-iQ, 127 v" na Amazon — e exigir
 * títulos parecidos multiplica o mesmo produto por loja.
 *
 * Então, numa busca específica, dois anúncios são o MESMO produto por padrão,
 * a menos que algum atributo que realmente distingue diga o contrário:
 * voltagem, capacidade, memória, tamanho, processador, modelo ou linha.
 */
export function mesmoProdutoNaBusca (a, b, interp, opcoes = {}) {
  const direto = mesmoProduto(a, b, opcoes)
  if (direto.igual) return direto

  const especifica = (interp.palavrasChave || []).length > 0 ||
    (interp.modelos || []).length > 0 ||
    (interp.especificidade || 0) >= 55
  if (!especifica) return direto

  const ka = chaveProduto(a)
  const kb = chaveProduto(b)

  if (ka.marca && kb.marca && compacto(ka.marca) !== compacto(kb.marca)) {
    return { igual: false, confianca: 0.8, base: 'marcas diferentes' }
  }
  // "Linha" só distingue dentro da mesma família de modelo (Eagle e Aero da
  // RTX 5070). Entre títulos sem modelo em comum ela é ruído: virava
  // "linhas diferentes (ninja × creami)" para dois anúncios da mesma máquina.
  const mesmaFamilia = ka.modelos.some(m => kb.modelos.includes(m))
  if (mesmaFamilia && ka.linha && kb.linha && ka.linha !== kb.linha) {
    return { igual: false, confianca: 0.8, base: `linhas diferentes (${ka.linha} × ${kb.linha})` }
  }
  if (ka.cpus?.length && kb.cpus?.length && !ka.cpus.some(c => kb.cpus.includes(c))) {
    return { igual: false, confianca: 0.85, base: 'processadores diferentes' }
  }
  if (specsConflitam(ka.specs, kb.specs)) {
    const briga = ka.specs.find(s => kb.specs.length && !kb.specs.includes(s)) || ''
    return { igual: false, confianca: 0.85, base: `versões diferentes (${briga || 'especificação'})` }
  }
  // Modelos explícitos e diferentes nos dois títulos também separam.
  if (ka.modelos.length && kb.modelos.length && !ka.modelos.some(m => kb.modelos.includes(m))) {
    const distintivo = (m) => m.length >= 5 && /\d{3,}/.test(m)
    if (ka.modelos.some(distintivo) && kb.modelos.some(distintivo)) {
      return { igual: false, confianca: 0.8, base: 'códigos de modelo diferentes' }
    }
  }
  const precoOk = !a.preco || !b.preco ||
    Math.abs(a.preco - b.preco) / Math.max(a.preco, b.preco) <= (opcoes.tolerancia ?? 0.4)
  if (!precoOk) return { igual: false, confianca: 0.7, base: 'preços distantes demais' }

  return { igual: true, confianca: 0.7, base: 'mesmo produto da sua busca, escrito diferente', porBusca: true }
}

/**
 * Gancho para o degrau 6 da spec ("IA para resolver casos ambíguos").
 * Hoje decide por heurística. Quando entrar modelo de linguagem, é aqui — a
 * assinatura já devolve o motivo da decisão para poder ser auditada.
 */
export function precisaDeDesempate (resultado) {
  return Boolean(resultado.ambiguo)
}

export function nomeCanonico (itens) {
  // O nome mais informativo entre as lojas costuma ser o mais completo, mas o
  // mais longo tende a vir cheio de marketing. Pega o de tamanho mediano.
  const nomes = itens.map(i => String(i.nome || '').trim()).filter(Boolean)
  if (!nomes.length) return 'Produto sem nome'
  const ordenados = [...nomes].sort((a, b) => a.length - b.length)
  return ordenados[Math.floor(ordenados.length / 2)].slice(0, 180)
}
