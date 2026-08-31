// Rodada de atualização: buscar, casar, gravar histórico, achar oportunidade.
//
// Uma rodada percorre consulta × loja, lê o que a loja devolveu, decide o que
// é relevante, agrupa anúncios de lojas diferentes no mesmo produto e registra
// o preço no tempo. O histórico é gravado por (produto, loja) e nunca por URL:
// anúncio pode sumir e voltar com outro endereço, o histórico continua.

import { db, salvar, proximoId, agora } from './store.js'
import { buscar, robotsPermite } from './net.js'
import { buscarComFallback, buscarDigitando } from './navegador.js'
import { extrairResultados, extrairProduto, proximaPagina, deduplicar } from './extract.js'
import { interpretar, tokensDe, compacto } from './nlp.js'
import { pontuar, filtrarPorSanidadeDePreco, chaveProduto, mesmoProduto, mesmoProdutoNaBusca, marcaConfiavel } from './match.js'
import { aplicarCupom } from './cupom.js'

let rodadaEmCurso = null
const ouvintes = new Set()

export function aoProgredir (fn) {
  ouvintes.add(fn)
  return () => ouvintes.delete(fn)
}

function emitir (evento) {
  for (const fn of ouvintes) {
    try { fn(evento) } catch { /* ouvinte quebrado não derruba a rodada */ }
  }
}

export function rodadaAtual () {
  return rodadaEmCurso
}

// ------------------------------------------------------------------- coleta

export function montarUrlBusca (loja, termo) {
  const codificado = encodeURIComponent(termo)
  if (loja.buscaUrl && loja.buscaUrl.includes('{q}')) {
    return loja.buscaUrl.replace('{q}', codificado)
  }
  return `${loja.origem.replace(/\/$/, '')}/busca?q=${codificado}`
}

/**
 * Cache de uma rodada só: mesma loja + mesmo termo é buscado UMA vez, mesmo
 * que várias consultas precisem dele.
 *
 * Isso importa mais do que parece. Cada domínio atende um pedido por vez (por
 * educação, ver net.js), então o tempo da rodada cresce junto com o número de
 * buscas por loja — e loja que exige navegador leva ~8s por busca. Com
 * "macbook air m4" e "macbook air 16gb" cadastrados, o termo base é o mesmo e
 * a página era pedida duas vezes.
 *
 * Guarda a PROMESSA, não o resultado: como as consultas coletam em paralelo,
 * duas podem pedir o mesmo termo no mesmo instante — assim a segunda espera a
 * primeira em vez de disparar outra requisição.
 */
let cacheDaRodada = null

export function abrirCacheDaRodada () { cacheDaRodada = new Map() }
export function fecharCacheDaRodada () {
  const tamanho = cacheDaRodada ? cacheDaRodada.size : 0
  cacheDaRodada = null
  return tamanho
}

async function coletar (loja, termo, paginas = 1) {
  if (cacheDaRodada) {
    const chave = `${loja.id}|${termo}|${paginas}`
    if (cacheDaRodada.has(chave)) {
      const guardado = await cacheDaRodada.get(chave)
      return { ...guardado, doCache: true }
    }
    const promessa = coletarDeVerdade(loja, termo, paginas)
    cacheDaRodada.set(chave, promessa)
    return await promessa
  }
  return coletarDeVerdade(loja, termo, paginas)
}

/**
 * Busca digitada é a mais frágil das três formas de ler uma loja: depende de a
 * página aplicar o filtro antes de a gente ler. Quando várias buscas rodam
 * juntas, a máquina fica ocupada e a leitura sai antes da hora — o resultado
 * vem vazio ou com as recomendações da home.
 *
 * Por isso o resultado é CONFERIDO: se o que voltou não fala do que foi pedido,
 * tenta de novo. Uma vez só, para não virar espera infinita.
 */
async function digitarComConferencia (loja, termo, modo) {
  const chaves = tokensDe(termo).filter(t => t.length > 2).map(compacto)
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const resposta = await buscarDigitando(loja.origem, termo, {
      visivel: modo,
      seletorCaixa: loja.buscaDigitada.seletorCaixa
    })
    if (!resposta.ok) return resposta
    if (!chaves.length) return resposta

    const { itens } = extrairResultados(resposta.html, resposta.urlFinal, loja.seletores || null)
    const relacionados = itens.filter(i => {
      const nome = compacto(i.nome || '')
      return chaves.some(c => nome.includes(c))
    }).length
    if (itens.length && relacionados / itens.length >= 0.2) return resposta
    if (tentativa === 0) {
      emitir({ tipo: 'rodada', fase: 'repetindo', texto: `${loja.nome} devolveu resultado sem relação com "${termo}" — tentando de novo` })
    }
  }
  // Devolve vazio de propósito: melhor não trazer nada do que trazer a vitrine
  // da loja como se fosse resultado de busca.
  return { ok: true, status: 200, html: '<html></html>', urlFinal: loja.origem, viaNavegador: true, digitado: true }
}


// Reavalia a marca "precisa de navegador" uma vez por dia. Mais que isso é
// desperdício; menos, e o app fica preso a uma limitação que a loja já removeu.
function precisaReavaliar (loja) {
  if (!loja.navegadorReavaliadoEm) return true
  return Date.now() - new Date(loja.navegadorReavaliadoEm).getTime() > 24 * 3600 * 1000
}

