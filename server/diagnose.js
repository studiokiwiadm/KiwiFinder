// Teste de compatibilidade da loja — a etapa nº 1 do MVP.
//
// O usuário digita uma loja e o KiwiFinder responde, antes de aceitar o
// cadastro, se dá para rastrear aquela loja e por quê. Três vereditos:
//
//   ✅ compativel   — achou a busca, leu os resultados, extraiu nome e preço
//   ⚠️ parcial      — dá para ler, mas com limitação declarada
//   ❌ incompativel — bloqueia, exige login, ou não tem busca legível
//
// O diagnóstico fica salvo com data na loja e pode ser rodado de novo: site de
// loja muda, e o que funciona hoje quebra em três meses.

import { buscar, lerRobots } from './net.js'
import { buscarComFallback, buscarDigitando, disponivel as navegadorDisponivel } from './navegador.js'
import { parse, selecionarTodos, attr, textoLimpo, elementos } from './html.js'
import { extrairResultados, absoluta } from './extract.js'
import { tokensDe, compacto } from './nlp.js'
import { LOJAS_CONHECIDAS } from './library.js'

const TERMO_PADRAO = 'notebook'

// Padrões de URL de busca mais comuns no varejo brasileiro, em ordem de aposta.
const PADROES = [
  '/busca?q={t}',
  '/busca/{t}',
  '/search?q={t}',
  '/s?k={t}',
  '/?s={t}',
  '/pesquisa?t={t}',
  '/busca?termo={t}',
  '/catalogsearch/result/?q={t}',
  '/{t}?map=ft',
  '/search/?q={t}',
  '/produtos?busca={t}',
  '/loja/busca.php?loja=&palavra_busca={t}'
]

