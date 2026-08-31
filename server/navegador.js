// Navegador de verdade, para as lojas que recusam requisição comum.
//
// Por que isso é necessário: Cloudflare e afins não olham só o cabeçalho — eles
// olham a impressão digital do TLS. O Node não "parece" um Chrome, e o bloqueio
// acontece antes de qualquer outra coisa. Foi o que derrubou Pichau, Terabyte,
// Magalu e Nike no primeiro teste.
//
// A solução aqui NÃO baixa 300MB de navegador: usa o Chrome (ou o Edge) que já
// está instalado na máquina, dirigido pelo playwright-core. Perfil próprio, em
// dados/perfil-navegador — não encosta no seu Chrome do dia a dia, não lê seus
// cookies, não vê suas senhas.
//
// É opcional de propósito: sem playwright-core instalado ou sem Chrome, tudo
// continua funcionando pelo caminho normal.

import { existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PASTA_DADOS } from './store.js'
import { buscar, pareceBloqueio } from './net.js'

const CAMINHOS_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

let chromium = null
let contexto = null
let fechando = null
let ultimoUso = 0

export function caminhoDoNavegador () {
  return CAMINHOS_CHROME.find(c => existsSync(c)) || null
}

async function carregarPlaywright () {
  if (chromium) return chromium
  try {
    const mod = await import('playwright-core')
    chromium = mod.chromium
    return chromium
  } catch {
    return null
  }
}

export async function disponivel () {
  const caminho = caminhoDoNavegador()
  if (!caminho) return { ok: false, motivo: 'não encontrei Chrome nem Edge instalado nesta máquina' }
  const pw = await carregarPlaywright()
  if (!pw) return { ok: false, motivo: 'playwright-core não está instalado (rode `npm install` na pasta do KiwiFinder)' }
  return { ok: true, caminho, navegador: caminho.includes('msedge') ? 'Edge' : 'Chrome' }
}

// Abertura do navegador é uma corrida: como as buscas rodam em paralelo, três
// consultas podiam pedir o navegador no mesmo instante e disparar três Chromes
// sobre o MESMO perfil — o primeiro ganha, os outros falham com "perfil em
// uso". Guardando a promessa da abertura, os concorrentes esperam a mesma.
let aberturaEmCurso = null

async function contextoAtivo (visivel) {
  if (contexto && !contexto._fechado) return contexto
  if (aberturaEmCurso) return aberturaEmCurso
  aberturaEmCurso = abrirContexto(visivel).finally(() => { aberturaEmCurso = null })
  return aberturaEmCurso
}

async function abrirContexto (visivel) {
  const pronto = await disponivel()
  if (!pronto.ok) throw new Error(pronto.motivo)

  // O Chrome recusa abrir um perfil que já está em uso — acontece quando duas
  // instâncias do KiwiFinder rodam juntas, ou quando uma janela ficou presa.
  // Em vez de falhar, cai para um perfil paralelo.
  const principal = join(PASTA_DADOS, 'perfil-navegador')
  let ultimoErro = null
  for (const tentativa of ['normal', 'destravar', 'paralelo']) {
    // Quando um Chrome anterior morreu sem fechar, sobra um arquivo de trava e
    // o perfil fica inutilizável para sempre. Antes de criar um perfil novo a
    // cada execução (o que enchia dados/ de pastas), remove a trava órfã.
    if (tentativa === 'destravar') destravarPerfil(principal)
    const perfil = tentativa === 'paralelo' ? join(PASTA_DADOS, `perfil-navegador-${process.pid}`) : principal
    try {
      contexto = await abrirPerfil(perfil, pronto.caminho, visivel)
      ultimoErro = null
      break
    } catch (erro) {
      ultimoErro = erro
    }
  }
  if (ultimoErro) throw new Error(`não consegui abrir o navegador: ${ultimoErro.message}`.slice(0, 200))

  contexto._fechado = false
  agendarFechamento()
  return contexto
}

// Arquivos de trava que o Chrome deixa para trás quando é encerrado à força.
const TRAVAS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']

function destravarPerfil (perfil) {
  for (const nome of TRAVAS) {
    try { rmSync(join(perfil, nome), { force: true, recursive: true }) } catch { /* já não existe */ }
  }
}