async function coletarDeVerdade (loja, termo, paginas = 1) {
  const config = db().config
  const url = montarUrlBusca(loja, termo)
  const modo = config.navegadorVisivel ? true : 'escondido'
  const todos = []
  let relatorio = null
  let proxima = url

  for (let pagina = 1; pagina <= paginas && proxima; pagina++) {
    // v2: o robots.txt da loja decide antes de qualquer pedido. Sem isto, o
    // arquivo era lido e ignorado — o pior dos dois mundos, porque o app sabia
    // e ia assim mesmo.
    if (config.respeitarRobots !== false && !loja.buscaDigitada) {
      const permissao = await robotsPermite(proxima)
      if (!permissao.permitido) {
        loja.robotsProibe = true
        loja.ultimoErro = permissao.motivo
        return { itens: [], erro: `${loja.nome}: ${permissao.motivo}`, robotsProibe: true }
      }
      loja.robotsProibe = false
    }

    // "Precisa de navegador" é uma marca do passado, e site muda. A Amazon
    // exigia navegador quando o app foi escrito; hoje a requisição comum traz
    // 45 itens com preço e link em 1,2s, contra 43 em 5,4s pelo navegador —
    // melhor E quatro vezes mais rápido.
    //
    // Em vez de confiar na marca para sempre, a loja é reavaliada de tempos em
    // tempos: tenta o caminho barato e, se ele resolver, a marca cai. Custa uma
    // requisição comum; economiza a abertura do navegador em toda rodada.
    if (loja.precisaNavegador && !loja.buscaDigitada && precisaReavaliar(loja)) {
      const barato = await buscar(proxima, { referer: loja.origem, tentativas: 1, usarCache: false })
      loja.navegadorReavaliadoEm = agora()
      if (barato.ok && !barato.bloqueado) {
        const teste = extrairResultados(barato.html, barato.urlFinal, loja.seletores || null)
        const uteis = teste.itens.filter(i => i.preco && i.url).length
        if (uteis >= 3) {
          loja.precisaNavegador = false
          loja.motivoNavegador = null
          emitir({ tipo: 'rodada', fase: 'aprendendo', texto: `${loja.nome} não precisa mais de navegador — ${uteis} itens por requisição comum` })
          relatorio = relatorio || teste.relatorio
          todos.push(...teste.itens)
          proxima = pagina < paginas ? proximaPagina(teste.raiz, barato.urlFinal, pagina) : null
          continue
        }
      }
    }

    // Loja cuja busca só existe em JavaScript não tem URL para chamar: o jeito
    // é abrir a home e digitar na caixa de busca dela.
    const resposta = loja.buscaDigitada
      ? await digitarComConferencia(loja, termo, modo)
      : await buscarComFallback(proxima, {
        referer: loja.origem,
        tentativas: 2,
        preferirNavegador: Boolean(loja.precisaNavegador),
        permitirNavegador: config.usarNavegador !== false,
        respeitarRecusa: config.respeitarRecusa !== false,
        recusouRequisicaoComum: Boolean(loja.recusouRequisicaoComum),
        // Uma vez classificado, não se classifica de novo toda rodada.
        motivoNavegador: loja.motivoNavegador || null,
        modo
      })

    // A loja recusou. Na v2 isso encerra o assunto e vira estado dela: passa a
    // aparecer como "só por acesso autorizado", que é o convite para cadastrar
    // o feed de afiliado ou a API oficial.
    if (resposta.recusada || resposta.precisaAcessoAutorizado) {
      loja.recusouRequisicaoComum = true
      loja.precisaAcessoAutorizado = true
      loja.precisaNavegador = false
      loja.ultimoErro = resposta.motivo || 'a loja recusou a requisição'
      return {
        itens: [],
        erro: `${loja.nome}: ${loja.ultimoErro}`,
        precisaAcessoAutorizado: true
      }
    }

    if (!resposta.ok || resposta.bloqueado) {
      if (pagina > 1) break            // primeira página já rendeu; segue a vida
      return {
        itens: [],
        erro: resposta.bloqueado
          ? `${loja.nome} bloqueou o acesso (HTTP ${resposta.status})`
          : `${loja.nome}: ${resposta.motivo || 'sem resposta'}`
      }
    }
    // Navegador usado numa loja que ATENDEU: é montagem por JavaScript, não
    // recusa. Vale lembrar para não pagar duas vezes o mesmo caminho.
    if (resposta.viaNavegador) {
      loja.precisaNavegador = true
      loja.precisaAcessoAutorizado = false
      // Chegou até aqui pelo navegador sem ter sido recusada: a página é
      // montada em JavaScript, e isso fica registrado para a próxima rodada
      // não repetir a sondagem.
      loja.motivoNavegador = 'javascript'
    }
    const extraido = extrairResultados(resposta.html, resposta.urlFinal, loja.seletores || null)
    relatorio = relatorio || extraido.relatorio
    todos.push(...extraido.itens)
    proxima = pagina < paginas ? proximaPagina(extraido.raiz, resposta.urlFinal, pagina) : null
  }

  return { itens: deduplicar(todos), relatorio, url }
}

// --------------------------------------------------------- produtos e ofertas

function acharProdutoExistente (consultaId, item, interp) {
  const dados = db()
  const chave = chaveProduto(item)
  // Arquivados entram na busca de propósito: se o anúncio bate com algo que
  // você mandou embora, ele não pode voltar como produto novo na rodada
  // seguinte. Arquivar tem que valer.
  const daConsulta = dados.produtos.filter(p => p.consultaId === consultaId)

  const porChave = daConsulta.find(p => p.chave === chave.chave)
  if (porChave) return { produto: porChave, base: chave.base, chave }

  // Chave fraca (produto sem modelo no título): compara com os existentes.
  for (const p of daConsulta) {
    const anterior = { nome: p.nome, marca: p.marca, gtin: p.gtin, preco: precoMedio(p.id) }
    const novo = { nome: item.nome, marca: item.marca, gtin: item.gtin, preco: item.preco }
    const veredito = interp
      ? mesmoProdutoNaBusca(anterior, novo, interp)
      : mesmoProduto(anterior, novo)
    if (veredito.igual) return { produto: p, base: veredito.base, chave, fraco: veredito.fraco }
  }
  return { produto: null, chave }
}

function precoMedio (produtoId) {
  const ofertas = db().ofertas.filter(o => o.produtoId === produtoId && o.preco)
  if (!ofertas.length) return null
  return ofertas.reduce((s, o) => s + o.preco, 0) / ofertas.length
}

function registrarHistorico (produtoId, lojaId, oferta) {
  const dados = db()
  const anteriores = dados.historico.filter(h => h.produtoId === produtoId && h.lojaId === lojaId)
  const ultimo = anteriores[anteriores.length - 1]
  // Não grava ponto repetido: histórico serve para ver mudança.
  if (ultimo && ultimo.preco === oferta.preco && ultimo.disponivel === oferta.disponivel) {
    ultimo.confirmadoEm = agora()
    return ultimo
  }
  const ponto = {
    id: proximoId('hist'),
    produtoId,
    lojaId,
    preco: oferta.preco,
    precoDe: oferta.precoDe || null,
    disponivel: oferta.disponivel,
    url: oferta.url,
    ts: agora()
  }
  dados.historico.push(ponto)
  return ponto
}

function menorHistorico (produtoId, ignorarPonto = null) {
  const pontos = db().historico.filter(h => h.produtoId === produtoId && h.preco && h.id !== ignorarPonto)
  if (!pontos.length) return null
  let melhor = pontos[0]
  for (const p of pontos) if (p.preco < melhor.preco) melhor = p
  return melhor
}

function criarOportunidade (tipo, produto, loja, extra) {
  const dados = db()
  const op = {
    id: proximoId('op'),
    usuarioId: dados.config.usuarioId,
    tipo,
    produtoId: produto.id,
    produtoNome: produto.nome,
    lojaId: loja ? loja.id : null,
    lojaNome: loja ? loja.nome : null,
    lida: false,
    ts: agora(),
    ...extra
  }
  dados.oportunidades.push(op)
  emitir({ tipo: 'oportunidade', texto: op.texto })
  return op
}

const reais = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * `minimoAntes` precisa ser lido ANTES de gravar o ponto novo no histórico —
 * senão o preço recém-gravado já é o mínimo e "novo menor preço" nunca dispara.
 */
function avaliarOportunidades (produto, loja, oferta, precoAnterior, config, minimoAntes) {
  const ops = []

  if (precoAnterior && oferta.preco && oferta.preco < precoAnterior) {
    const queda = ((precoAnterior - oferta.preco) / precoAnterior) * 100
    if (queda >= (config.quedaRelevante ?? 5)) {
      ops.push(criarOportunidade('queda', produto, loja, {
        preco: oferta.preco,
        precoAnterior,
        // Negativo = preço caiu. A interface pinta pelo sinal.
        percentual: Number((-queda).toFixed(1)),
        texto: `${produto.nome} caiu ${queda.toFixed(1)}% na ${loja.nome} — de ${reais(precoAnterior)} para ${reais(oferta.preco)}.`
      }))
    }
  }

  if (oferta.preco && minimoAntes && oferta.preco < minimoAntes.preco) {
    ops.push(criarOportunidade('minimo_historico', produto, loja, {
      preco: oferta.preco,
      precoAnterior: minimoAntes.preco,
      percentual: Number((-(((minimoAntes.preco - oferta.preco) / minimoAntes.preco) * 100)).toFixed(1)),
      texto: `${produto.nome} atingiu o menor preço já visto: ${reais(oferta.preco)} na ${loja.nome}.`
    }))
  }

  const alvo = produto.precoDesejado || null
  if (alvo && oferta.preco && oferta.preco <= alvo) {
    const jaAvisou = db().oportunidades.some(o =>
      o.tipo === 'abaixo_do_objetivo' && o.produtoId === produto.id && !o.lida)
    if (!jaAvisou) {
      ops.push(criarOportunidade('abaixo_do_objetivo', produto, loja, {
        preco: oferta.preco,
        precoAnterior: alvo,
        texto: `${produto.nome} chegou ao preço que você queria: ${reais(oferta.preco)} na ${loja.nome} (objetivo ${reais(alvo)}).`
      }))
    }
  }

  return ops
}

