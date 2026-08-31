// Busca guiada: atributos extraídos do TÍTULO dos anúncios, no estilo do
// formulário de refinamento do Mercado Livre — mas sem catálogo externo. Cada
// atributo (processador, memória, armazenamento...) é lido do texto que a
// loja já devolveu. Selecionar é opcional: sem seleção, a busca segue ampla.
//
// Este arquivo não decide se um anúncio É o produto buscado (isso é papel de
// `match.js`/`nlp.js`) — ele só extrai características para o usuário refinar
// dentro de um conjunto de anúncios que já passou pela busca.

import { pathToFileURL } from 'node:url'
import { normalizar } from './nlp.js'

// ---------------------------------------------------------------- processador

// Apple M1..M5, com variação (Pro/Max/Ultra) quando colada ao chip: "Chip M4
// Pro" tem que virar processador=m4 + geracao=m4pro — "M4" e "M4 Pro" são
// produtos diferentes (memória unificada, núcleos de GPU, preço).
const RE_APPLE_M = /\bm([1-5])\b(?:\s+(pro|max|ultra))?/i
const RE_RYZEN = /\bryzen\s*([3579])\b(?:\s+(pro|max|ultra|ti))?/i
const RE_COREI = /\bcore\s*i([3579])\b(?:\s+(pro|max|ultra|ti))?/i

function acharProcessadorEGeracao (n) {
  let m = n.match(RE_APPLE_M)
  if (m) {
    const base = 'm' + m[1]
    return { processador: base, geracao: m[2] ? base + m[2] : null }
  }
  m = n.match(RE_RYZEN)
  if (m) {
    const base = 'ryzen' + m[1]
    return { processador: base, geracao: m[2] ? base + m[2] : null }
  }
  m = n.match(RE_COREI)
  if (m) {
    const base = 'corei' + m[1]
    return { processador: base, geracao: m[2] ? base + m[2] : null }
  }
  return { processador: null, geracao: null }
}

// ------------------------------------------------------- memória × armazenamento

const RE_TAMANHO = /(\d+(?:[.,]\d+)?)\s*(gb|tb|mb)\b/gi
const JANELA_CONTEXTO = 18

/**
 * A parte difícil: "16GB RAM 512GB SSD" tem rótulo dizendo o que é cada
 * número, mas "MacBook Air M4 16GB 256GB" não tem — e nesse caso quem
 * desempata é a ordem de grandeza, não a posição no texto.
 *
 * Passo 1 — classifica pelo que está escrito por perto ("ram"/"memória" vs
 * "ssd"/"hd"/"armazenamento"/"rom"/"disco"). TB nunca é RAM (nenhum notebook
 * de consumo vem com terabyte de memória), então TB é armazenamento sempre,
 * com ou sem rótulo.
 * Passo 2 — o que sobrou sem rótulo: com dois números soltos, o menor é RAM e
 * o maior é armazenamento (é a própria ordem que a Apple usa no título).  Com
 * um só, até 64GB é padrão de pente de RAM; acima disso (128/256/512...) só
 * existe em disco.
 */