/**
 * Perfis paralelos são criados só quando o principal está travado. Depois eles
 * viram lixo em dados/ — esta limpeza roda na subida do servidor.
 */
export function limparPerfisOrfaos () {
  try {
    for (const nome of readdirSync(PASTA_DADOS)) {
      if (!/^perfil-navegador-\d+$/.test(nome)) continue
      const pid = Number(nome.split('-').pop())
      if (pid === process.pid) continue
      // Se o processo dono não existe mais, a pasta é lixo.
      let vivo = false
      try { process.kill(pid, 0); vivo = true } catch { vivo = false }
      if (!vivo) rmSync(join(PASTA_DADOS, nome), { force: true, recursive: true })
    }
  } catch { /* limpeza é higiene, não pode impedir a subida */ }
}

async function abrirPerfil (perfil, executablePath, visivel) {
  const ctx = await chromium.launchPersistentContext(perfil, {
    executablePath,
    headless: !visivel,
    viewport: { width: 1366, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    args: [
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-background-networking',
      // Janela real, mas jogada para fora da tela para não atrapalhar quem
      // está usando o computador na hora da rodada.
      ...(visivel === 'escondido' ? ['--window-position=-2400,-2400'] : [])
    ]
  })
  // v2 tirou daqui o disfarce de automação (`--disable-blink-features=
  // AutomationControlled` e o script que apagava `navigator.webdriver`). Eles
  // existiam para não parecer robô, o que só faz sentido para quem quer passar
  // por um bloqueio. Agora o navegador só é usado onde a loja atendeu de bom
  // grado e apenas monta a página em JavaScript — não há o que esconder.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US'] })
  })
  return ctx
}

// Navegador aberto consome memória; fecha sozinho depois de um tempo parado.
function agendarFechamento () {
  if (fechando) clearInterval(fechando)
  fechando = setInterval(async () => {
    if (!contexto || Date.now() - ultimoUso < 3 * 60 * 1000) return
    await fechar()
  }, 60 * 1000)
  fechando.unref?.()
}

export async function fechar () {
  if (!contexto) return
  const alvo = contexto
  contexto = null
  alvo._fechado = true
  try { await alvo.close() } catch { /* já pode ter morrido */ }
  if (fechando) { clearInterval(fechando); fechando = null }
}

// Visita a página inicial antes da busca, uma vez por domínio. É o que uma
// pessoa faz — e muitas lojas só montam a busca depois que a sessão existe.
// (Na v1 isto também servia para pegar cookie de liberação do Cloudflare; com
// a v2 respeitando a recusa, essas lojas nem chegam aqui.)
const aquecidos = new Set()