function avaliarMelhorEntreLojas (produto) {
  const dados = db()
  const ofertas = dados.ofertas.filter(o => o.produtoId === produto.id && o.preco && o.disponivel !== false)
  if (ofertas.length < 2) return null
  const ordenadas = [...ofertas].sort((a, b) => a.preco - b.preco)
  const barata = ordenadas[0]
  const cara = ordenadas[ordenadas.length - 1]
  const diferenca = cara.preco - barata.preco
  if (diferenca / cara.preco < 0.05) return null

  const jaAvisou = dados.oportunidades.some(o =>
    o.tipo === 'melhor_entre_lojas' && o.produtoId === produto.id && !o.lida &&
    o.lojaId === barata.lojaId && Math.abs((o.preco || 0) - barata.preco) < 0.01)
  if (jaAvisou) return null

  const lojaBarata = dados.lojas.find(l => l.id === barata.lojaId)
  const lojaCara = dados.lojas.find(l => l.id === cara.lojaId)
  if (!lojaBarata || !lojaCara) return null

  return criarOportunidade('melhor_entre_lojas', produto, lojaBarata, {
    preco: barata.preco,
    precoAnterior: cara.preco,
    percentual: Number((-((diferenca / cara.preco) * 100)).toFixed(1)),
    texto: `${lojaBarata.nome} está ${reais(diferenca)} mais barata que ${lojaCara.nome} em ${produto.nome}.`
  })
}

// -------------------------------------------------------------- consulta

/**
 * Fase 1 — coleta. Só rede e pontuação, nenhuma escrita no banco. Por não
 * tocar em estado compartilhado, várias consultas podem rodar juntas.
 */
async function coletarConsulta (consulta, lojas, rodada) {
  const dados = db()
  const config = dados.config
  // A interpretação é refeita a cada rodada, e não lida do que foi salvo no
  // cadastro. Interpretar é barato (não sai da máquina), e guardar congelava a
  // busca nas regras do dia em que ela foi criada: melhorias na leitura de
  // marca, spec e palavra-chave não valiam para quem já estava cadastrado.
  const interp = interpretar(consulta.texto)
  consulta.interpretacao = interp

  const rejeitados = []

  // As lojas são consultadas ao mesmo tempo, não uma depois da outra. Cada
  // domínio tem sua própria fila com intervalo mínimo (ver net.js), então
  // paralelizar aqui não atropela loja nenhuma — só para de fazer a KaBuM
  // esperar a Terabyte, que é lenta por precisar de navegador. Numa rodada com
  // 4 lojas, isso é a diferença entre somar os tempos e pagar só o maior.
  const porLoja = await Promise.all(lojas.map(async (loja) => {
    emitir({ tipo: 'rodada', fase: 'buscando', texto: `${consulta.texto} na ${loja.nome}` })
    let aceitosDaLoja = []
    let lidosDaLoja = 0

    for (const termo of (interp.termosBusca || [consulta.texto]).slice(0, 2)) {
      const { itens, erro } = await coletar(loja, termo, config.paginasPorBusca ?? 1)
      if (erro) {
        rodada.erros.push(erro)
        loja.falhasSeguidas = (loja.falhasSeguidas || 0) + 1
        loja.ultimoErro = erro
        break
      }
      loja.falhasSeguidas = 0
      loja.ultimoErro = null
      lidosDaLoja += itens.length

      for (const item of itens) {
        if (!item.preco) continue
        const resultado = pontuar(interp, item, config)
        if (resultado.aceito) {
          aceitosDaLoja.push({ item, loja, resultado })
        } else if (resultado.ambiguo) {
          rejeitados.push({ item, loja, resultado, ambiguo: true })
        }
      }
      // Segundo termo só se o primeiro rendeu pouco.
      if (aceitosDaLoja.length >= 3) break
    }

    // Dentro da mesma loja, o mesmo produto pode aparecer duas vezes.
    const porChave = new Map()
    for (const a of aceitosDaLoja) {
      const k = chaveProduto(a.item).chave
      const atual = porChave.get(k)
      if (!atual || a.resultado.score > atual.resultado.score) porChave.set(k, a)
    }
    aceitosDaLoja = [...porChave.values()]
    emitir({ tipo: 'rodada', fase: 'lida', texto: `${loja.nome}: ${aceitosDaLoja.length} de ${lidosDaLoja} anúncios servem` })
    return { aceitosDaLoja, lidosDaLoja }
  }))

  const aceitos = porLoja.flatMap(r => r.aceitosDaLoja)
  const lidos = porLoja.reduce((s, r) => s + r.lidosDaLoja, 0)
  return { consulta, interp, aceitos, lidos, rejeitados, lojas }
}

/**
 * Fase 2 — gravação. Roda em série, uma consulta por vez: é aqui que produtos,
 * ofertas e histórico são criados, e paralelizar isso criaria corrida entre
 * dois anúncios disputando o mesmo produto.
 */
/**
 * Produto que entrou antes, sob uma regra mais frouxa, é reavaliado com a
 * regra de hoje. Quem não passa mais é arquivado — não apagado: o histórico de
 * preço continua lá, e dá para reverter. É o que faz um ajuste na inteligência
 * valer também para o que já estava na lista.
 */
function revalidarProdutos (consulta, interp, config) {
  const dados = db()
  let arquivados = 0
  for (const produto of dados.produtos) {
    if (produto.consultaId !== consulta.id || produto.arquivado) continue
    const veredito = pontuar(interp, { nome: produto.nome, marca: produto.marca, gtin: produto.gtin }, config)
    if (veredito.eliminado) {
      produto.arquivado = true
      produto.motivoArquivo = veredito.motivos[0] || 'não corresponde mais à busca'
      produto.arquivadoEm = agora()
      arquivados++
    }
  }
  if (arquivados) {
    emitir({ tipo: 'rodada', fase: 'revisando', texto: `${arquivados} produtos saíram de "${consulta.texto}" pela regra nova` })
  }
  return arquivados
}

