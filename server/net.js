// Camada de rede: buscar páginas de loja com educação e sem tomar bloqueio.
//
// Três coisas importam aqui:
// 1. Uma requisição por domínio de cada vez, com intervalo mínimo entre elas.
//    Rajada paralela é o jeito mais rápido de virar IP bloqueado.
// 2. Dizer quem somos. O app se apresentava como Chrome, o que é o padrão do
//    mercado e é mentira. Agora manda o próprio nome e um endereço que explica
//    o que ele é — como faz o Googlebot. Custa acesso em algumas lojas, e é o
//    preço de a loja poder decidir sobre nós.
// 3. Distinguir "falhou" de "fui bloqueado" — o teste de compatibilidade
//    depende dessa diferença para dar um motivo em vez de um erro genérico.

// Como o KiwiFinder se apresenta às lojas.
//
// Até aqui ele dizia ser um Chrome, o que é o padrão do mercado e é mentira: a
// loja recebia "uma pessoa navegando" quando era um programa. É a única peça
// que não sobrevive ao critério que o resto do app adota — obedecer robots,
// respeitar recusa, ler só o que é publicado.
//
// O Googlebot se identifica assim: `Googlebot/2.1 (+http://www.google.com/bot.html)`.
// Nome próprio e um endereço explicando o que é. Isso dá à loja a chance de
// decidir sobre NÓS: liberar, limitar o ritmo, ou barrar pelo nome no
// robots.txt. Ela não tinha essa chance antes.
//
// O custo é real: loja com proteção agressiva provavelmente bloqueia assim que
// pararmos de parecer navegador. Mas se ela bloqueia o KiwiFinder identificado,
// essa é a resposta dela — e o app já sabe respeitar resposta.
const NOME_DO_ROBO = 'KiwiFinder'
const VERSAO = '2.0'
const PAGINA_DO_ROBO = process.env.KIWI_URL_PUBLICA || 'https://kiwifinder.onrender.com/sobre'

const UA_NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const UA_IDENTIFICADO = `${NOME_DO_ROBO}/${VERSAO} (+${PAGINA_DO_ROBO})`

// Ligável para dar para medir o estrago antes de decidir. `identificarSe` sai
// como ligado por padrão; KIWI_ANONIMO=1 volta ao comportamento antigo.
const UA = process.env.KIWI_ANONIMO === '1' ? UA_NAVEGADOR : UA_IDENTIFICADO

export function comoNosApresentamos () {
  return UA
}

// Os cabeçalhos `Sec-Fetch-*` e `Upgrade-Insecure-Requests` são emitidos por
// navegador ao navegar, e mandá-los era parte do disfarce: diziam "isto é uma
// aba se abrindo". Um robô declarado não os manda — sobra o essencial, que é
// dizer quem é, o que aceita e em que idioma.
const CABECALHOS = process.env.KIWI_ANONIMO === '1'
  ? {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    }
  : {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'From': process.env.KIWI_CONTATO || ''
    }

// Intervalo mínimo entre dois acessos ao MESMO domínio. Domínios diferentes
// correm em paralelo, então isso não é o que segura a rodada — 700ms continua
// educado e tira quase 1s de cada busca encadeada.
const INTERVALO_MIN_MS = 700
const TIMEOUT_MS = 20000

const filas = new Map()      // host -> Promise encadeada
const ultimoAcesso = new Map()
// Castigo por domínio: quando a loja responde 429/503 (limite de taxa), o
// intervalo dela sobe e vai dobrando. Insistir no mesmo ritmo depois de um 503
// é o caminho mais rápido para virar bloqueio de verdade — a Amazon devolveu
// 503 quatro vezes seguidas justamente por isso.
const castigo = new Map()    // host -> { ms, ate }

function intervaloDoHost (host) {
  const c = castigo.get(host)
  if (c && Date.now() < c.ate) return Math.max(INTERVALO_MIN_MS, c.ms)
  if (c) castigo.delete(host)
  return INTERVALO_MIN_MS
}

function aplicarCastigo (host, segundosPedidos = null) {
  const atual = castigo.get(host)
  const base = segundosPedidos
    ? segundosPedidos * 1000
    : Math.min((atual ? atual.ms * 2 : 6000), 90000)
  castigo.set(host, { ms: base, ate: Date.now() + Math.max(base * 4, 60000) })
  return base
}

function aliviarCastigo (host) {
  const c = castigo.get(host)
  if (!c) return
  // Sucesso reduz o castigo pela metade, em vez de zerar de uma vez.
  const novo = Math.floor(c.ms / 2)
  if (novo <= INTERVALO_MIN_MS) castigo.delete(host)
  else castigo.set(host, { ms: novo, ate: c.ate })
}