function acharMemoriaEArmazenamento (n) {
  const candidatos = []
  for (const m of n.matchAll(RE_TAMANHO)) {
    const unidade = m[2].toLowerCase()
    candidatos.push({
      valor: `${m[1].replace(',', '.')}${unidade}`,
      numero: Number(m[1].replace(',', '.')) * (unidade === 'tb' ? 1024 : 1),
      unidade,
      inicio: m.index,
      fim: m.index + m[0].length
    })
  }
  if (!candidatos.length) return { memoria: null, armazenamento: null }

  let memoria = null
  let armazenamento = null
  const restantes = []

  for (const [i, c] of candidatos.entries()) {
    if (c.unidade === 'tb') {
      if (!armazenamento) armazenamento = c.valor
      continue
    }
    // A janela de contexto não pode invadir o número vizinho: em "24 GB, 512
    // GB SSD" os dois números ficam a 2 caracteres um do outro, e sem este
    // limite o "ssd" do 512 GB "vazava" para dentro da janela do 24 GB e os
    // dois trocavam de lugar.
    const limiteAntes = i > 0 ? candidatos[i - 1].fim : 0
    const limiteDepois = i < candidatos.length - 1 ? candidatos[i + 1].inicio : n.length
    const antes = n.slice(Math.max(limiteAntes, c.inicio - JANELA_CONTEXTO), c.inicio)
    const depois = n.slice(c.fim, Math.min(limiteDepois, c.fim + JANELA_CONTEXTO))
    const contexto = antes + ' ' + depois
    const ehRam = /\bram\b/.test(contexto) || /\bmemoria\b/.test(contexto)
    const ehArmazenamento = /\bssd\b/.test(contexto) || /\barmazenamento\b/.test(contexto) ||
      /\bhd\b/.test(contexto) || /\brom\b/.test(contexto) || /\bdisco\b/.test(contexto)
    if (ehRam && !memoria) memoria = c.valor
    else if (ehArmazenamento && !armazenamento) armazenamento = c.valor
    else restantes.push(c)
  }

  if (restantes.length >= 2) {
    restantes.sort((a, b) => a.numero - b.numero)
    if (!memoria) memoria = restantes[0].valor
    if (!armazenamento) armazenamento = restantes[restantes.length - 1].valor
  } else if (restantes.length === 1) {
    const unico = restantes[0]
    if (!memoria && !armazenamento) {
      if (unico.numero <= 64) memoria = unico.valor
      else armazenamento = unico.valor
    } else if (!memoria) {
      memoria = unico.valor
    } else if (!armazenamento) {
      armazenamento = unico.valor
    }
  }

  return { memoria, armazenamento }
}

// -------------------------------------------------------------------- tela