async function gravarConsulta ({ consulta, interp, aceitos, lidos, rejeitados, lojas }) {
  const dados = db()
  const config = dados.config
  revalidarProdutos(consulta, interp, config)

  const { mantidos, descartados } = filtrarPorSanidadeDePreco(aceitos, interp)
  if (descartados.length) {
    emitir({ tipo: 'rodada', fase: 'filtrando', texto: `${descartados.length} descartados por preço fora da faixa` })
  }

  // Teto por consulta: os melhores primeiro.
  const ordenados = [...mantidos].sort((a, b) => b.resultado.score - a.resultado.score)
  const teto = config.tetoPorConsulta ?? 40
  const jaMonitorados = new Set(dados.produtos.filter(p => p.consultaId === consulta.id).map(p => p.id))
  const usados = []
  let novosPermitidos = Math.max(0, teto - jaMonitorados.size)

  const produtosTocados = new Set()
  let novos = 0

  // Trava de sanidade: uma loja não pode contribuir com dois anúncios para o
  // mesmo produto na mesma rodada. Quando isso acontece, o segundo sobrescreve
  // o preço do primeiro e o histórico registra uma "queda" que nunca existiu.
  // Se dois anúncios da mesma loja caem no mesmo produto, eles não são o mesmo
  // produto — o segundo vira um registro próprio.
  const parJaUsado = new Set()

  for (const candidato of ordenados) {
    const { item, loja, resultado } = candidato
    const achado = acharProdutoExistente(consulta.id, item, interp)
    const { chave, base } = achado
    let existente = achado.produto
    if (existente && existente.arquivado) continue   // arquivado é arquivado
    if (existente && parJaUsado.has(`${existente.id}|${loja.id}`)) {
      // A loja anunciou o MESMO produto mais de uma vez nesta rodada — comum
      // em marketplace, onde cada vendedor cria seu anúncio. Chegar aqui já
      // significa que a correspondência reconheceu os dois como o mesmo
      // produto, então não se cria produto novo: o preço da loja passa a ser o
      // menor entre os anúncios dela, que é o que você pagaria.
      //
      // (A trava original separava quando os títulos eram diferentes. Só que
      // títulos diferentes para o mesmo produto é justamente a regra em loja
      // grande — e o resultado eram quatro cartões da mesma cafeteira.)
      const ofertaExistente = dados.ofertas.find(o => o.produtoId === existente.id && o.lojaId === loja.id)
      if (ofertaExistente && item.preco != null && item.preco < (ofertaExistente.preco ?? Infinity)) {
        ofertaExistente.preco = item.preco
        ofertaExistente.url = item.url || ofertaExistente.url
        ofertaExistente.titulo = item.nome
        ofertaExistente.atualizadoEm = agora()
      }
      continue
    }
    let produto = existente

    if (!produto) {
      if (novosPermitidos <= 0) continue
      novosPermitidos--
      novos++
      produto = {
        id: proximoId('prod'),
        usuarioId: config.usuarioId,
        consultaId: consulta.id,
        chave: chave.chave,
        chaveForte: chave.forte,
        baseIdentidade: chave.base,
        nome: item.nome,
        marca: marcaConfiavel(item, loja) || interp.marca || '',
        gtin: item.gtin || '',
        mpn: item.mpn || '',
        specs: interp.specs || [],
        imagem: item.imagem || null,
        arquivado: false,
        precoDesejado: consulta.precoDesejado || null,
        criadoEm: agora(),
        atualizadoEm: agora()
      }
      dados.produtos.push(produto)
    } else {
      if (!produto.imagem && item.imagem) produto.imagem = item.imagem
      if (!produto.gtin && item.gtin) { produto.gtin = item.gtin; produto.chave = chave.chave; produto.chaveForte = true }
      // Produto antigo pode ter guardado o vendedor no lugar do fabricante.
      const marcaBoa = marcaConfiavel(item, loja)
      if (marcaBoa && produto.marca !== marcaBoa) produto.marca = marcaBoa
      if (base) produto.baseIdentidade = base
      produto.atualizadoEm = agora()
    }
    produtosTocados.add(produto.id)
    parJaUsado.add(`${produto.id}|${loja.id}`)
    usados.push({ produto, item, loja, resultado })

    // ---- oferta (anúncio vigente naquela loja)
    let oferta = dados.ofertas.find(o => o.produtoId === produto.id && o.lojaId === loja.id)
    const precoAnterior = oferta ? oferta.preco : null
    if (!oferta) {
      oferta = {
        id: proximoId('of'),
        usuarioId: config.usuarioId,
        produtoId: produto.id,
        lojaId: loja.id,
        criadaEm: agora()
      }
      dados.ofertas.push(oferta)
    }
    const urlMudou = oferta.url && item.url && oferta.url !== item.url
    Object.assign(oferta, {
      url: item.url || oferta.url,
      titulo: item.nome,
      preco: item.preco,
      precoDe: item.precoDe || null,
      precoAVista: item.precoAVista || null,
      disponivel: item.disponivel !== false,
      score: resultado.score,
      ausenteRodadas: 0,
      atualizadoEm: agora()
    })
    if (urlMudou) {
      oferta.trocasDeUrl = (oferta.trocasDeUrl || 0) + 1
      emitir({ tipo: 'rodada', fase: 'reencontrado', texto: `Anúncio de ${produto.nome} mudou de endereço na ${loja.nome}` })
    }

    const minimoAntes = menorHistorico(produto.id)
    registrarHistorico(produto.id, loja.id, oferta)
    avaliarOportunidades(produto, loja, oferta, precoAnterior, config, minimoAntes)
  }

  // Produtos novos ganham uma visita à página do anúncio atrás de EAN/ficha.
  if (config.enriquecerProdutos !== false && novos) {
    const recemNascidos = dados.produtos
      .filter(p => p.consultaId === consulta.id && !p.enriquecidoEm && produtosTocados.has(p.id))
      .slice(0, 6)
    // Também em paralelo: são páginas de lojas diferentes, e cada domínio já
    // tem sua fila. Em série, isso sozinho dobrava o tempo da rodada.
    await Promise.all(recemNascidos.map(p =>
      enriquecer(p).catch(() => { /* ficha é bônus, não pode derrubar a rodada */ })))
  }

  await conferirCupons(consulta)

  for (const produtoId of produtosTocados) {
    const produto = dados.produtos.find(p => p.id === produtoId)
    if (produto) avaliarMelhorEntreLojas(produto)
  }

  // ---- anúncios que sumiram nesta rodada
  const lojasIds = new Set(lojas.map(l => l.id))
  for (const oferta of dados.ofertas) {
    const produto = dados.produtos.find(p => p.id === oferta.produtoId)
    if (!produto || produto.consultaId !== consulta.id) continue
    if (!lojasIds.has(oferta.lojaId)) continue
    // Oferta colada à mão existe justamente porque a busca da loja não a
    // encontra — sumir da busca não significa nada para ela.
    if (oferta.manual) continue
    const vistoAgora = usados.some(u => u.produto.id === oferta.produtoId && u.loja.id === oferta.lojaId)
    if (vistoAgora) continue
    oferta.ausenteRodadas = (oferta.ausenteRodadas || 0) + 1
    if (oferta.ausenteRodadas === 1) {
      // Some da busca mas pode estar lá: confere a página do anúncio.
      const reencontrado = await tentarReencontrar(oferta, produto)
      if (reencontrado) continue
    }
    if (oferta.disponivel !== false) {
      oferta.disponivel = false
      oferta.atualizadoEm = agora()
      registrarHistorico(produto.id, oferta.lojaId, { ...oferta, preco: null, disponivel: false })
    }
  }

  consulta.ultimaRodada = agora()
  return { lidos, aceitos: usados.length, novos, ambiguos: rejeitados.length }
}

/**
 * Listagem de busca quase nunca traz EAN/GTIN; a página do produto às vezes
 * traz. Abrir uma página por produto novo é caro, então isso roda só para
 * produtos recém-descobertos e com teto por rodada — e o ganho é permanente:
 * com GTIN, a identidade do produto vira à prova de mudança de título.
 */
/**
 * Abre a página de um produto e devolve o que dá para ler dela.
 *
 * Loja que monta o preço por JavaScript (Go Imports é assim) entrega um HTML
 * sem preço nenhum, e a leitura simples volta de mãos vazias ou agarra um
 * número solto do rodapé. Quando isso acontece, vale abrir de novo no navegador
 * de verdade: é a mesma página que a loja serve a qualquer visitante, só que já
 * renderizada.
 */