export function estadoDosCastigos () {
  return [...castigo.entries()].map(([host, c]) => ({ host, intervaloMs: c.ms, ate: new Date(c.ate).toISOString() }))
}
const cache = new Map()      // url -> { ts, resposta }
const CACHE_MS = 60 * 1000

const espera = (ms) => new Promise(r => setTimeout(r, ms))

function hostDe (url) {
  try { return new URL(url).host } catch { return 'invalido' }
}

// Serializa por host e garante o intervalo mínimo entre acessos.
function naFila (host, tarefa) {
  const anterior = filas.get(host) || Promise.resolve()
  const proxima = anterior.then(async () => {
    const ultimo = ultimoAcesso.get(host) || 0
    const faltam = intervaloDoHost(host) - (Date.now() - ultimo)
    if (faltam > 0) await espera(faltam)
    try {
      return await tarefa()
    } finally {
      ultimoAcesso.set(host, Date.now())
    }
  })
  filas.set(host, proxima.catch(() => {}))
  return proxima
}

const SINAIS_BLOQUEIO = [
  'captcha', 'are you a robot', 'não é um robô', 'nao e um robo',
  'cf-browser-verification', 'cf_chl', 'checking your browser',
  'verificando seu navegador', 'access denied', 'acesso negado',
  'request blocked', 'perimeterx', 'px-captcha', 'incapsula',
  'unusual traffic', 'tráfego incomum', 'bot detection', 'akamai reference'
]

export function pareceBloqueio (status, html) {
  if (status === 403 || status === 429 || status === 503) return true
  if (!html) return false
  const amostra = html.slice(0, 6000).toLowerCase()
  return SINAIS_BLOQUEIO.some(s => amostra.includes(s))
}

/**
 * Busca uma URL. Nunca lança por erro de rede: devolve sempre um objeto com
 * `ok` e, quando falha, um `motivo` legível.
 */
export async function buscar (url, opcoes = {}) {
  const { usarCache = true, referer = null, tentativas = 2 } = opcoes
  const chave = url

  if (usarCache) {
    const guardado = cache.get(chave)
    if (guardado && Date.now() - guardado.ts < CACHE_MS) {
      return { ...guardado.resposta, doCache: true }
    }
  }

  const host = hostDe(url)
  const resultado = await naFila(host, async () => {
    let ultimoErro = null
    for (let tentativa = 0; tentativa < tentativas; tentativa++) {
      if (tentativa > 0) await espera(1200 * tentativa)
      try {
        const cabecalhos = { ...CABECALHOS }
        if (referer) {
          cabecalhos.Referer = referer
          cabecalhos['Sec-Fetch-Site'] = 'same-origin'
        }
        const inicio = Date.now()
        const resposta = await fetch(url, {
          headers: cabecalhos,
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS)
        })
        const tipo = resposta.headers.get('content-type') || ''
        const corpo = await resposta.text()

        // Limite de taxa: respeita o Retry-After quando existir, senão dobra
        // o intervalo do domínio. E não adianta repetir agora — sai do laço.
        if (resposta.status === 429 || resposta.status === 503) {
          const pedido = Number(resposta.headers.get('retry-after'))
          const novo = aplicarCastigo(host, Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, 120) : null)
          return {
            ok: false,
            status: resposta.status,
            urlFinal: resposta.url || url,
            tipo,
            html: corpo,
            ms: Date.now() - inicio,
            bloqueado: true,
            limiteDeTaxa: true,
            motivo: `a loja pediu para diminuir o ritmo (HTTP ${resposta.status}); vou esperar ${Math.round(novo / 1000)}s entre os próximos pedidos`
          }
        }
        if (resposta.ok) aliviarCastigo(host)

        return {
          ok: resposta.ok,
          status: resposta.status,
          urlFinal: resposta.url || url,
          tipo,
          html: corpo,
          ms: Date.now() - inicio,
          bloqueado: pareceBloqueio(resposta.status, corpo),
          motivo: resposta.ok ? null : `HTTP ${resposta.status}`
        }
      } catch (erro) {
        ultimoErro = erro
      }
    }
    const msg = String(ultimoErro && ultimoErro.message || ultimoErro)
    return {
      ok: false,
      status: 0,
      urlFinal: url,
      tipo: '',
      html: '',
      ms: 0,
      bloqueado: false,
      erroRede: true,
      motivo: msg.includes('timed out') || msg.includes('TimeoutError')
        ? 'a loja não respondeu a tempo (25s)'
        : msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')
          ? 'endereço não encontrado — confira o domínio'
          : msg.includes('certificate')
            ? 'problema no certificado do site'
            : `falha de rede: ${msg}`
    }
  })

  if (usarCache && resultado.ok) cache.set(chave, { ts: Date.now(), resposta: resultado })
  return resultado
}