async function aquecer (ctx, url) {
  let origem
  try { origem = new URL(url).origin } catch { return }
  if (aquecidos.has(origem)) return
  aquecidos.add(origem)
  const pagina = await ctx.newPage()
  try {
    await pagina.goto(origem, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await pagina.waitForTimeout(1200)
  } catch { /* se o aquecimento falhar, a busca ainda pode dar certo */ } finally {
    await pagina.close().catch(() => {})
  }
}

const SINAIS_DESAFIO = /just a moment|um momento|verificando seu navegador|checking your browser|attention required|cf-browser-verification|enable javascript and cookies/i

/**
 * Abre a URL num navegador real e devolve o HTML já renderizado — mesmo
 * formato de resposta de `net.buscar()`, para o resto do código não precisar
 * saber por qual caminho o HTML chegou.
 */
export async function buscarComNavegador (url, opcoes = {}) {
  const { visivel = false, esperarPor = 'domcontentloaded', timeout = 45000 } = opcoes
  const inicio = Date.now()
  let pagina = null
  try {
    const ctx = await contextoAtivo(visivel)
    ultimoUso = Date.now()
    await aquecer(ctx, url)
    pagina = await ctx.newPage()
    let resposta = await pagina.goto(url, { waitUntil: esperarPor, timeout })

    // Desafio do Cloudflare costuma se resolver sozinho, mas leva tempo: fica
    // olhando de 2 em 2 segundos até 30s, em vez de chutar uma espera fixa.
    const limite = Date.now() + (opcoes.esperaDesafio ?? 30000)
    let recarregou = false
    while (Date.now() < limite) {
      const titulo = await pagina.title().catch(() => '')
      const corpo = await pagina.content().catch(() => '')
      if (!SINAIS_DESAFIO.test(titulo) && !SINAIS_DESAFIO.test(corpo.slice(0, 4000))) break
      await pagina.waitForTimeout(2000)
      if (!recarregou && Date.now() > limite - 12000) {
        recarregou = true
        resposta = await pagina.goto(url, { waitUntil: esperarPor, timeout }).catch(() => resposta)
      }
    }
    // Listagem montada por JavaScript precisa de um respiro para pintar — mas
    // esperar "rede parada" em loja grande é esperar por pixel de anúncio e
    // rastreador, que nunca param. Basta aparecer preço na tela; se aparecer
    // antes, sai antes.
    await pagina.waitForFunction(
      () => /R\$\s*\d/.test(document.body?.innerText || ''),
      { timeout: 6000 }
    ).catch(() => {})

    const html = await pagina.content()
    const status = resposta ? resposta.status() : 0
    ultimoUso = Date.now()
    // Aqui o critério de bloqueio é mais rigoroso que o do `net.js`: a página
    // renderizada de uma loja grande quase sempre tem a palavra "captcha" em
    // algum script, e isso não quer dizer que fomos barrados.
    const barrado = status >= 400 ||
      SINAIS_DESAFIO.test(html.slice(0, 6000)) ||
      html.length < 2000
    return {
      ok: status > 0 && status < 400 && !barrado,
      status,
      urlFinal: pagina.url(),
      tipo: 'text/html',
      html,
      ms: Date.now() - inicio,
      viaNavegador: true,
      bloqueado: barrado,
      motivo: status >= 400 ? `HTTP ${status}` : (barrado ? 'a loja mostrou uma página de verificação' : null)
    }
  } catch (erro) {
    return {
      ok: false,
      status: 0,
      urlFinal: url,
      tipo: '',
      html: '',
      ms: Date.now() - inicio,
      viaNavegador: true,
      bloqueado: false,
      erroRede: true,
      motivo: `navegador: ${erro.message}`.slice(0, 200)
    }
  } finally {
    if (pagina) await pagina.close().catch(() => {})
  }
}

// Seletores de caixa de busca, do mais explícito ao mais genérico.
const CAIXAS_DE_BUSCA = [
  'input[type="search"]',
  'input[name="q"]', 'input[name="s"]', 'input[name="search"]', 'input[name="busca"]',
  'input[name*="search" i]', 'input[name*="busca" i]', 'input[name*="term" i]',
  'input[id*="search" i]', 'input[id*="busca" i]',
  'input[placeholder*="busc" i]', 'input[placeholder*="pesquis" i]', 'input[placeholder*="search" i]'
]

/**
 * Último recurso para loja cuja busca só existe em JavaScript: abre a página
 * inicial num navegador real, DIGITA o termo na caixa de busca da própria loja
 * e espera o resultado aparecer.
 *
 * Foi o que destravou a Go Imports: ela responde 200 em qualquer caminho de
 * busca inventado, ignora `?s=` (devolve a home) e só filtra de verdade quando
 * alguém digita — a busca acontece no navegador, não no servidor dela.
 */
// Busca digitada é serializada por loja: são várias abas no mesmo navegador
// mexendo no mesmo site, e disparar três ao mesmo tempo fazia uma ler o
// resultado da outra (a busca "macbook air" voltava com iPhone e AirPods).
const filasDeDigitacao = new Map()

export function buscarDigitando (origem, termo, opcoes = {}) {
  const anterior = filasDeDigitacao.get(origem) || Promise.resolve()
  const proxima = anterior.then(() => digitarNaLoja(origem, termo, opcoes))
  filasDeDigitacao.set(origem, proxima.catch(() => {}))
  return proxima
}

async function digitarNaLoja (origem, termo, opcoes = {}) {
  const { visivel = 'escondido', seletorCaixa = null, timeout = 45000 } = opcoes
  const inicio = Date.now()
  let pagina = null
  try {
    const ctx = await contextoAtivo(visivel)
    ultimoUso = Date.now()
    pagina = await ctx.newPage()
    await pagina.goto(origem, { waitUntil: 'domcontentloaded', timeout })
    await pagina.waitForTimeout(1500)

    // Acha a caixa: a informada pela loja primeiro, depois a lista genérica.
    let usado = null
    for (const seletor of [seletorCaixa, ...CAIXAS_DE_BUSCA].filter(Boolean)) {
      const campo = pagina.locator(seletor).first()
      if (await campo.count().catch(() => 0)) {
        try {
          await campo.waitFor({ state: 'visible', timeout: 2500 })
          await campo.fill(termo, { timeout: 4000 })
          await campo.press('Enter')
          usado = seletor
          break
        } catch { /* caixa escondida atrás de um botão; tenta a próxima */ }
      }
    }
    if (!usado) {
      return { ok: false, status: 0, html: '', urlFinal: origem, motivo: 'não achei a caixa de busca da loja', viaNavegador: true, digitado: true }
    }

    // Esperar "aparecer preço" não basta: a página já tinha preços antes da
    // busca, então a leitura saía com os produtos da home. O sinal certo é o
    // resultado citar o que foi procurado.
    // Sinal de que a busca REALMENTE rodou. Procurar o termo no texto não
    // serve: o menu da loja já cita "MacBook", e a leitura saía antes do
    // resultado trocar. O que muda de verdade é o endereço (a loja escreve o
    // termo na URL) ou um aviso de contagem de resultados.
    const alvo = termo.split(/\s+/).filter(t => t.length > 2)[0] || termo
    await pagina.waitForFunction(
      (t) => {
        const url = decodeURIComponent(location.href).toLowerCase()
        if (url.includes(t)) return true
        return /(\d+\s+resultados?|resultados? (para|encontrad)|nenhum resultado)/i
          .test(document.body?.innerText || '')
      },
      alvo.toLowerCase(),
      { timeout: 20000 }
    ).catch(() => {})
    await pagina.waitForTimeout(1800)

    const html = await pagina.content()
    ultimoUso = Date.now()
    return {
      ok: html.length > 2000,
      status: 200,
      urlFinal: pagina.url(),
      tipo: 'text/html',
      html,
      ms: Date.now() - inicio,
      viaNavegador: true,
      digitado: true,
      seletorCaixa: usado,
      bloqueado: false,
      motivo: null
    }
  } catch (erro) {
    return {
      ok: false,
      status: 0,
      urlFinal: origem,
      html: '',
      ms: Date.now() - inicio,
      viaNavegador: true,
      digitado: true,
      motivo: `busca digitada falhou: ${erro.message}`.slice(0, 160)
    }
  } finally {
    if (pagina) await pagina.close().catch(() => {})
  }
}

/**
 * O caminho que o resto do sistema usa: tenta a requisição simples primeiro,
 * que é rápida e barata.
 *
 * ATENÇÃO — mudança de postura na v2. A v1 tratava recusa como obstáculo:
 * levou 403 ou recebeu uma casca vazia de HTML, abria o navegador real e
 * pegava a página assim mesmo. Isso é contornar bloqueio, e o Gabriel foi
 * explícito em não querer.
 *
 * Na v2, com `respeitarRecusa` (padrão), a recusa encerra o assunto: a loja
 * fica marcada como "só por acesso autorizado" e a via passa a ser feed de
 * afiliado ou API oficial. O navegador real continua valendo — mas só para
 * loja que ATENDEU a requisição e apenas monta a página em JavaScript, que é
 * usar o site como qualquer visitante usa.
 */
export async function buscarComFallback (url, opcoes = {}) {
  const {
    preferirNavegador = false,
    permitirNavegador = true,
    referer = null,
    modo = 'escondido',
    respeitarRecusa = true
  } = opcoes

  if (!preferirNavegador) {
    const simples = await buscar(url, { referer, tentativas: opcoes.tentativas ?? 2 })
    if (simples.ok && !simples.bloqueado) return simples
    if (!permitirNavegador) return simples

    // A loja disse não. Devolve a recusa como resultado, com a razão à mostra,
    // em vez de tentar outro caminho para entrar.
    if (respeitarRecusa && simples.bloqueado) {
      return {
        ...simples,
        recusada: true,
        motivo: simples.motivo || `a loja recusou a requisição (HTTP ${simples.status})`,
        precisaAcessoAutorizado: true
      }
    }

    // 404 é caminho errado, não bloqueio. Abrir o navegador aqui custava ~25s
    // por tentativa e estourava o tempo do teste antes de chegar na URL certa.
    if (simples.status === 404 && !simples.bloqueado) return simples
    const pronto = await disponivel()
    if (!pronto.ok) return { ...simples, navegadorIndisponivel: pronto.motivo }
    const comNavegador = await buscarComNavegador(url, { visivel: modo })
    // Se o navegador também não resolveu, devolve o erro mais informativo.
    return comNavegador.ok ? comNavegador : (simples.bloqueado ? simples : comNavegador)
  }

  // `preferirNavegador` (loja marcada como "precisa de navegador") também
  // passa pela regra: se a marca veio de uma recusa, ela não vale mais.
  if (respeitarRecusa && opcoes.recusouRequisicaoComum) {
    return recusa(url, 'a loja recusa requisição comum — a via para ela é feed ou API oficial')
  }

  // A marca "precisa de navegador" veio da v1, que não distinguia RECUSA de
  // PÁGINA MONTADA EM JAVASCRIPT — as duas davam no mesmo caminho. Na v2 a
  // diferença é o que separa o legítimo do que o Gabriel não quer fazer, então
  // antes de abrir o navegador o motivo é classificado uma vez.
  if (respeitarRecusa && !opcoes.exigirNavegador && !opcoes.motivoNavegador) {
    const sonda = await buscar(url, { referer, tentativas: 1 })
    const classificacao = classificarRecusa(sonda)
    if (classificacao.recusa) {
      return recusa(url, classificacao.motivo, { status: sonda.status })
    }
    // Página veio inteira e é só JavaScript que falta: seguir com o navegador
    // é usar o site como qualquer visitante usa.
  }

  if (opcoes.exigirNavegador) {
    const pronto = await disponivel()
    if (!pronto.ok) return { ok: false, navegadorIndisponivel: pronto.motivo }
    return await buscarComNavegador(url, { visivel: modo })
  }

  const pronto = await disponivel()
  if (!pronto.ok) return await buscar(url, { referer, tentativas: opcoes.tentativas ?? 2 })
  const direto = await buscarComNavegador(url, { visivel: modo })
  if (direto.ok) return direto
  return await buscar(url, { referer, tentativas: 1 })
}

/**
 * Recusa é resposta, não obstáculo. Fica com o motivo à mostra para a tela
 * poder explicar por que aquela loja precisa de feed ou API.
 */
function recusa (url, motivo, extra = {}) {
  return {
    ok: false,
    status: 0,
    html: '',
    urlFinal: url,
    recusada: true,
    precisaAcessoAutorizado: true,
    motivo,
    ...extra
  }
}

// Uma resposta de 200 com quase nada dentro não é "página que precisa de
// JavaScript": é a loja servindo conteúdo diferente para quem não é navegador.
// A Amazon devolve ~2KB de casca; a Go Imports, que só monta a busca em JS,
// devolve 233KB de página de verdade. A distância entre as duas é grande o
// bastante para o corte ser seguro.
const CASCA_MAXIMA = 8000

/**
 * A loja recusou? Distingue os três casos que importam:
 *   403/429/captcha ......... recusa explícita
 *   200 com casca vazia ..... recusa disfarçada
 *   200 com página inteira .. só falta JavaScript, pode seguir
 */
export function classificarRecusa (resposta) {
  if (!resposta) return { recusa: true, motivo: 'sem resposta da loja' }
  if (resposta.bloqueado) {
    return { recusa: true, motivo: `a loja recusou a requisição (HTTP ${resposta.status})` }
  }
  if (resposta.ok && (resposta.html || '').length < CASCA_MAXIMA) {
    return {
      recusa: true,
      motivo: `a loja respondeu ${(resposta.html || '').length} bytes — serve a página completa só para navegador`
    }
  }
  if (!resposta.ok) {
    return { recusa: true, motivo: resposta.motivo || `a loja respondeu HTTP ${resposta.status}` }
  }
  return { recusa: false, motivo: 'a loja atendeu; a página é montada em JavaScript' }
}