async function lerPaginaDeProduto (url, loja, config) {
  const opcoes = {
    referer: loja.origem,
    tentativas: 1,
    preferirNavegador: Boolean(loja.precisaNavegador),
    permitirNavegador: config.usarNavegador !== false,
    modo: config.navegadorVisivel ? true : 'escondido'
  }
  const resposta = await buscarComFallback(url, opcoes)
  if (!resposta.ok) return { resposta, pagina: null }
  const pagina = extrairProduto(resposta.html, resposta.urlFinal)
  if (pagina.preco || resposta.viaNavegador || !opcoes.permitirNavegador) {
    return { resposta, pagina }
  }
  const renderizada = await buscarComFallback(url, { ...opcoes, exigirNavegador: true })
  if (!renderizada.ok) return { resposta, pagina }
  const outra = extrairProduto(renderizada.html, renderizada.urlFinal)
  return outra.preco ? { resposta: renderizada, pagina: outra } : { resposta, pagina }
}

async function enriquecer (produto, limitePorRodada) {
  const dados = db()
  if (produto.enriquecidoEm || produto.gtin) return false
  const oferta = dados.ofertas.find(o => o.produtoId === produto.id && o.url)
  if (!oferta) return false
  const loja = dados.lojas.find(l => l.id === oferta.lojaId)
  if (!loja) return false

  const { resposta, pagina } = await lerPaginaDeProduto(oferta.url, loja, dados.config)
  produto.enriquecidoEm = agora()
  if (!resposta.ok || !pagina) return false

  guardarDescontos(oferta, pagina)
  corrigirPrecoPelaPagina(produto, oferta, pagina, loja)
  let mudou = false
  if (pagina.gtin && !produto.gtin) {
    produto.gtin = pagina.gtin
    produto.chave = 'gtin:' + String(pagina.gtin).replace(/\D/g, '')
    produto.chaveForte = true
    produto.baseIdentidade = 'EAN/GTIN'
    mudou = true
  }
  if (pagina.mpn && !produto.mpn) { produto.mpn = pagina.mpn; mudou = true }
  if (pagina.imagem && !produto.imagem) { produto.imagem = pagina.imagem; mudou = true }
  // v2 não guarda mais a ficha técnica: é conteúdo copiado da página da loja,
  // não aparecia em lugar nenhum da tela e só existia porque veio junto na
  // leitura. Fica atrás de uma chave, desligada por padrão.
  if (db().config.guardarFichaTecnica && pagina.ficha && Object.keys(pagina.ficha).length) {
    produto.ficha = pagina.ficha
    mudou = true
  }
  if (mudou) emitir({ tipo: 'rodada', fase: 'enriquecendo', texto: `Ficha completada: ${produto.nome.slice(0, 50)}` })
  return mudou
}

/**
 * Cupom e desconto à vista vivem na página do produto e mudam sozinhos. Ficam
 * gravados na oferta com data, para a interface poder dizer "R$ X com cupom"
 * sem precisar abrir a loja de novo.
 */
function guardarDescontos (oferta, pagina) {
  const d = pagina && pagina.descontos
  oferta.descontosVerificadoEm = agora()
  if (!d) {
    oferta.cupom = null
    oferta.descontoAVista = null
    oferta.precoComDesconto = null
    oferta.comoChegou = null
    return false
  }
  const melhor = d.cupons.length
    ? d.cupons.reduce((a, b) => (b.tipo === a.tipo && b.valor > a.valor ? b : a))
    : null
  oferta.cupom = melhor
  oferta.descontoAVista = d.descontoAVista || null

  // A conta é feita sobre o preço QUE O APP ACOMPANHA, não sobre o preço que
  // a página do anúncio mostra. Os dois divergem com frequência na Amazon (a
  // página abre numa variante diferente da que veio na busca), e usar o preço
  // de lá produziria um "preço final" que não corresponde a nada.
  const base = oferta.preco
  let final = Number.isFinite(base) ? base : null
  if (final && melhor) final = aplicarCupom(final, melhor)
  if (final && d.descontoAVista) final = Number((final * (1 - d.descontoAVista.percentual / 100)).toFixed(2))

  oferta.precoComDesconto = final && base && final < base ? final : null
  oferta.comoChegou = oferta.precoComDesconto
    ? `${reais(oferta.precoComDesconto)}${melhor ? ` com ${melhor.tipo === 'percentual' ? melhor.valor + '% de cupom' : 'cupom de ' + reais(melhor.valor)}` : ''}` +
      `${d.descontoAVista ? `${melhor ? ' e' : ' com'} ${d.descontoAVista.percentual}% ${d.descontoAVista.forma === 'pix' ? 'no Pix' : 'à vista'}` : ''}`
    : null
  return Boolean(oferta.precoComDesconto)
}

/**
 * A página do anúncio manda mais que a listagem de busca.
 *
 * Na busca, a Amazon mostra o preço da configuração mais barata do anúncio
 * enquanto o título descreve outra — um MacBook Air M5 de 24GB/1TB aparecia
 * por R$ 10.999 na lista e custava R$ 16.910 ao abrir. Como a gente já visita
 * a página atrás de cupom, aproveita e corrige o preço por lá, que é o valor
 * que a pessoa realmente vai encontrar ao clicar.
 */
function corrigirPrecoPelaPagina (produto, oferta, pagina, loja) {
  const novo = pagina && pagina.preco
  if (!Number.isFinite(novo) || !Number.isFinite(oferta.preco)) return false
  const diferenca = Math.abs(novo - oferta.preco) / Math.max(novo, oferta.preco)
  if (diferenca < 0.01) return false

  const anterior = oferta.preco
  const minimoAntes = menorHistorico(produto.id)
  oferta.condicao = pagina.condicao || null
  oferta.parcelamento = pagina.parcelamento || null
  oferta.preco = novo
  oferta.precoDe = pagina.precoDe || oferta.precoDe || null
  oferta.precoConferidoNaPagina = agora()
  oferta.atualizadoEm = agora()
  registrarHistorico(produto.id, loja.id, oferta)
  avaliarOportunidades(produto, loja, oferta, anterior, db().config, minimoAntes)
  emitir({
    tipo: 'rodada',
    fase: 'corrigindo',
    texto: `${loja.nome}: ${produto.nome.slice(0, 30)} é ${reais(novo)} na página, não ${reais(anterior)}`
  })
  return true
}

/**
 * Confere cupons das ofertas mais baratas de cada produto. Custa uma visita à
 * página do anúncio, então roda no máximo algumas por rodada e só reconfere o
 * que está velho — cupom não muda de hora em hora.
 */