const cacheRobots = new Map()

/**
 * Lê o robots.txt do domínio. Não bloqueia nada por conta própria: devolve o
 * que encontrou para o diagnóstico avisar o usuário. Uso pessoal é uma coisa,
 * produto público é outra — a decisão fica registrada na nota do vault.
 */
export async function lerRobots (origem) {
  if (cacheRobots.has(origem)) return cacheRobots.get(origem)
  const resultado = { lido: false, proibeBusca: false, temCrawlDelay: null, bruto: '', proibidos: [], permitidos: [] }
  try {
    const resposta = await buscar(new URL('/robots.txt', origem).href, { tentativas: 1 })
    if (resposta.ok && resposta.html && resposta.html.length < 200000) {
      resultado.lido = true
      resultado.bruto = resposta.html.slice(0, 4000)
      let valeParaTodos = false
      for (const linha of resposta.html.split(/\r?\n/)) {
        const l = linha.trim().toLowerCase()
        if (l.startsWith('user-agent:')) valeParaTodos = l.slice(11).trim() === '*'
        if (!valeParaTodos) continue
        if (l.startsWith('crawl-delay:')) {
          const n = parseFloat(l.slice(12))
          if (Number.isFinite(n)) resultado.temCrawlDelay = n
        }
        if (l.startsWith('disallow:')) {
          const caminho = l.slice(9).trim()
          if (caminho) resultado.proibidos.push(caminho)
          if (caminho === '/' || /^\/(busca|search|s\b|pesquisa)/.test(caminho)) {
            resultado.proibeBusca = true
          }
        }
        if (l.startsWith('allow:')) {
          const caminho = l.slice(6).trim()
          if (caminho) resultado.permitidos.push(caminho)
        }
      }
    }
  } catch { /* robots é informativo; falhar aqui não impede nada */ }
  cacheRobots.set(origem, resultado)
  return resultado
}

export function limparCache () {
  cache.clear()
}

/**
 * A URL pode ser lida, segundo o robots.txt da loja?
 *
 * Novo na v2. Na v1 o robots era lido só no diagnóstico, para AVISAR — e o
 * aviso não impedia nada. Agora vale nas rodadas: caminho proibido não é
 * buscado.
 *
 * Desempate do formato: entre um Allow e um Disallow que casam, ganha o mais
 * específico (prefixo mais longo). É o que permite "Disallow: /" convivendo
 * com "Allow: /produto/".
 *
 * Silêncio é permissão: sem robots.txt, ou sem regra que case, passa.
 */
export async function robotsPermite (url) {
  let alvo
  try { alvo = new URL(url) } catch { return { permitido: true, motivo: 'url inválida' } }
  const robots = await lerRobots(alvo.origin)
  if (!robots.lido) return { permitido: true, motivo: 'a loja não publica robots.txt' }

  const caminho = alvo.pathname + alvo.search
  const decisao = robotsDecide(caminho, robots.proibidos, robots.permitidos)
  if (!decisao.permitido) {
    return { permitido: false, motivo: `o robots.txt da loja não autoriza ${caminho.slice(0, 60)}` }
  }
  return { permitido: true, crawlDelay: robots.temCrawlDelay }
}

/**
 * A parte que decide, separada da que busca — é o pedaço com regra de verdade,
 * e assim dá para testar sem rede.
 */
export function robotsDecide (caminho, proibidos = [], permitidos = []) {
  const forca = (regra) => {
    // `*` e `$` não estão no padrão original do robots.txt, mas são a extensão
    // de fato que praticamente toda loja usa.
    const escapado = regra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Depois de escapar, o `*` do robots virou `\*`: volta a ser coringa.
    const corpo = escapado.replace(/\\\*/g, '.*')
    const terminaEmDolar = corpo.endsWith('\\$')
    const padrao = terminaEmDolar ? '^' + corpo.slice(0, -2) + '$' : '^' + corpo
    try { return new RegExp(padrao).test(caminho) ? regra.length : 0 } catch { return 0 }
  }
  const forcaProibicao = Math.max(0, ...proibidos.map(forca))
  const forcaPermissao = Math.max(0, ...permitidos.map(forca))
  // Só bloqueia quando o Disallow é ESTRITAMENTE mais específico: empate fica
  // com quem permite.
  return { permitido: forcaProibicao <= forcaPermissao, forcaProibicao, forcaPermissao }
}