export function normalizarEntrada (entrada) {
  let txt = String(entrada || '').trim()
  if (!txt) return null
  if (!/^https?:\/\//i.test(txt)) txt = 'https://' + txt.replace(/^\/+/, '')
  try {
    const url = new URL(txt)
    if (!url.hostname.includes('.')) return null
    return { origem: url.origin, host: url.hostname }
  } catch { return null }
}

function nomeDaLoja (raiz, host) {
  const porOg = selecionarTodos(raiz, 'meta[property=og:site_name]')[0]
  if (porOg && attr(porOg, 'content')) return attr(porOg, 'content').trim()
  const titulo = selecionarTodos(raiz, 'title')[0]
  if (titulo) {
    const txt = textoLimpo(titulo).split(/[|\-–—:]/)[0].trim()
    if (txt && txt.length < 40) return txt
  }
  return host.replace(/^www\./, '').split('.')[0].replace(/^./, c => c.toUpperCase())
}

/**
 * Lê os formulários da home para descobrir a URL de busca da própria loja —
 * é mais confiável do que adivinhar padrão, porque vem do site.
 */
function buscaPeloFormulario (raiz, origem) {
  const achados = []
  for (const form of selecionarTodos(raiz, 'form')) {
    const metodo = (attr(form, 'method') || 'get').toLowerCase()
    if (metodo !== 'get') continue
    const acao = absoluta(attr(form, 'action') || '/', origem)
    if (!acao) continue
    for (const campo of elementos(form)) {
      if (campo.tag !== 'input') continue
      const tipo = (attr(campo, 'type') || 'text').toLowerCase()
      const nome = attr(campo, 'name')
      if (!nome) continue
      const pista = [nome, attr(campo, 'id'), attr(campo, 'placeholder'), attr(campo, 'class')].join(' ')
      // Nome exato curto (q, s, k) ou qualquer campo que *contenha* palavra de
      // busca. A Amazon usa `field-keywords`, que a versão anterior desta
      // regra não reconhecia — e era por isso que ela dava incompatível.
      const parece = tipo === 'search' ||
        /^(q|s|k|kw|query)$/i.test(nome) ||
        /(busca|search|termo|term|keyword|palavra|pesquis|query)/i.test(pista)
      if (!parece) continue
      const extras = []
      for (const outro of elementos(form)) {
        if (outro.tag === 'input' && (attr(outro, 'type') || '').toLowerCase() === 'hidden') {
          const n = attr(outro, 'name')
          if (n && attr(outro, 'value')) extras.push(`${encodeURIComponent(n)}=${encodeURIComponent(attr(outro, 'value'))}`)
        }
      }
      const separador = acao.includes('?') ? '&' : '?'
      const query = [`${encodeURIComponent(nome)}={t}`, ...extras].join('&')
      achados.push(acao + separador + query)
    }
  }
  return [...new Set(achados)]
}

function montarUrl (padrao, origem, termo) {
  const codificado = encodeURIComponent(termo)
  if (padrao.startsWith('http')) return padrao.replace('{t}', codificado)
  return origem.replace(/\/$/, '') + padrao.replace('{t}', codificado)
}

/**
 * O resultado tem a ver com o que foi buscado? Um caminho de busca inventado
 * costuma responder 200 e devolver a home cheia de produto aleatório — foi o
 * que a KaBuM fez com `/busca?q=`. Sem esta conferência, o teste aprovaria uma
 * URL que nunca busca nada.
 */
function relevancia (itens, termo) {
  const tokens = tokensDe(termo).filter(t => t.length > 2).map(compacto)
  if (!tokens.length || !itens.length) return 1
  const casam = itens.filter(i => {
    const nome = compacto(i.nome || '')
    return tokens.some(t => nome.includes(t))
  }).length
  return casam / itens.length
}

const CONFIANCA_ESTRATEGIA = { jsonld: 1.6, microdata: 1.4, seletores: 1.2, estado: 1.0, heuristica: 0.9 }

function avaliarCandidato (resposta, seletores, termo) {
  if (!resposta.ok || !resposta.html) return null
  const { itens, relatorio } = extrairResultados(resposta.html, resposta.urlFinal, seletores)
  const comPreco = itens.filter(i => i.preco)
  const rel = relevancia(comPreco.length ? comPreco : itens, termo)
  const comLink = comPreco.filter(i => i.url).length
  const base = comLink || comPreco.length
  let voltouParaHome = false
  try {
    const u = new URL(resposta.urlFinal)
    voltouParaHome = (u.pathname === '/' || u.pathname === '') && !u.search
  } catch { /* URL estranha não invalida nada por si só */ }

  return {
    itens,
    comPreco,
    relatorio,
    relevancia: rel,
    voltouParaHome,
    pontos: voltouParaHome ? 0 : base * rel * (CONFIANCA_ESTRATEGIA[relatorio.escolhida] || 1)
  }
}

/**
 * Roda o diagnóstico completo. `aoAndar` recebe cada passo para a interface
 * mostrar progresso — o teste leva alguns segundos por respeitar intervalo
 * entre requisições.
 */
export async function diagnosticar (entrada, opcoes = {}) {
  const { termo = TERMO_PADRAO, seletores = null, buscaUrlConhecida = null, aoAndar = () => {} } = opcoes
  const alvo = normalizarEntrada(entrada)
  const passos = []
  const anotar = (texto, ok = true, detalhe = null) => {
    const passo = { texto, ok, detalhe, ts: new Date().toISOString() }
    passos.push(passo)
    aoAndar(passo)
    return passo
  }

  if (!alvo) {
    return montar('incompativel', 'Endereço inválido',
      'Não consegui entender esse endereço. Use algo como `kabum.com.br`.', { passos })
  }

  anotar(`Abrindo ${alvo.host}`)
  let home = await buscar(alvo.origem, { tentativas: 2 })
  let precisaNavegador = false

  // Bloqueou a requisição simples? Antes de condenar a loja, tenta com um
  // navegador de verdade — é o que separa "não dá" de "dá, mas dá trabalho".
  if ((home.bloqueado || !home.ok) && opcoes.permitirNavegador !== false) {
    const nav = await navegadorDisponivel()
    if (nav.ok) {
      anotar('Requisição simples foi barrada — tentando com navegador real', true, `usando o ${nav.navegador} instalado`)
      const comNavegador = await buscarComFallback(alvo.origem, { preferirNavegador: true })
      if (comNavegador.ok) {
        home = comNavegador
        precisaNavegador = true
        anotar('O navegador passou', true, `${comNavegador.ms}ms`)
      }
    }
  }

  if (!home.ok && home.erroRede) {
    anotar('A loja não respondeu', false, home.motivo)
    return montar('incompativel', 'A loja não respondeu', home.motivo, { passos, host: alvo.host, origem: alvo.origem })
  }
  if (!home.ok || home.bloqueado) {
    anotar('A loja bloqueou o acesso automatizado', false, `HTTP ${home.status}`)
    const nav = await navegadorDisponivel()
    return montar('incompativel', 'A loja bloqueia acesso automatizado',
      `A página inicial respondeu com bloqueio (HTTP ${home.status}${home.status === 403 ? ' — proibido' : ''})` +
      (nav.ok
        ? ', inclusive abrindo com um navegador real. Proteção desse nível (Cloudflare, PerimeterX, Akamai) só cede com sessão de gente de verdade.'
        : '. Instalar o navegador auxiliar pode resolver — veja o LEIA-ME.'),
      { passos, host: alvo.host, origem: alvo.origem })
  }

  const raizHome = parse(home.html || '')
  const nome = nomeDaLoja(raizHome, alvo.host)
  anotar(`Loja identificada: ${nome}`, true, `respondeu em ${home.ms}ms`)

  const robots = await lerRobots(alvo.origem)
  if (robots.lido) {
    anotar(robots.proibeBusca ? 'robots.txt pede para não varrer a busca' : 'robots.txt lido',
      !robots.proibeBusca,
      robots.temCrawlDelay ? `crawl-delay de ${robots.temCrawlDelay}s` : null)
  }

  // --------------------------------------------------- achar a URL de busca
  const candidatos = []
  if (buscaUrlConhecida) candidatos.push(buscaUrlConhecida)
  // Se a loja está na biblioteca com padrão de busca conhecido, ele entra na
  // frente: economiza tentativas e evita descobrir errado uma loja conhecida.
  const daBiblioteca = LOJAS_CONHECIDAS.find(l =>
    l.buscaUrl && (l.host === alvo.host || l.host.replace(/^www\./, '') === alvo.host.replace(/^www\./, '')))
  if (daBiblioteca) {
    candidatos.push(daBiblioteca.buscaUrl.replace('{q}', '{t}'))
    anotar(`Conheço esta loja: testando a busca padrão dela primeiro`)
  }
  const formularios = buscaPeloFormulario(raizHome, alvo.origem)
  candidatos.push(...formularios)
  candidatos.push(...PADROES.map(p => alvo.origem.replace(/\/$/, '') + p))
  const unicos = [...new Set(candidatos)].slice(0, 10)
  anotar(`Procurando a busca da loja (${unicos.length} caminhos possíveis)`)

  let melhor = null
  let tentados = 0
  let bloqueios = 0
  let buscaDigitada = null
  // Teto de tempo. Sem isso, uma loja que exige navegador e tem muitos
  // caminhos candidatos leva 10 minutos — a Fast Shop levou, no teste.
  const prazo = Date.now() + (opcoes.limiteMs ?? (precisaNavegador ? 150000 : 90000))
  for (const padrao of unicos) {
    if (Date.now() > prazo) {
      anotar(`Parei a busca por tempo (${tentados} caminhos testados)`, false,
        'loja lenta ou com muitos caminhos; dá para informar a URL de busca à mão')
      break
    }
    const url = montarUrl(padrao, alvo.origem, termo)
    tentados++
    const prioritario = tentados <= (daBiblioteca ? 2 : 1) + formularios.length
    let resposta = precisaNavegador
      ? await buscarComFallback(url, { preferirNavegador: true })
      : await buscarComFallback(url, { referer: alvo.origem, tentativas: 1, permitirNavegador: opcoes.permitirNavegador !== false })

    // Resposta 200 curta demais é casca: a Amazon devolve 2KB para requisição
    // comum e a página inteira só para navegador. Como não é bloqueio
    // declarado, o plano B não entrava sozinho — aqui ele entra, mas só nos
    // caminhos que têm cara de certos (biblioteca e formulário da loja).
    if (!precisaNavegador && prioritario && resposta.ok && !resposta.viaNavegador &&
        resposta.html.length < 25000 && opcoes.permitirNavegador !== false) {
      anotar(`${caminhoCurto(url)} respondeu vazio — tentando com navegador real`)
      const comNavegador = await buscarComFallback(url, { preferirNavegador: true })
      if (comNavegador.ok && comNavegador.html.length > resposta.html.length) resposta = comNavegador
    }
    if (resposta.viaNavegador && resposta.ok) precisaNavegador = true
    if (resposta.bloqueado) {
      // Não desiste no primeiro bloqueio: loja grande às vezes protege um
      // caminho e deixa outro aberto. Só condena depois de tentar todos.
      bloqueios++
      anotar(`Bloqueado ao buscar em ${caminhoCurto(url)}`, false, `HTTP ${resposta.status}`)
      continue
    }
    if (!resposta.ok) continue
    const avaliado = avaliarCandidato(resposta, seletores, termo)
    if (!avaliado || (!avaliado.itens.length && !avaliado.comPreco.length)) continue
    if (avaliado.voltouParaHome) {
      anotar(`${caminhoCurto(url)} caiu de volta na página inicial`, false, 'não é a busca da loja')
      continue
    }
    if (avaliado.relevancia < 0.2) {
      anotar(`${caminhoCurto(url)} respondeu, mas com produtos sem relação com "${termo}"`, false,
        `só ${Math.round(avaliado.relevancia * 100)}% dos resultados citam o termo`)
      continue
    }
    anotar(`${caminhoCurto(url)} devolveu ${avaliado.itens.length} resultados`, true,
      `via ${nomeEstrategia(avaliado.relatorio.escolhida)}, ${Math.round(avaliado.relevancia * 100)}% batendo com o termo`)
    if (!melhor || avaliado.pontos > melhor.avaliado.pontos) {
      melhor = { padrao, url, avaliado, resposta }
    }
    if (avaliado.comPreco.length >= 8 && avaliado.relatorio.temEstruturado && avaliado.relevancia > 0.6) break
    if (tentados >= 8) break
  }

  // Nenhuma URL funcionou. Antes de desistir, tenta digitar na caixa de busca
  // da própria loja com um navegador real — é o único jeito para loja cuja
  // busca roda inteiramente em JavaScript.
  if (!melhor && opcoes.permitirNavegador !== false) {
    const nav = await navegadorDisponivel()
    if (nav.ok) {
      anotar('Nenhum endereço de busca funcionou — vou digitar na caixa de busca da loja')
      const digitada = await buscarDigitando(alvo.origem, termo)
      if (digitada.ok) {
        const avaliado = avaliarCandidato(digitada, seletores, termo)
        if (avaliado && avaliado.comPreco.length && avaliado.relevancia >= 0.2) {
          anotar(`Funcionou: ${avaliado.comPreco.length} produtos`, true,
            `${Math.round(avaliado.relevancia * 100)}% batendo com "${termo}"`)
          melhor = { padrao: null, url: digitada.urlFinal, avaliado, resposta: digitada }
          precisaNavegador = true
          buscaDigitada = { seletorCaixa: digitada.seletorCaixa }
        } else {
          anotar('Digitei na busca, mas o resultado não bateu com o termo', false)
        }
      } else {
        anotar('Não consegui usar a caixa de busca', false, digitada.motivo)
      }
    }
  }

  if (!melhor && bloqueios) {
    const nav = await navegadorDisponivel()
    anotar('Todos os caminhos de busca foram bloqueados', false)
    return montar('incompativel', 'A loja bloqueia a página de busca',
      `Testei ${tentados} caminhos e ${bloqueios} responderam com bloqueio` +
      (nav.ok
        ? ', inclusive abrindo com um navegador real. Proteção nesse nível só cede com sessão de gente de verdade.'
        : '. Um navegador auxiliar instalado poderia resolver — veja o LEIA-ME.'),
      { passos, nome, host: alvo.host, origem: alvo.origem })
  }

  if (!melhor) {
    anotar('Nenhum caminho de busca devolveu resultados legíveis', false)
    return montar('incompativel', 'Não achei a busca desta loja',
      'Testei os caminhos de busca mais comuns e o formulário da página inicial, e nenhum devolveu uma ' +
      'lista de produtos legível. Isso costuma acontecer quando a busca é montada por JavaScript depois ' +
      'que a página abre. Você pode informar a URL de busca manualmente, com `{q}` no lugar do termo.',
      { passos, nome, host: alvo.host, origem: alvo.origem })
  }

  // ------------------------------------------------------------- veredito
  const { avaliado } = melhor
  const total = avaliado.itens.length
  const comPreco = avaliado.comPreco.length
  const estruturado = avaliado.relatorio.temEstruturado
  const amostra = avaliado.comPreco.slice(0, 5).map(i => ({
    nome: i.nome, preco: i.preco, url: i.url, marca: i.marca || '', gtin: i.gtin || '', sku: i.sku || ''
  }))
  const comIdentificador = avaliado.comPreco.filter(i => i.gtin || i.mpn).length

  const limitacoes = []
  if (buscaDigitada) {
    limitacoes.push('esta loja não tem endereço de busca: o KiwiFinder abre a página inicial e digita na caixa de busca dela, o que é mais lento e depende do visual do site continuar igual')
  }
  if (precisaNavegador) {
    limitacoes.push('esta loja só responde com navegador real — a busca vai ser mais lenta (uns 20s por consulta) e abre uma janela do Chrome fora da tela')
  }
  if (!estruturado) limitacoes.push('a loja não expõe dados estruturados — a correspondência vai depender só do nome do anúncio')
  if (!comIdentificador) limitacoes.push('nenhum resultado trouxe EAN/GTIN ou MPN')
  if (comPreco < total * 0.6) limitacoes.push(`só ${comPreco} de ${total} resultados trouxeram preço na listagem`)
  if (robots.proibeBusca) limitacoes.push('o robots.txt da loja pede para robôs não varrerem a busca')
  if (avaliado.relatorio.escolhida === 'heuristica') limitacoes.push('a leitura é por heurística de layout, que quebra se a loja mudar o visual')

  let veredito, titulo, explicacao
  if (comPreco === 0) {
    veredito = 'parcial'
    titulo = 'Acho os produtos, mas não o preço'
    explicacao = 'A busca respondeu e consegui ler os nomes dos produtos, mas nenhum preço apareceu na ' +
      'listagem. Dá para monitorar entrando na página de cada produto, o que é mais lento e mais frágil.'
  } else if (comPreco >= 3 && estruturado && !robots.proibeBusca) {
    veredito = 'compativel'
    titulo = 'Loja compatível'
    explicacao = `Busca encontrada, ${comPreco} produtos lidos com nome e preço, via ` +
      `${nomeEstrategia(avaliado.relatorio.escolhida)}${comIdentificador ? ` — e ${comIdentificador} deles trouxeram identificador de fabricante` : ''}.`
  } else if (comPreco >= 2) {
    veredito = 'parcial'
    titulo = 'Dá para acompanhar, com limitação'
    explicacao = `Consegui ler ${comPreco} produtos com preço via ${nomeEstrategia(avaliado.relatorio.escolhida)}. ` +
      'Funciona, mas com as ressalvas abaixo — vale cadastrar mesmo assim: acompanhar com limite é melhor que não acompanhar.'
  } else {
    veredito = 'parcial'
    titulo = 'Leitura fraca'
    explicacao = `Só consegui ler ${comPreco} produto com preço nesta busca de teste. Pode ser o termo ` +
      `usado no teste ("${termo}") não existir nesta loja — tente de novo com um termo que ela venda.`
  }

  anotar(`Veredito: ${titulo}`, veredito !== 'incompativel')

  return montar(veredito, titulo, explicacao, {
    passos,
    nome,
    host: alvo.host,
    origem: alvo.origem,
    // Busca digitada não tem URL de busca: a loja é consultada abrindo a home
    // e escrevendo na caixa dela.
    buscaUrl: !melhor.padrao
      ? null
      : (melhor.padrao.includes('{t}')
          ? melhor.padrao.replace('{t}', '{q}')
          : melhor.url.replace(encodeURIComponent(termo), '{q}')),
    estrategia: avaliado.relatorio.escolhida,
    estrategias: avaliado.relatorio.estrategias,
    temEstruturado: estruturado,
    precisaNavegador,
    buscaDigitada,
    limitacoes,
    amostra,
    lidos: total,
    comPreco,
    relevancia: Number((avaliado.relevancia * 100).toFixed(0)),
    termoTestado: termo,
    robots: { proibeBusca: robots.proibeBusca, crawlDelay: robots.temCrawlDelay }
  })
}

function montar (veredito, titulo, explicacao, extra) {
  return {
    veredito,             // compativel | parcial | incompativel
    titulo,
    explicacao,
    testadoEm: new Date().toISOString(),
    limitacoes: [],
    amostra: [],
    passos: [],
    ...extra
  }
}

function caminhoCurto (url) {
  try {
    const u = new URL(url)
    return (u.pathname + u.search).slice(0, 48)
  } catch { return url.slice(0, 48) }
}

export function nomeEstrategia (id) {
  return ({
    jsonld: 'dados estruturados (JSON-LD)',
    estado: 'o próprio JSON da loja',
    microdata: 'microdata schema.org',
    seletores: 'seletores configurados',
    heuristica: 'leitura do layout'
  })[id] || 'leitura direta'
}