export async function conferirCupons (consulta, limite = 8) {
  const dados = db()
  const config = dados.config
  if (config.verificarCupons === false) return 0

  const doze = 12 * 3600 * 1000
  const candidatas = []
  for (const produto of dados.produtos) {
    if (produto.consultaId !== consulta.id || produto.arquivado) continue
    const ofertas = dados.ofertas.filter(o => o.produtoId === produto.id && o.preco && o.url)
    // TODAS as ofertas, não só a mais barata: é justamente o cupom que faz a
    // segunda colocada virar a melhor compra. A Amazon anunciando R$ 3.514 com
    // 10% de cupom sai por R$ 3.163 e ganha do Carrefour a R$ 3.470 — olhar só
    // a mais barata esconderia exatamente a oportunidade que o app existe para
    // achar. As mais baratas vão primeiro porque o teto por rodada é curto.
    for (const oferta of ofertas) {
      const idade = oferta.descontosVerificadoEm
        ? Date.now() - new Date(oferta.descontosVerificadoEm).getTime()
        : Infinity
      if (idade > doze) candidatas.push({ produto, oferta, idade })
    }
  }
  if (!candidatas.length) return 0

  // Quem nunca foi conferido vai primeiro — senão um produto caro no começo da
  // lista consome o teto da rodada e outro nunca chega a ser olhado, que foi o
  // que aconteceu com a cafeteira da Amazon.
  candidatas.sort((a, b) => (b.idade === Infinity) - (a.idade === Infinity) || a.oferta.preco - b.oferta.preco)

  // Teto por LOJA, não só global: sem isso, uma rodada podia disparar oito
  // visitas seguidas à mesma loja e render um 503 de limite de taxa.
  const porLoja = new Map()
  const escolhidas = []
  for (const c of candidatas) {
    const usadas = porLoja.get(c.oferta.lojaId) || 0
    if (usadas >= 3) continue
    porLoja.set(c.oferta.lojaId, usadas + 1)
    escolhidas.push(c)
    if (escolhidas.length >= limite) break
  }

  let achados = 0
  await Promise.all(escolhidas.map(async ({ produto, oferta }) => {
    const loja = dados.lojas.find(l => l.id === oferta.lojaId)
    if (!loja) return
    try {
      const { resposta, pagina } = await lerPaginaDeProduto(oferta.url, loja, config)
      if (!resposta.ok || !pagina) return
      corrigirPrecoPelaPagina(produto, oferta, pagina, loja)
      if (guardarDescontos(oferta, pagina)) {
        achados++
        emitir({
          tipo: 'rodada',
          fase: 'cupom',
          texto: `${loja.nome}: ${produto.nome.slice(0, 34)} sai por ${reais(oferta.precoComDesconto)} com desconto`
        })
      }
    } catch { /* cupom é bônus */ }
  }))
  return achados
}

/**
 * O anúncio saiu da busca. Antes de dar como indisponível, abre a URL salva —
 * e, se ela morreu, procura de novo pelo nome do produto. Produto é
 * identificado por atributo, não por URL.
 */
async function tentarReencontrar (oferta, produto) {
  const dados = db()
  const loja = dados.lojas.find(l => l.id === oferta.lojaId)
  if (!loja || !oferta.url) return false
  const resposta = await buscar(oferta.url, { referer: loja.origem, tentativas: 1, usarCache: false })
  if (!resposta.ok || resposta.bloqueado) return false
  const pagina = extrairProduto(resposta.html, resposta.urlFinal)
  if (!pagina.preco) return false
  const antes = oferta.preco
  const minimoAntes = menorHistorico(produto.id)
  Object.assign(oferta, {
    preco: pagina.preco,
    disponivel: pagina.disponivel !== false,
    ausenteRodadas: 0,
    atualizadoEm: agora(),
    reencontradoEm: agora()
  })
  registrarHistorico(produto.id, loja.id, oferta)
  avaliarOportunidades(produto, loja, oferta, antes, dados.config, minimoAntes)
  emitir({ tipo: 'rodada', fase: 'reencontrado', texto: `${produto.nome} continua na ${loja.nome}, fora da busca` })
  return true
}

// ---------------------------------------------------------------- rodada

/**
 * Loja com escopo declarado ("produtos Apple", "hardware de PC") só entra nas
 * buscas que têm a ver com ela. Buscar "cafeteira Oster" numa loja que só vende
 * Apple é tempo jogado fora — e tempo aqui é caro, porque cada loja atende um
 * pedido por vez e as que exigem navegador levam segundos.
 *
 * O casamento é por palavra: escopo "produtos apple, macbook, iphone" bate com
 * a busca "macbook air m5" porque compartilham "macbook". Loja sem escopo
 * declarado participa de tudo, como antes.
 */
export function lojaAtendeConsulta (loja, consulta) {
  const escopo = (loja.escopo || '').trim()
  if (!escopo) return true

  const interp = consulta.interpretacao || {}
  const daBusca = new Set([
    ...tokensDe(consulta.texto),
    ...(interp.marca ? tokensDe(interp.marca) : []),
    ...(interp.categoria ? tokensDe(interp.categoria) : []),
    ...(interp.linha ? [interp.linha] : []),
    ...(interp.palavrasChave || [])
  ])
  const doEscopo = tokensDe(escopo).filter(t => t.length > 2)
  if (!doEscopo.length) return true
  return doEscopo.some(t => daBusca.has(t) || [...daBusca].some(b => b.includes(t) || t.includes(b)))
}

export async function rodar (opcoes = {}) {
  if (rodadaEmCurso) return rodadaEmCurso.registro
  const dados = db()
  const lojas = dados.lojas.filter(l => l.ativa && l.veredito !== 'incompativel')
  const consultas = opcoes.consultaId
    ? dados.consultas.filter(c => c.id === opcoes.consultaId)
    : dados.consultas.filter(c => c.ativa)

  const registro = {
    id: proximoId('rodada'),
    usuarioId: dados.config.usuarioId,
    inicio: agora(),
    fim: null,
    manual: Boolean(opcoes.manual),
    consultas: consultas.length,
    lojas: lojas.length,
    itensLidos: 0,
    produtosNovos: 0,
    oportunidades: 0,
    erros: []
  }
  dados.rodadas.push(registro)
  const oportunidadesAntes = dados.oportunidades.length
  rodadaEmCurso = { registro, total: consultas.length, atual: 0 }

  emitir({ tipo: 'rodada', fase: 'inicio', total: consultas.length, atual: 0, texto: 'Começando a rodada' })
  abrirCacheDaRodada()

  try {
    if (!lojas.length) registro.erros.push('Nenhuma loja ativa — cadastre uma loja compatível antes.')
    if (!consultas.length) registro.erros.push('Nenhuma consulta ativa.')

    // Todas as consultas coletam ao mesmo tempo. Como a coleta não escreve
    // nada, o tempo da rodada deixa de ser a soma das consultas e passa a ser
    // o da loja mais lenta — que hoje é a que precisa de navegador.
    const coletas = await Promise.all(consultas.map(async (consulta) => {
      const lojasDaConsulta = lojas.filter(l => lojaAtendeConsulta(l, consulta))
      const puladas = lojas.length - lojasDaConsulta.length
      emitir({
        tipo: 'rodada',
        fase: 'consulta',
        total: consultas.length,
        texto: consulta.texto + (puladas ? ` (${puladas} ${puladas === 1 ? 'loja fora do assunto' : 'lojas fora do assunto'})` : '')
      })
      try {
        return await coletarConsulta(consulta, lojasDaConsulta, registro)
      } catch (erro) {
        registro.erros.push(`${consulta.texto}: ${erro.message}`)
        return null
      }
    }))

    // A gravação é em série, uma consulta por vez.
    for (const coleta of coletas.filter(Boolean)) {
      rodadaEmCurso.atual++
      emitir({
        tipo: 'rodada',
        fase: 'gravando',
        atual: rodadaEmCurso.atual,
        total: consultas.length,
        texto: `Organizando ${coleta.consulta.texto}`
      })
      try {
        const r = await gravarConsulta(coleta)
        registro.itensLidos += r.lidos
        registro.produtosNovos += r.novos
      } catch (erro) {
        registro.erros.push(`${coleta.consulta.texto}: ${erro.message}`)
      }
      await salvar()
    }

    // Ofertas coladas à mão não dependem da busca da loja — são relidas
    // direto da página, toda rodada.
    const manuais = await atualizarOfertasManuais()
    if (manuais) await salvar()
  } finally {
    registro.buscasFeitas = fecharCacheDaRodada()
    registro.fim = agora()
    registro.oportunidades = dados.oportunidades.length - oportunidadesAntes
    if (dados.rodadas.length > 60) dados.rodadas.splice(0, dados.rodadas.length - 60)
    rodadaEmCurso = null
    await salvar()
    emitir({ tipo: 'rodada', fase: 'fim', texto: 'Rodada concluída' })
    emitir({ tipo: 'atualizado' })
  }
  return registro
}