// Só aceita polegada explícita ("polegadas", "pol" ou aspas) — sem isso,
// qualquer número vira candidato a tamanho de tela, e "Go 15" (linha do
// notebook Asus) ou "RTX 5070" viravam telas fantasmas.
const RE_TELA = /(\d+(?:[.,]\d+)?)\s*(?:polegadas|pol\.?|")/i

function acharTela (n) {
  const m = n.match(RE_TELA)
  if (!m) return null
  return `${m[1].replace(',', '.')}pol`
}

// ----------------------------------------------------------------- voltagem

function acharVoltagem (n) {
  if (/\bbivolt\b/.test(n)) return 'bivolt'
  const m = n.match(/\b(\d{2,3})\s?v(?:olts?)?\b/)
  if (!m) return null
  const v = Number(m[1])
  if (v >= 100 && v <= 130) return '127v'
  if (v >= 200 && v <= 250) return '220v'
  return null
}

// ---------------------------------------------------------------------- cor

// Lista curta e previsível — cores compostas primeiro, senão "cinza
// espacial" seria lido como só "cinza" (a mais genérica bateria primeiro).
const CORES = [
  [/\bcinza\s*espacial\b/, 'cinza espacial'],
  [/\bpreto[\s-]+espacial\b/, 'preto espacial'],
  [/\bmeia[\s-]?noite\b/, 'meia-noite'],
  [/\bestelar\b/, 'estelar'],
  [/\bpratead[oa]\b/, 'prata'],
  [/\bdourad[oa]\b/, 'dourado'],
  [/\bgrafite\b/, 'grafite'],
  [/\bprata\b/, 'prata'],
  [/\brosa\b/, 'rosa'],
  [/\bazul\b/, 'azul'],
  [/\bverde\b/, 'verde'],
  [/\bvermelh[oa]\b/, 'vermelho'],
  [/\bamarel[oa]\b/, 'amarelo'],
  [/\broxo\b/, 'roxo'],
  [/\bmarrom\b/, 'marrom'],
  [/\bbege\b/, 'bege'],
  [/\bbranco\b/, 'branco'],
  [/\bpreto\b/, 'preto'],
  [/\bcinza\b/, 'cinza']
]

/**
 * A cor costuma vir por último no título ("... - Estelar"), e às vezes um
 * nome de linha de produto engana ("Perfect Brew Máxima" não tem "max"
 * isolado, então não conflita). Por isso pega o casamento mais à direita, e
 * entre casamentos que começam no mesmo ponto, o mais longo (o composto).
 */
function acharCor (n) {
  let melhor = null
  for (const [re, canonico] of CORES) {
    const global = new RegExp(re.source, 'gi')
    let m
    while ((m = global.exec(n))) {
      if (!melhor || m.index > melhor.indice || (m.index === melhor.indice && m[0].length > melhor.tamanho)) {
        melhor = { indice: m.index, tamanho: m[0].length, canonico }
      }
    }
  }
  return melhor ? melhor.canonico : null
}

// ------------------------------------------------------------------- modelo

// Código de modelo Apple: "A" + 4 dígitos ("A2681"). Não tenta cobrir outros
// fabricantes — cada um tem convenção própria e sem padrão claro no título.
const RE_MODELO = /\b(a\d{4})\b/i

function acharModelo (n) {
  const m = n.match(RE_MODELO)
  return m ? m[1] : null
}

// --------------------------------------------------------------- capacidade

// Litros/mililitros de eletroportátil ("1,5L", "600ml"). "litros?" precisa
// vir antes do "l" solto na alternativa, senão "litros" casaria só o "l" e
// sobraria "itros" sem sentido.
const RE_CAPACIDADE = /(\d+(?:[.,]\d+)?)\s*(ml|litros?|l)\b/i

function acharCapacidade (n) {
  const m = n.match(RE_CAPACIDADE)
  if (!m) return null
  const num = m[1].replace(',', '.')
  const unidade = m[2].toLowerCase() === 'ml' ? 'ml' : 'l'
  return `${num}${unidade}`
}

/**
 * Atributos encontrados num único título de anúncio. Função pura: mesmo
 * título sempre devolve o mesmo objeto, sem olhar nada além do texto.
 */
export function extrairAtributos (titulo) {
  const n = normalizar(String(titulo || ''))
  const { processador, geracao } = acharProcessadorEGeracao(n)
  const { memoria, armazenamento } = acharMemoriaEArmazenamento(n)
  return {
    processador,
    geracao,
    memoria,
    armazenamento,
    tela: acharTela(n),
    voltagem: acharVoltagem(n),
    cor: acharCor(n),
    modelo: acharModelo(n),
    capacidade: acharCapacidade(n)
  }
}

// ------------------------------------------------------------------ facetas

const ROTULOS_CAMPO = {
  processador: 'Processador',
  geracao: 'Variação',
  memoria: 'Memória',
  armazenamento: 'Armazenamento',
  tela: 'Tela',
  voltagem: 'Voltagem',
  cor: 'Cor',
  modelo: 'Modelo',
  capacidade: 'Capacidade'
}

const CAMPOS = Object.keys(ROTULOS_CAMPO)

function primeiraMaiuscula (s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function rotularProcessador (valor) {
  let m = valor.match(/^m(\d)(pro|max|ultra)?$/)
  if (m) return `M${m[1]}` + (m[2] ? ` ${primeiraMaiuscula(m[2])}` : '')
  m = valor.match(/^ryzen(\d)(pro|max|ultra|ti)?$/)
  if (m) return `Ryzen ${m[1]}` + (m[2] ? ` ${primeiraMaiuscula(m[2])}` : '')
  m = valor.match(/^corei(\d)(pro|max|ultra|ti)?$/)
  if (m) return `Core i${m[1]}` + (m[2] ? ` ${primeiraMaiuscula(m[2])}` : '')
  return primeiraMaiuscula(valor)
}

function rotularTamanho (valor) {
  const m = valor.match(/^(\d+(?:\.\d+)?)(gb|tb|mb)$/)
  return m ? `${m[1]} ${m[2].toUpperCase()}` : valor
}

function rotularCapacidade (valor) {
  const m = valor.match(/^(\d+(?:\.\d+)?)(ml|l)$/)
  if (!m) return valor
  return `${m[1]} ${m[2] === 'ml' ? 'ml' : 'L'}`
}

/** Rótulo "de gente" para uma opção de faceta: 'm4' -> 'M4', '512gb' -> '512 GB'. */
function rotularValor (campo, valor) {
  switch (campo) {
    case 'processador':
    case 'geracao':
      return rotularProcessador(valor)
    case 'memoria':
    case 'armazenamento':
      return rotularTamanho(valor)
    case 'tela':
      return `${valor.replace('pol', '')} polegadas`
    case 'voltagem':
      return valor === 'bivolt' ? 'Bivolt' : valor.toUpperCase()
    case 'cor':
      return valor.replace(/(^|[\s-])\S/g, c => c.toUpperCase())
    case 'modelo':
      return valor.toUpperCase()
    case 'capacidade':
      return rotularCapacidade(valor)
    default:
      return valor
  }
}

/**
 * Monta as facetas prontas para a interface a partir dos anúncios que já
 * foram buscados. Uma faceta só aparece se de fato ajudar a escolher: pelo
 * menos duas opções distintas, e presente em pelo menos 15% dos itens (senão
 * é ruído — um campo que quase ninguém preenche não é filtro, é exceção).
 *
 * `opcoes.minParticipacao` (padrão 0.15) e `opcoes.maxOpcoes` (padrão 8)
 * existem para o chamador poder ajustar sem editar este arquivo.
 */
export function montarFacetas (itens, opcoes = {}) {
  const minParticipacao = opcoes.minParticipacao ?? 0.15
  const maxOpcoes = opcoes.maxOpcoes ?? 8
  const total = itens.length
  if (!total) return []

  const atributosPorItem = itens.map(it => extrairAtributos(it.nome))

  const facetas = []
  for (const campo of CAMPOS) {
    const contagem = new Map()
    let comValor = 0
    for (const attrs of atributosPorItem) {
      const v = attrs[campo]
      if (!v) continue
      comValor++
      contagem.set(v, (contagem.get(v) || 0) + 1)
    }
    if (contagem.size < 2) continue
    if (comValor / total < minParticipacao) continue

    const opcoesOrdenadas = [...contagem.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxOpcoes)
      .map(([valor, qtd]) => ({ valor, rotulo: rotularValor(campo, valor), contagem: qtd }))

    // Utilidade = quão equilibrada é a divisão entre as opções. Uma faceta
    // onde 95% dos itens caem na mesma opção não ajuda a decidir nada — é a
    // faceta com a divisão mais próxima de 50/50 que corta a lista ao meio.
    const maiorFatia = Math.max(...opcoesOrdenadas.map(o => o.contagem)) / comValor
    facetas.push({
      campo,
      rotulo: ROTULOS_CAMPO[campo],
      opcoes: opcoesOrdenadas,
      _utilidade: 1 - maiorFatia,
      _cobertura: comValor
    })
  }

  facetas.sort((a, b) => b._utilidade - a._utilidade || b._cobertura - a._cobertura)
  for (const f of facetas) { delete f._utilidade; delete f._cobertura }
  return facetas
}

/**
 * Aplica os filtros escolhidos pelo usuário. Dentro do mesmo campo é OU
 * ("m4" ou "m4pro"), entre campos é E (processador E memória).
 */
export function aplicarFiltros (itens, filtros = {}) {
  const ativos = Object.entries(filtros || {}).filter(([, vals]) => Array.isArray(vals) && vals.length)
  if (!ativos.length) return itens.slice()
  return itens.filter(item => {
    const attrs = extrairAtributos(item.nome)
    return ativos.every(([campo, valores]) => attrs[campo] && valores.includes(attrs[campo]))
  })
}

/** Frase curta em pt-BR resumindo os filtros ativos: "M4 ou M4 Pro · 16 GB". */
export function descreverFiltros (filtros = {}) {
  const partes = []
  for (const campo of CAMPOS) {
    const valores = filtros[campo]
    if (!Array.isArray(valores) || !valores.length) continue
    partes.push(valores.map(v => rotularValor(campo, v)).join(' ou '))
  }
  return partes.join(' · ')
}

// -------------------------------------------------------------------- teste

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const casos = [
    {
      titulo: 'Apple MacBook Air 13 Polegadas Processador M5 - 24gb Ram - 1tb Ssd - Estelar',
      esperado: {
        processador: 'm5', geracao: null, memoria: '24gb', armazenamento: '1tb',
        tela: '13pol', voltagem: null, cor: 'estelar', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Notebook Asus Vivobook Go 15, AMD Ryzen 5, 8GB de Memória, Armazenamento 512GB SSD',
      esperado: {
        processador: 'ryzen5', geracao: null, memoria: '8gb', armazenamento: '512gb',
        tela: null, voltagem: null, cor: null, modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Cafeteira Espresso Oster Perfect Brew Máxima 220v',
      esperado: {
        processador: null, geracao: null, memoria: null, armazenamento: null,
        tela: null, voltagem: '220v', cor: null, modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Placa de Vídeo Gigabyte RTX 5070 WINDFORCE OC SFF 12G, 12GB GDDR7',
      esperado: {
        processador: null, geracao: null, memoria: '12gb', armazenamento: null,
        tela: null, voltagem: null, cor: null, modelo: null, capacidade: null
      }
    },
    {
      titulo: "Apple 2025 MacBook Pro (de 14 polegadas, Chip M4 Pro, 24 GB, 512 GB SSD) - Preto-espacial",
      esperado: {
        processador: 'm4', geracao: 'm4pro', memoria: '24gb', armazenamento: '512gb',
        tela: '14pol', voltagem: null, cor: 'preto espacial', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'MacBook Air M4 16GB 256GB Prata 13 Polegadas A3113',
      esperado: {
        processador: 'm4', geracao: null, memoria: '16gb', armazenamento: '256gb',
        tela: '13pol', voltagem: null, cor: 'prata', modelo: 'a3113', capacidade: null
      }
    },
    {
      titulo: 'MacBook Pro M4 Max 32GB 1TB SSD Cinza Espacial 14 Polegadas A2992',
      esperado: {
        processador: 'm4', geracao: 'm4max', memoria: '32gb', armazenamento: '1tb',
        tela: '14pol', voltagem: null, cor: 'cinza espacial', modelo: 'a2992', capacidade: null
      }
    },
    {
      titulo: 'Notebook Dell Inspiron Intel Core i7 16GB RAM 512GB SSD 15.6 Polegadas Prata',
      esperado: {
        processador: 'corei7', geracao: null, memoria: '16gb', armazenamento: '512gb',
        tela: '15.6pol', voltagem: null, cor: 'prata', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Notebook Lenovo IdeaPad AMD Ryzen 7 16 GB Memória 1TB HD Cinza',
      esperado: {
        processador: 'ryzen7', geracao: null, memoria: '16gb', armazenamento: '1tb',
        tela: null, voltagem: null, cor: 'cinza', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Liquidificador Philips Walita 1,5L 220V',
      esperado: {
        processador: null, geracao: null, memoria: null, armazenamento: null,
        tela: null, voltagem: '220v', cor: null, modelo: null, capacidade: '1.5l'
      }
    },
    {
      titulo: 'Ferro de Passar Philco Bivolt',
      esperado: {
        processador: null, geracao: null, memoria: null, armazenamento: null,
        tela: null, voltagem: 'bivolt', cor: null, modelo: null, capacidade: null
      }
    },
    {
      titulo: 'MacBook Air M4 8GB 256GB Meia-noite 13 Polegadas',
      esperado: {
        processador: 'm4', geracao: null, memoria: '8gb', armazenamento: '256gb',
        tela: '13pol', voltagem: null, cor: 'meia-noite', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Tênis Nike Air Max 42 Preto',
      esperado: {
        processador: null, geracao: null, memoria: null, armazenamento: null,
        tela: null, voltagem: null, cor: 'preto', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Fone de Ouvido JBL Bluetooth Preto',
      esperado: {
        processador: null, geracao: null, memoria: null, armazenamento: null,
        tela: null, voltagem: null, cor: 'preto', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Notebook Acer Aspire 14.5 Polegadas Intel Core i5 8GB 256GB SSD Prata',
      esperado: {
        processador: 'corei5', geracao: null, memoria: '8gb', armazenamento: '256gb',
        tela: '14.5pol', voltagem: null, cor: 'prata', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Notebook Gamer XPTO SSD 512GB 16GB RAM Preto',
      esperado: {
        processador: null, geracao: null, memoria: '16gb', armazenamento: '512gb',
        tela: null, voltagem: null, cor: 'preto', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'SSD Externo 2TB Preto',
      esperado: {
        processador: null, geracao: null, memoria: null, armazenamento: '2tb',
        tela: null, voltagem: null, cor: 'preto', modelo: null, capacidade: null
      }
    },
    {
      titulo: 'Apple MacBook Air 13 Polegadas M4 16GB 512GB Azul',
      esperado: {
        processador: 'm4', geracao: null, memoria: '16gb', armazenamento: '512gb',
        tela: '13pol', voltagem: null, cor: 'azul', modelo: null, capacidade: null
      }
    }
  ]

  let ok = 0
  for (const [i, caso] of casos.entries()) {
    const obtido = extrairAtributos(caso.titulo)
    const bateu = Object.keys(caso.esperado).every(k => obtido[k] === caso.esperado[k])
    if (bateu) ok++
    console.log(`${bateu ? '✓' : '✗'} [${i + 1}] ${caso.titulo}`)
    if (!bateu) {
      console.log('   esperado:', caso.esperado)
      console.log('   obtido:  ', obtido)
    }
  }
  console.log(`\nPlacar: ${ok}/${casos.length}`)

  // ---- demonstração: facetas a partir de 10 anúncios reais de MacBook
  const itensMacBook = [
    { nome: 'Apple MacBook Air 13 Polegadas Processador M5 - 24gb Ram - 1tb Ssd - Estelar', preco: 12999 },
    { nome: "Apple 2025 MacBook Pro (de 14 polegadas, Chip M4 Pro, 24 GB, 512 GB SSD) - Preto-espacial", preco: 18999 },
    { nome: 'MacBook Air M4 16GB 256GB Prata 13 Polegadas A3113', preco: 10999 },
    { nome: 'MacBook Pro M4 Max 32GB 1TB SSD Cinza Espacial 14 Polegadas A2992', preco: 24999 },
    { nome: 'MacBook Air M4 8GB 256GB Meia-noite 13 Polegadas', preco: 9499 },
    { nome: 'Apple MacBook Air 13 Polegadas M4 16GB 512GB Azul', preco: 11999 },
    { nome: 'Apple MacBook Pro 16 Polegadas M4 Pro 16GB 512GB SSD Prata', preco: 19999 },
    { nome: 'MacBook Air M5 16GB 512GB Estelar 15 Polegadas', preco: 13999 },
    { nome: 'Apple MacBook Pro 14 Polegadas M4 24GB 1TB SSD Cinza Espacial', preco: 16999 },
    { nome: 'MacBook Air M4 24GB 1TB Prata 13 Polegadas', preco: 14999 }
  ]
  console.log('\n--- Facetas a partir de 10 anúncios de MacBook ---')
  console.log(JSON.stringify(montarFacetas(itensMacBook), null, 2))

  const filtros = { processador: ['m4'], memoria: ['16gb'] }
  console.log('\nFiltro de exemplo:', descreverFiltros(filtros))
  console.log('Itens que atendem:', aplicarFiltros(itensMacBook, filtros).map(i => i.nome))
}