/**
 * Oferta colada à mão.
 *
 * Nem toda loja tem busca que presta: a Go Imports responde "macbook air m5"
 * com os mais vendidos, e o MacBook Air que ela vende por R$ 8.599 nunca
 * aparecia — enquanto o app anunciava o Carrefour a R$ 9.891 como o melhor
 * preço. Quando a pessoa já tem o link na mão, ela sabe mais que a busca da
 * loja; o app só precisa aceitar a informação e passar a acompanhar a página.
 */
export async function adicionarOfertaManual (produtoId, url) {
  const dados = db()
  const produto = dados.produtos.find(p => p.id === produtoId)
  if (!produto) throw new Error('produto não encontrado')

  let origem
  try { origem = new URL(url).origin } catch { throw new Error('link inválido') }
  const loja = dados.lojas.find(l => {
    try { return new URL(l.origem).host.replace(/^www\./, '') === new URL(origem).host.replace(/^www\./, '') } catch { return false }
  })
  if (!loja) throw new Error('essa loja ainda não está cadastrada — cadastre em Lojas e tente de novo')

  const { resposta, pagina } = await lerPaginaDeProduto(url, loja, dados.config)
  if (!resposta.ok) throw new Error('não consegui abrir essa página')
  if (!pagina || !pagina.preco) throw new Error('abri a página mas não achei preço nela')

  let oferta = dados.ofertas.find(o => o.produtoId === produto.id && o.lojaId === loja.id)
  const precoAnterior = oferta ? oferta.preco : null
  const minimoAntes = menorHistorico(produto.id)
  if (!oferta) {
    oferta = {
      id: proximoId('of'),
      usuarioId: dados.config.usuarioId,
      produtoId: produto.id,
      lojaId: loja.id,
      criadaEm: agora()
    }
    dados.ofertas.push(oferta)
  }
  Object.assign(oferta, {
    url,
    manual: true,                 // a busca da loja não manda nesta oferta
    titulo: pagina.nome || oferta.titulo || produto.nome,
    preco: pagina.preco,
    precoDe: pagina.precoDe || null,
    precoAVista: pagina.precoAVista || null,
    condicao: pagina.condicao || null,
    parcelamento: pagina.parcelamento || null,
    disponivel: pagina.disponivel !== false,
    ausenteRodadas: 0,
    score: 100,
    precoConferidoNaPagina: agora(),
    atualizadoEm: agora()
  })
  guardarDescontos(oferta, pagina)
  registrarHistorico(produto.id, loja.id, oferta)
  avaliarOportunidades(produto, loja, oferta, precoAnterior, dados.config, minimoAntes)
  await salvar()
  emitir({ tipo: 'atualizado' })
  return { loja: loja.nome, preco: oferta.preco, condicao: oferta.condicao, titulo: oferta.titulo }
}

/** Relê toda oferta manual direto da página dela. */
async function atualizarOfertasManuais () {
  const dados = db()
  const manuais = dados.ofertas.filter(o => o.manual && o.url)
  if (!manuais.length) return 0
  let mudou = 0
  await Promise.all(manuais.map(async (oferta) => {
    const loja = dados.lojas.find(l => l.id === oferta.lojaId)
    const produto = dados.produtos.find(p => p.id === oferta.produtoId)
    if (!loja || !produto) return
    try {
      const { resposta, pagina } = await lerPaginaDeProduto(oferta.url, loja, dados.config)
      if (!resposta.ok || !pagina || !pagina.preco) return
      guardarDescontos(oferta, pagina)
      const precoAnterior = oferta.preco
      const minimoAntes = menorHistorico(produto.id)
      oferta.preco = pagina.preco
      oferta.condicao = pagina.condicao || null
      oferta.parcelamento = pagina.parcelamento || null
      oferta.precoDe = pagina.precoDe || null
      oferta.disponivel = pagina.disponivel !== false
      oferta.ausenteRodadas = 0
      oferta.precoConferidoNaPagina = agora()
      oferta.atualizadoEm = agora()
      registrarHistorico(produto.id, loja.id, oferta)
      avaliarOportunidades(produto, loja, oferta, precoAnterior, dados.config, minimoAntes)
      mudou++
    } catch { /* uma página fora do ar não derruba a rodada */ }
  }))
  return mudou
}

// -------------------------------------------------------------- agendador

let timer = null
const jaRodou = new Set()

export function ultimaRodadaEm () {
  const rodadas = db().rodadas
  const ultima = rodadas[rodadas.length - 1]
  return ultima ? new Date(ultima.inicio).getTime() : 0
}

/** Faz tempo demais desde a última leitura? */
export function precisaAtualizar () {
  const config = db().config
  const minutos = Number(config.intervaloMinutos) || 0
  if (!minutos) return false
  return Date.now() - ultimaRodadaEm() >= minutos * 60 * 1000
}

export function iniciarAgendador () {
  if (timer) clearInterval(timer)
  timer = setInterval(async () => {
    const dados = db()
    if (!dados.config.agendadorAtivo || rodadaEmCurso) return

    // Intervalo fixo (padrão: de hora em hora). É mais previsível que horário
    // marcado — e, se o computador estava desligado na hora combinada, o
    // horário marcado simplesmente perdia a rodada.
    if (precisaAtualizar()) {
      await rodar({ manual: false }).catch(e => console.error('[agendador]', e.message))
      return
    }

    // Horários fixos continuam valendo para quem preferir (lista vazia desliga).
    const d = new Date()
    const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    const hoje = d.toISOString().slice(0, 10)
    for (const horario of dados.config.horarios || []) {
      const marca = `${hoje} ${horario}`
      if (horario === hhmm && !jaRodou.has(marca)) {
        jaRodou.add(marca)
        if (jaRodou.size > 30) jaRodou.clear()
        await rodar({ manual: false }).catch(e => console.error('[agendador]', e.message))
      }
    }
  }, 30 * 1000)
  timer.unref?.()
}

export function proximaRodada () {
  const dados = db()
  if (!dados.config.agendadorAtivo) return null
  const horarios = (dados.config.horarios || []).slice().sort()
  if (!horarios.length) return null
  const agoraD = new Date()
  for (const h of horarios) {
    const [hh, mm] = h.split(':').map(Number)
    const alvo = new Date(agoraD)
    alvo.setHours(hh, mm, 0, 0)
    if (alvo > agoraD) return alvo.toISOString()
  }
  const [hh, mm] = horarios[0].split(':').map(Number)
  const amanha = new Date(agoraD)
  amanha.setDate(amanha.getDate() + 1)
  amanha.setHours(hh, mm, 0, 0)
  return amanha.toISOString()
}

// ------------------------------------------------------------------ resumos

export function resumoProduto (produto) {
  const dados = db()
  const ofertas = dados.ofertas.filter(o => o.produtoId === produto.id)
  const disponiveis = ofertas.filter(o => o.preco && o.disponivel !== false)
  const menorAtualOferta = disponiveis.length
    ? disponiveis.reduce((a, b) => (a.preco <= b.preco ? a : b))
    : null
  const minimo = menorHistorico(produto.id)
  const historico = dados.historico.filter(h => h.produtoId === produto.id && h.preco)
  const ontem = Date.now() - 24 * 3600 * 1000
  const antigos = historico.filter(h => new Date(h.ts).getTime() <= ontem)
  const referencia = antigos.length ? antigos[antigos.length - 1].preco : null

  // Variação desde a leitura anterior — é o que a spec chama de "caiu 8% desde
  // a última atualização", e é o único número que existe no primeiro dia de
  // uso, quando ainda não há histórico de 24h.
  const daLojaMaisBarata = menorAtualOferta
    ? historico.filter(h => h.lojaId === menorAtualOferta.lojaId)
    : []
  const anterior = daLojaMaisBarata.length > 1 ? daLojaMaisBarata[daLojaMaisBarata.length - 2].preco : null

  const menorAtual = menorAtualOferta ? menorAtualOferta.preco : null
  const lojaBarata = menorAtualOferta ? dados.lojas.find(l => l.id === menorAtualOferta.lojaId) : null

  // "Encontre o melhor momento para comprar" é o slogan — então a pergunta que
  // o produto tem que responder é essa. A régua é o próprio histórico: em que
  // posição o preço de hoje está em relação a tudo que já se viu.
  const janela = Date.now() - 90 * 24 * 3600 * 1000
  const recentes = historico.filter(h => new Date(h.ts).getTime() >= janela).map(h => h.preco)
  const base = recentes.length >= 3 ? recentes : historico.map(h => h.preco)
  let avaliacao = null
  if (menorAtual && base.length >= 3) {
    const acimaDeAgora = base.filter(p => p > menorAtual).length
    const percentil = acimaDeAgora / base.length          // 1 = nunca esteve tão barato
    const media = base.reduce((s, p) => s + p, 0) / base.length
    avaliacao = {
      percentil: Number((percentil * 100).toFixed(0)),
      media: Number(media.toFixed(2)),
      distanciaDaMedia: Number((((menorAtual - media) / media) * 100).toFixed(1)),
      leituras: base.length,
      classificacao: percentil >= 0.9 ? 'otimo' : percentil >= 0.6 ? 'bom' : percentil >= 0.3 ? 'normal' : 'ruim',
      texto: percentil >= 0.9
        ? 'Melhor momento que já vimos para este produto'
        : percentil >= 0.6
          ? 'Bom preço perto do que costuma custar'
          : percentil >= 0.3
            ? 'Preço na média do histórico'
            : 'Caro para o padrão deste produto'
    }
  }

  return {
    menorAtual,
    lojaMaisBarata: lojaBarata ? lojaBarata.nome : null,
    lojaMaisBarataId: lojaBarata ? lojaBarata.id : null,
    menorHistorico: minimo ? minimo.preco : null,
    menorHistoricoEm: minimo ? minimo.ts : null,
    // Em reais (é o que a tela mostra) e em % (para ordenar e comparar).
    distanciaDoMinimo: minimo && menorAtual
      ? Number((menorAtual - minimo.preco).toFixed(2))
      : null,
    distanciaDoMinimoPct: minimo && menorAtual
      ? Number((((menorAtual - minimo.preco) / minimo.preco) * 100).toFixed(1))
      : null,
    variacao24h: referencia && menorAtual
      ? Number((((menorAtual - referencia) / referencia) * 100).toFixed(1))
      : null,
    variacaoUltima: anterior && menorAtual
      ? Number((((menorAtual - anterior) / anterior) * 100).toFixed(1))
      : null,
    totalLojas: disponiveis.length,
    pontosHistorico: historico.length,
    avaliacao
  }
}

/**
 * Série diária do preço mínimo de um produto — a resposta visual para "quando
 * é o melhor momento de comprar isso?".
 *
 * Duas decisões que mudam o gráfico:
 * - O valor do dia é o MENOR entre todas as lojas naquele dia. É o preço que
 *   você teria pagado se comprasse ali.
 * - Dia sem leitura não vira buraco: arrasta o último preço conhecido e marca
 *   `estimado`, porque o produto não deixou de custar aquilo só porque o app
 *   não olhou. O gráfico desenha esse trecho tracejado.
 */
export function serieDiaria (produtoId, dias = 60) {
  const dados = db()
  const pontos = dados.historico
    .filter(h => h.produtoId === produtoId && h.preco)
    .sort((a, b) => a.ts.localeCompare(b.ts))
  if (!pontos.length) return []

  const porDia = new Map()
  for (const p of pontos) {
    const dia = p.ts.slice(0, 10)
    const atual = porDia.get(dia)
    if (!atual) {
      porDia.set(dia, { dia, min: p.preco, max: p.preco, lojaMin: p.lojaId, leituras: 1 })
    } else {
      atual.leituras++
      if (p.preco < atual.min) { atual.min = p.preco; atual.lojaMin = p.lojaId }
      if (p.preco > atual.max) atual.max = p.preco
    }
  }

  const inicio = new Date([...porDia.keys()].sort()[0] + 'T12:00:00Z')
  const hoje = new Date()
  const limite = new Date(hoje.getTime() - (dias - 1) * 86400000)
  const primeiro = inicio > limite ? inicio : limite

  const serie = []
  let ultimo = null
  for (let d = new Date(primeiro); d <= hoje; d = new Date(d.getTime() + 86400000)) {
    const chave = d.toISOString().slice(0, 10)
    const bruto = porDia.get(chave)
    if (bruto) {
      const loja = dados.lojas.find(l => l.id === bruto.lojaMin)
      ultimo = {
        dia: chave,
        min: Number(bruto.min.toFixed(2)),
        max: Number(bruto.max.toFixed(2)),
        lojaMin: loja ? loja.nome : '—',
        leituras: bruto.leituras,
        estimado: false
      }
      serie.push(ultimo)
    } else if (ultimo) {
      serie.push({ ...ultimo, dia: chave, leituras: 0, estimado: true })
    }
  }
  return serie
}

export function resumoGeral () {
  const dados = db()
  const hoje = new Date().toISOString().slice(0, 10)
  const produtos = dados.produtos.filter(p => !p.arquivado)
  let emQueda = 0
  let novosMinimos = 0
  for (const p of produtos) {
    const r = resumoProduto(p)
    const variacao = r.variacao24h !== null ? r.variacao24h : r.variacaoUltima
    if (variacao !== null && variacao < 0) emQueda++
    if (r.distanciaDoMinimo === 0 && r.menorAtual && r.pontosHistorico > 1) novosMinimos++
  }
  return {
    consultasAtivas: dados.consultas.filter(c => c.ativa).length,
    consultasTotal: dados.consultas.length,
    atualizacoesHoje: dados.historico.filter(h => h.ts.slice(0, 10) === hoje).length,
    produtosEmQueda: emQueda,
    novosMinimos,
    oportunidadesAbertas: dados.oportunidades.filter(o => !o.lida).length,
    lojasAtivas: dados.lojas.filter(l => l.ativa).length,
    lojasTotal: dados.lojas.length,
    produtosMonitorados: produtos.length,
    proximaRodada: proximaRodada(),
    rodando: Boolean(rodadaEmCurso)
  }
}
