// Servidor do KiwiFinder.
//
// Sem framework e sem dependência: node server/index.js e pronto. A spec prevê
// NestJS; aqui as rotas são poucas e explícitas, e a troca depois é mecânica.
//
// Por que existe servidor num protótipo que os outros do vault resolvem com um
// HTML solto: o navegador proíbe uma página de ler outro site (CORS). Buscar
// preço na loja só é possível a partir do servidor.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { carregar, db, salvar, proximoId, agora, ondeGuarda } from './store.js'
import { diagnosticar } from './diagnose.js'
import { interpretar } from './nlp.js'
import { rodar, iniciarAgendador, aoProgredir, resumoProduto, resumoGeral, rodadaAtual, serieDiaria, precisaAtualizar, adicionarOfertaManual } from './engine.js'
import { limparPerfisOrfaos } from './navegador.js'
import { LOJAS_CONHECIDAS } from './library.js'
import { aplicarAfiliado, temAfiliado, precisaDivulgar, TEXTO_DIVULGACAO, PROGRAMAS_CONHECIDOS } from './afiliado.js'
import { exigeSenha, sessaoValida, senhaConfere, criarCookieDeSessao, cookieDeSaida, paginaDeLogin } from './auth.js'

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)))
const PUBLICO = join(RAIZ, 'public')
const PORTA = Number(process.env.PORT) || 4173

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

// ------------------------------------------------------------ eventos (SSE)

const clientes = new Set()

function transmitir (evento) {
  const linha = `data: ${JSON.stringify(evento)}\n\n`
  for (const res of clientes) {
    try { res.write(linha) } catch { clientes.delete(res) }
  }
}

aoProgredir(transmitir)

// --------------------------------------------------------------- utilidades

function json (res, dados, status = 200) {
  const corpo = JSON.stringify(dados)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store'
  })
  res.end(corpo)
}

async function lerCorpo (req) {
  const partes = []
  let tamanho = 0
  for await (const pedaco of req) {
    tamanho += pedaco.length
    if (tamanho > 2_000_000) throw new Error('corpo grande demais')
    partes.push(pedaco)
  }
  if (!partes.length) return {}
  try { return JSON.parse(Buffer.concat(partes).toString('utf8')) } catch { return {} }
}

const naoAchou = (res, msg = 'não encontrado') => json(res, { erro: msg }, 404)

// O formulário de senha manda application/x-www-form-urlencoded, não JSON.
async function lerCorpoTexto (req) {
  const partes = []
  let tamanho = 0
  for await (const pedaco of req) {
    tamanho += pedaco.length
    if (tamanho > 10_000) throw new Error('corpo grande demais')
    partes.push(pedaco)
  }
  return Buffer.concat(partes).toString('utf8')
}

// ------------------------------------------------------------ montar estado

function lojaPublica (loja) {
  const dados = db()
  const produtos = dados.ofertas.filter(o => o.lojaId === loja.id).length
  return { ...loja, produtosEncontrados: produtos }
}

function consultaPublica (consulta) {
  const dados = db()
  return {
    ...consulta,
    totalProdutos: dados.produtos.filter(p => p.consultaId === consulta.id && !p.arquivado).length
  }
}

function produtoPublico (produto) {
  const dados = db()
  const ofertas = dados.ofertas
    .filter(o => o.produtoId === produto.id)
    .map(o => {
      const loja = dados.lojas.find(l => l.id === o.lojaId)
      return {
        lojaId: o.lojaId,
        lojaNome: loja ? loja.nome : 'loja removida',
        preco: o.preco,
        precoDe: o.precoDe || null,
        precoAVista: o.precoAVista || null,
        disponivel: o.disponivel,
        url: o.url,
        // A URL que a pessoa clica de fato: com o código de afiliado quando a
        // loja tem um configurado. `url` continua sendo a original, que é o
        // que o app usa para reler a página.
        // Link visível: o do próprio KiwiFinder, que redireciona por baixo.
        // Só vira /ir/ quando há afiliado configurado — sem afiliado, mandar a
        // pessoa dar um pulo a mais no nosso servidor não serviria para nada.
        urlSaida: temAfiliado(loja && loja.afiliado, { awinaffid: dados.config.awinaffid })
          ? `/ir/${o.id}`
          : o.url,
        titulo: o.titulo,
        score: o.score,
        atualizadoEm: o.atualizadoEm,
        // Quando o preço foi conferido na própria página do anúncio — mais
        // confiável que a leitura da listagem de busca, e é essa hora que vale
        // mostrar para quem vai clicar.
        precoConferidoNaPagina: o.precoConferidoNaPagina || null,
        trocasDeUrl: o.trocasDeUrl || 0,
        // Cupom e desconto à vista: o preço que sai de verdade.
        cupom: o.cupom || null,
        descontoAVista: o.descontoAVista || null,
        precoComDesconto: o.precoComDesconto || null,
        condicao: o.condicao || null,
        parcelamento: o.parcelamento || null,
        // Preço que sai de verdade — é por ele que a comparação entre lojas ordena.
        precoEfetivo: o.precoComDesconto || o.preco,
        comoChegou: o.comoChegou || null
      }
    })
    .sort((a, b) => (a.preco || Infinity) - (b.preco || Infinity))
  // A série vai junto no estado para o cartão do produto poder desenhar a
  // minicurva sem uma requisição por produto.
  const serie = serieDiaria(produto.id, 30)
  return {
    ...produto,
    ofertas,
    resumo: resumoProduto(produto),
    serie: serie.map(p => p.min),
    serieDias: serie.length
  }
}

function estadoCompleto () {
  const dados = db()
  return {
    config: dados.config,
    lojas: dados.lojas.map(lojaPublica),
    consultas: dados.consultas.map(consultaPublica),
    produtos: dados.produtos.filter(p => !p.arquivado).map(produtoPublico),
    oportunidades: [...dados.oportunidades].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 200),
    rodadas: [...dados.rodadas].reverse().slice(0, 12),
    resumo: resumoGeral(),
    // Divulgação de afiliado: obrigatória em praticamente todo programa, e o
    // mínimo de honestidade de qualquer jeito. Só aparece quando há de fato um
    // link de afiliado no ar.
    divulgacaoAfiliado: precisaDivulgar(dados.lojas, { awinaffid: dados.config.awinaffid }) ? TEXTO_DIVULGACAO : null,
    rodada: rodadaAtual() ? { rodando: true, ...rodadaAtual() } : { rodando: false }
  }
}

// ----------------------------------------------------------------- rotas

async function api (req, res, url) {
  const caminho = url.pathname.replace(/^\/api/, '') || '/'
  const metodo = req.method
  const partes = caminho.split('/').filter(Boolean)
  const dados = db()

  // GET /api/estado
  if (metodo === 'GET' && caminho === '/estado') {
    // Abrir o app conta como "quero ver o preço de agora": se a última leitura
    // já passou do intervalo, começa uma rodada em segundo plano. A resposta
    // sai na hora — a tela se atualiza sozinha pelos eventos.
    if (dados.config.atualizarAoAbrir !== false && dados.config.agendadorAtivo && !rodadaAtual() && precisaAtualizar()) {
      transmitir({ tipo: 'rodada', fase: 'inicio', texto: 'Atualizando os preços porque você chegou' })
      rodar({ manual: false }).catch(e => console.error('[ao abrir]', e.message))
    }
    return json(res, estadoCompleto())
  }

  // GET /api/eventos  (SSE)
  if (metodo === 'GET' && caminho === '/eventos') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write('retry: 3000\n\n')
    clientes.add(res)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 20000)
    ping.unref?.()
    req.on('close', () => { clearInterval(ping); clientes.delete(res) })
    return
  }

  // ---------------------------------------------------------------- lojas
  // Programas de afiliado conhecidos, para o cadastro já vir com o formato
  // certo de link em vez de o usuário adivinhar.
  if (metodo === 'GET' && caminho === '/afiliados/programas') {
    return json(res, { programas: PROGRAMAS_CONHECIDOS })
  }

  if (metodo === 'GET' && caminho === '/lojas/biblioteca') {
    const jaTem = new Set(dados.lojas.map(l => l.host))
    return json(res, { lojas: LOJAS_CONHECIDAS.map(l => ({ ...l, cadastrada: jaTem.has(l.host) })) })
  }

  if (metodo === 'POST' && caminho === '/lojas/diagnosticar') {
    const corpo = await lerCorpo(req)
    if (!corpo.entrada) return json(res, { erro: 'informe o endereço da loja' }, 400)
    const diagnostico = await diagnosticar(corpo.entrada, {
      termo: corpo.termo || undefined,
      buscaUrlConhecida: corpo.buscaUrl || null,
      aoAndar: (passo) => transmitir({ tipo: 'passo', ...passo })
    })
    return json(res, diagnostico)
  }

  if (metodo === 'POST' && caminho === '/lojas') {
    const corpo = await lerCorpo(req)
    const d = corpo.diagnostico
    if (!d || !d.host) return json(res, { erro: 'faltou o diagnóstico da loja' }, 400)
    if (dados.lojas.some(l => l.host === d.host)) {
      return json(res, { erro: 'essa loja já está cadastrada' }, 409)
    }
    const loja = {
      id: proximoId('loja'),
      usuarioId: dados.config.usuarioId,
      nome: corpo.nome || d.nome || d.host,
      host: d.host,
      origem: d.origem,
      buscaUrl: d.buscaUrl || null,
      seletores: null,
      precisaNavegador: Boolean(d.precisaNavegador),
      buscaDigitada: d.buscaDigitada || null,
      ativa: d.veredito !== 'incompativel',
      veredito: d.veredito,
      diagnostico: d,
      falhasSeguidas: 0,
      ultimoErro: null,
      criadaEm: agora()
    }
    dados.lojas.push(loja)
    await salvar()
    transmitir({ tipo: 'atualizado' })
    return json(res, { loja: lojaPublica(loja) }, 201)
  }

  if (partes[0] === 'lojas' && partes[1]) {
    const loja = dados.lojas.find(l => l.id === partes[1])
    if (!loja) return naoAchou(res, 'loja não encontrada')

    if (metodo === 'PATCH' && partes.length === 2) {
      const corpo = await lerCorpo(req)
      for (const campo of ['ativa', 'nome', 'buscaUrl', 'precisaNavegador', 'escopo']) {
        if (corpo[campo] !== undefined) loja[campo] = corpo[campo]
      }
      if (corpo.seletores !== undefined) {
        loja.seletores = corpo.seletores && corpo.seletores.item
          ? {
              item: String(corpo.seletores.item),
              nome: corpo.seletores.nome ? String(corpo.seletores.nome) : null,
              preco: corpo.seletores.preco ? String(corpo.seletores.preco) : null,
              link: corpo.seletores.link ? String(corpo.seletores.link) : null
            }
          : null
      }
      await salvar()
      transmitir({ tipo: 'atualizado' })
      return json(res, { loja: lojaPublica(loja) })
    }

    // Prova os seletores contra uma busca real, sem salvar nada — é o que
    // permite resgatar loja ⚠️ parcial cuja leitura por layout pegou o campo
    // errado, sem ficar no escuro.
    if (metodo === 'POST' && partes[2] === 'testar-seletores') {
      const corpo = await lerCorpo(req)
      const termo = corpo.termo || 'notebook'
      const url = (loja.buscaUrl || `${loja.origem}/busca?q={q}`).replace('{q}', encodeURIComponent(termo))
      const { buscarComFallback } = await import('./navegador.js')
      const resposta = await buscarComFallback(url, {
        referer: loja.origem,
        preferirNavegador: Boolean(loja.precisaNavegador),
        permitirNavegador: dados.config.usarNavegador !== false,
        modo: dados.config.navegadorVisivel ? true : 'escondido'
      })
      if (!resposta.ok) return json(res, { erro: resposta.motivo || 'a loja não respondeu' }, 502)
      const { extrairPorSeletores } = await import('./extract.js')
      const { parse } = await import('./html.js')
      let itens = []
      try {
        itens = extrairPorSeletores(parse(resposta.html), resposta.urlFinal, corpo.seletores)
      } catch (erro) {
        return json(res, { erro: `seletor inválido: ${erro.message}` }, 400)
      }
      return json(res, {
        total: itens.length,
        comPreco: itens.filter(i => i.preco).length,
        amostra: itens.slice(0, 6).map(i => ({ nome: i.nome, preco: i.preco, url: i.url }))
      })
    }
    if (metodo === 'DELETE' && partes.length === 2) {
      dados.lojas = dados.lojas.filter(l => l.id !== loja.id)
      dados.ofertas = dados.ofertas.filter(o => o.lojaId !== loja.id)
      await salvar()
      transmitir({ tipo: 'atualizado' })
      return json(res, { ok: true })
    }
    if (metodo === 'POST' && partes[2] === 'retestar') {
      const corpo = await lerCorpo(req)
      const d = await diagnosticar(loja.origem, {
        termo: corpo.termo || undefined,
        buscaUrlConhecida: loja.buscaUrl,
        aoAndar: (passo) => transmitir({ tipo: 'passo', ...passo })
      })
      loja.veredito = d.veredito
      loja.diagnostico = d
      loja.precisaNavegador = Boolean(d.precisaNavegador)
      if (d.buscaUrl) loja.buscaUrl = d.buscaUrl
      if (d.veredito === 'incompativel') loja.ativa = false
      loja.falhasSeguidas = 0
      loja.ultimoErro = null
      await salvar()
      transmitir({ tipo: 'atualizado' })
      return json(res, { loja: lojaPublica(loja) })
    }
  }

  // ------------------------------------------------------------ consultas
  if (metodo === 'POST' && caminho === '/consultas/interpretar') {
    const corpo = await lerCorpo(req)
    const interp = interpretar(corpo.texto || '')
    return json(res, { interpretacao: interp, aceita: interp.aceita, motivo: interp.motivo })
  }

  if (metodo === 'POST' && caminho === '/consultas') {
    const corpo = await lerCorpo(req)
    const texto = String(corpo.texto || '').trim()
    const interp = interpretar(texto)
    if (!interp.aceita) {
      return json(res, { erro: 'consulta fora do escopo', motivo: interp.motivo, interpretacao: interp }, 422)
    }
    if (dados.consultas.some(c => c.texto.toLowerCase() === texto.toLowerCase())) {
      return json(res, { erro: 'você já acompanha essa consulta' }, 409)
    }
    const consulta = {
      id: proximoId('consulta'),
      usuarioId: dados.config.usuarioId,
      texto,
      ativa: true,
      precoDesejado: corpo.precoDesejado ? Number(corpo.precoDesejado) : null,
      interpretacao: interp,
      criadaEm: agora(),
      ultimaRodada: null
    }
    dados.consultas.push(consulta)
    await salvar()
    transmitir({ tipo: 'atualizado' })
    return json(res, { consulta: consultaPublica(consulta) }, 201)
  }

  if (partes[0] === 'consultas' && partes[1]) {
    const consulta = dados.consultas.find(c => c.id === partes[1])
    if (!consulta) return naoAchou(res, 'consulta não encontrada')

    if (metodo === 'PATCH' && partes.length === 2) {
      const corpo = await lerCorpo(req)
      if (corpo.texto !== undefined && corpo.texto !== consulta.texto) {
        const interp = interpretar(corpo.texto)
        if (!interp.aceita) return json(res, { erro: 'consulta fora do escopo', motivo: interp.motivo }, 422)
        consulta.texto = corpo.texto
        consulta.interpretacao = interp
      }
      if (corpo.ativa !== undefined) consulta.ativa = Boolean(corpo.ativa)
      if (corpo.precoDesejado !== undefined) {
        consulta.precoDesejado = corpo.precoDesejado === null || corpo.precoDesejado === ''
          ? null
          : Number(corpo.precoDesejado)
        for (const p of dados.produtos) {
          if (p.consultaId === consulta.id && !p.precoDesejadoProprio) p.precoDesejado = consulta.precoDesejado
        }
      }
      await salvar()
      transmitir({ tipo: 'atualizado' })
      return json(res, { consulta: consultaPublica(consulta) })
    }
    if (metodo === 'DELETE' && partes.length === 2) {
      const produtos = dados.produtos.filter(p => p.consultaId === consulta.id).map(p => p.id)
      dados.consultas = dados.consultas.filter(c => c.id !== consulta.id)
      dados.produtos = dados.produtos.filter(p => p.consultaId !== consulta.id)
      dados.ofertas = dados.ofertas.filter(o => !produtos.includes(o.produtoId))
      dados.oportunidades = dados.oportunidades.filter(o => !produtos.includes(o.produtoId))
      // O histórico fica: apagar preço já coletado é perder o que não volta.
      await salvar()
      transmitir({ tipo: 'atualizado' })
      return json(res, { ok: true, historicoPreservado: true })
    }
    if (metodo === 'POST' && partes[2] === 'rodar') {
      if (rodadaAtual()) return json(res, { erro: 'já existe uma rodada em andamento' }, 409)
      rodar({ consultaId: consulta.id, manual: true }).catch(e => console.error('[rodada]', e))
      return json(res, { ok: true, iniciada: true })
    }
  }

  // -------------------------------------------------------------- produtos
  // Ordem escolhida na mão pelo usuário (arrastando os cartões). Fica salva
  // como um número por produto; quem não foi arrastado ainda fica sem `ordem`
  // e cai depois dos que têm, mantendo a ordenação automática entre si.
  if (metodo === 'POST' && caminho === '/produtos/ordem') {
    const corpo = await lerCorpo(req)
    const ids = Array.isArray(corpo.ids) ? corpo.ids : []
    if (!ids.length) return json(res, { erro: 'lista de ids vazia' }, 400)
    ids.forEach((id, indice) => {
      const produto = dados.produtos.find(p => p.id === id)
      if (produto) produto.ordem = indice
    })
    await salvar()
    transmitir({ tipo: 'atualizado' })
    return json(res, { ok: true, ordenados: ids.length })
  }

  if (partes[0] === 'produtos' && partes[1]) {
    const produto = dados.produtos.find(p => p.id === partes[1])
    if (!produto) return naoAchou(res, 'produto não encontrado')

    if (metodo === 'GET' && partes[2] === 'serie') {
      const dias = Number(url.searchParams.get('dias')) || 60
      return json(res, { serie: serieDiaria(produto.id, dias), produto: produtoPublico(produto) })
    }
    if (metodo === 'GET' && partes[2] === 'historico') {
      const pontos = dados.historico
        .filter(h => h.produtoId === produto.id)
        .map(h => {
          const loja = dados.lojas.find(l => l.id === h.lojaId)
          return { ts: h.ts, preco: h.preco, lojaId: h.lojaId, lojaNome: loja ? loja.nome : '—', disponivel: h.disponivel }
        })
      return json(res, { pontos, produto: produtoPublico(produto) })
    }
    // Link colado à mão: a pessoa achou o produto numa loja cuja busca não o
    // devolve. Ela sabe mais que a busca da loja.
    if (metodo === 'POST' && partes[2] === 'link') {
      const corpo = await lerCorpo(req)
      const link = String(corpo.url || '').trim()
      if (!link) return json(res, { erro: 'informe o link do anúncio' }, 400)
      try {
        const resultado = await adicionarOfertaManual(produto.id, link)
        transmitir({ tipo: 'atualizado' })
        return json(res, { ok: true, ...resultado })
      } catch (erro) {
        return json(res, { erro: erro.message }, 400)
      }
    }
    if (metodo === 'PATCH' && partes.length === 2) {
      const corpo = await lerCorpo(req)
      if (corpo.arquivado !== undefined) produto.arquivado = Boolean(corpo.arquivado)
      if (corpo.precoDesejado !== undefined) {
        produto.precoDesejado = corpo.precoDesejado === null || corpo.precoDesejado === ''
          ? null
          : Number(corpo.precoDesejado)
        produto.precoDesejadoProprio = true
      }
      await salvar()
      transmitir({ tipo: 'atualizado' })
      return json(res, { produto: produtoPublico(produto) })
    }
  }

  // --------------------------------------------------------- oportunidades
  if (metodo === 'POST' && caminho === '/oportunidades/lidas') {
    for (const o of dados.oportunidades) o.lida = true
    await salvar()
    transmitir({ tipo: 'atualizado' })
    return json(res, { ok: true })
  }
  if (metodo === 'POST' && partes[0] === 'oportunidades' && partes[2] === 'lida') {
    const op = dados.oportunidades.find(o => o.id === partes[1])
    if (!op) return naoAchou(res, 'oportunidade não encontrada')
    op.lida = true
    await salvar()
    transmitir({ tipo: 'atualizado' })
    return json(res, { ok: true })
  }

  // Séries de todos os produtos de uma vez — a tela de gráficos precisa de
  // várias curvas juntas, e uma requisição por produto deixaria a tela piscando.
  if (metodo === 'GET' && caminho === '/series') {
    const dias = Number(url.searchParams.get('dias')) || 90
    const consultaId = url.searchParams.get('consulta')
    const produtos = dados.produtos.filter(p => !p.arquivado && (!consultaId || p.consultaId === consultaId))
    return json(res, {
      series: produtos.map(p => ({
        id: p.id,
        nome: p.nome,
        marca: p.marca,
        imagem: p.imagem,
        consultaId: p.consultaId,
        precoDesejado: p.precoDesejado,
        resumo: resumoProduto(p),
        serie: serieDiaria(p.id, dias)
      }))
    })
  }

  // ------------------------------------------------------------- exportação
  if (metodo === 'GET' && caminho.startsWith('/exportar/historico')) {
    const linhas = ['produto;marca;loja;preco;disponivel;data;url']
    const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    for (const h of dados.historico) {
      const produto = dados.produtos.find(p => p.id === h.produtoId)
      const loja = dados.lojas.find(l => l.id === h.lojaId)
      linhas.push([
        escapar(produto ? produto.nome : h.produtoId),
        escapar(produto ? produto.marca : ''),
        escapar(loja ? loja.nome : h.lojaId),
        // Vírgula decimal: é assim que o Excel em português entende número.
        escapar(h.preco !== null && h.preco !== undefined ? String(h.preco).replace('.', ',') : ''),
        escapar(h.disponivel === false ? 'nao' : 'sim'),
        escapar(h.ts),
        escapar(h.url || '')
      ].join(';'))
    }
    const corpo = '﻿' + linhas.join('\r\n')   // BOM para o Excel abrir acentuado certo
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="kiwifinder-historico.csv"',
      'Content-Length': Buffer.byteLength(corpo)
    })
    return res.end(corpo)
  }

  // -------------------------------------------------------------- navegador
  if (metodo === 'GET' && caminho === '/navegador') {
    const { disponivel } = await import('./navegador.js')
    return json(res, await disponivel())
  }

  // ------------------------------------------------------------ importação
  /**
   * Sobe o estado de uma máquina para este servidor.
   *
   * Existe para a mudança de casa para a nuvem, e o desenho é deliberado: em
   * vez de a chave do banco descer para o computador do usuário (num .env em
   * texto puro) para um script empurrar os dados, é o ARQUIVO que sobe, por
   * dentro do app já autenticado. A chave fica num lugar só, no servidor.
   *
   * Só aceita quando o servidor está vazio. Importar por cima de um banco com
   * histórico apagaria leitura de preço, que é o único dado insubstituível
   * aqui — e um engano desses não teria volta.
   */
  if (metodo === 'POST' && caminho === '/importar') {
    const jaTem = dados.produtos.length || dados.historico.length || dados.lojas.length
    const corpo = await lerCorpo(req)
    if (jaTem && !corpo.substituir) {
      return json(res, {
        erro: 'este servidor já tem dados',
        detalhe: `${dados.lojas.length} loja(s), ${dados.produtos.length} produto(s) e ${dados.historico.length} leitura(s) de preço. ` +
          'Importar por cima apagaria tudo isso. Envie substituir: true se for mesmo a intenção.'
      }, 409)
    }
    const vindo = corpo.dados
    if (!vindo || typeof vindo !== 'object' || !Array.isArray(vindo.produtos)) {
      return json(res, { erro: 'não reconheci o arquivo — esperava o kiwifinder.json' }, 400)
    }

    // Substitui coleção por coleção, mantendo o objeto `dados` que o resto do
    // app já tem na mão — trocar a referência deixaria módulos apontando para
    // o estado velho.
    for (const chave of ['config', 'lojas', 'consultas', 'produtos', 'ofertas', 'historico', 'oportunidades', 'rodadas', 'seq']) {
      if (vindo[chave] !== undefined) dados[chave] = vindo[chave]
    }
    // O histórico que chegou é novo para este banco: sem limpar a marca, nada
    // seria gravado (ver salvarNoBanco).
    for (const h of dados.historico) delete h.gravadoNoBanco
    await salvar()
    transmitir({ tipo: 'atualizado' })
    return json(res, {
      ok: true,
      lojas: dados.lojas.length,
      consultas: dados.consultas.length,
      produtos: dados.produtos.length,
      ofertas: dados.ofertas.length,
      historico: dados.historico.length
    })
  }

  // ---------------------------------------------------------------- rodada
  if (metodo === 'POST' && caminho === '/rodar') {
    if (rodadaAtual()) return json(res, { erro: 'já existe uma rodada em andamento' }, 409)
    rodar({ manual: true }).catch(e => console.error('[rodada]', e))
    return json(res, { ok: true, iniciada: true })
  }
  if (metodo === 'GET' && caminho === '/rodada/atual') {
    return json(res, rodadaAtual() ? { rodando: true, ...rodadaAtual() } : { rodando: false })
  }

  // --------------------------------------------------------------- config
  if (metodo === 'PATCH' && caminho === '/config') {
    const corpo = await lerCorpo(req)
    const permitidos = ['horarios', 'agendadorAtivo', 'tetoPorConsulta', 'limiarAceite',
      'quedaRelevante', 'tema', 'paginasPorBusca', 'usarNavegador', 'navegadorVisivel', 'verificarCupons',
      'intervaloMinutos', 'atualizarAoAbrir', 'awinaffid',
      'enriquecerProdutos']
    for (const campo of permitidos) {
      if (corpo[campo] !== undefined) dados.config[campo] = corpo[campo]
    }
    await salvar()
    transmitir({ tipo: 'atualizado' })
    return json(res, { config: dados.config })
  }

  return naoAchou(res, `rota ${metodo} ${caminho} não existe`)
}

// ---------------------------------------------------------- arquivos estáticos

async function estatico (req, res, url) {
  let caminho = decodeURIComponent(url.pathname)
  if (caminho === '/' || caminho === '') caminho = '/index.html'
  const arquivo = normalize(join(PUBLICO, caminho))
  if (!arquivo.startsWith(PUBLICO)) { res.writeHead(403); return res.end('proibido') }
  if (!existsSync(arquivo)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end('<p style="font-family:sans-serif;padding:24px">Arquivo não encontrado. ' +
      'Se a interface ainda não abriu, confira se a pasta <code>public</code> existe.</p>')
  }
  const conteudo = await readFile(arquivo)
  res.writeHead(200, {
    'Content-Type': TIPOS[extname(arquivo).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  })
  res.end(conteudo)
}

// ------------------------------------------------------------------- sobe

await carregar()
limparPerfisOrfaos()
iniciarAgendador()

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    // ---- gatilho da rodada por agendador externo ----
    // O plano free do Render suspende a instância depois de 15 minutos parada,
    // e o agendador de dentro do app dorme junto. Manter o serviço acordado o
    // mês inteiro custaria ~730 das 750 horas gratuitas do workspace, sem
    // sobrar nada para outro projeto.
    //
    // Sai muito mais barato ACORDAR para rodar e voltar a dormir: uma rodada
    // leva ~3 minutos, o que dá ~36 horas por mês. Fica fora da senha porque
    // quem chama é uma máquina; o que autoriza é o token.
    if (url.pathname === '/api/rodar-agendado') {
      const token = process.env.CRON_TOKEN
      const enviado = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer /, '')
      if (!token) return json(res, { erro: 'CRON_TOKEN não configurado neste servidor' }, 501)
      if (enviado !== token) return json(res, { erro: 'token inválido' }, 401)
      if (rodadaAtual()) return json(res, { ok: true, jaRodando: true })
      // Espera a rodada TERMINAR antes de responder: se responder na hora, o
      // Render pode suspender a instância no meio da coleta.
      try {
        const registro = await rodar({ manual: false })
        return json(res, {
          ok: true,
          itensLidos: registro.itensLidos,
          produtosNovos: registro.produtosNovos,
          oportunidades: registro.oportunidades,
          erros: registro.erros
        })
      } catch (erro) {
        return json(res, { ok: false, erro: erro.message }, 500)
      }
    }

    // ---- saída para a loja ----
    /**
     * O link que a pessoa vê é o NOSSO, não o da rede de afiliados.
     *
     * `https://www.awin1.com/cread.php?awinmid=31355&awinaffid=3067039&ued=...`
     * é o endereço técnico do redirecionador da Awin. Ele funciona, mas quem
     * passa o mouse em cima lê um domínio que não conhece, cheio de números —
     * e desconfia. Com razão: é exatamente com essa cara que golpe se parece.
     *
     * Então o link visível vira `/ir/of_123`, no domínio do próprio KiwiFinder,
     * e o servidor redireciona por baixo. A Awin continua registrando o clique
     * normalmente (o navegador passa por lá antes de chegar na loja) — só que a
     * pessoa vê o nome em que ela confia.
     *
     * É o que todo comparador de preço faz, e é o motivo de nenhum deles
     * mostrar link de rede de afiliados na tela.
     */
    if (url.pathname.startsWith('/ir/')) {
      const id = decodeURIComponent(url.pathname.slice(4))
      const dados = db()
      const oferta = dados.ofertas.find(o => o.id === id)
      if (!oferta || !oferta.url) return naoAchou(res, 'oferta não encontrada')
      const loja = dados.lojas.find(l => l.id === oferta.lojaId)
      const destino = aplicarAfiliado(oferta.url, loja && loja.afiliado, { awinaffid: dados.config.awinaffid })
      // 302 e não 301: o destino muda quando o anúncio muda de endereço, e um
      // 301 ficaria gravado no navegador da pessoa para sempre.
      res.writeHead(302, { Location: destino, 'Cache-Control': 'no-store' })
      return res.end()
    }

    // ---- o que este servidor alcança ----
    /**
     * Diagnóstico de rede, autorizado pelo mesmo token do agendador.
     *
     * Existe porque "a loja dá 403" tem duas causas muito diferentes e
     * indistinguíveis de fora: a loja recusa qualquer robô, ou recusa a FAIXA
     * DE IP deste servidor. A primeira é decisão dela sobre coleta; a segunda é
     * reputação do datacenter, e some trocando de hospedagem.
     *
     * Medir isso do lado de fora é impossível — só o próprio servidor sabe o
     * que consegue abrir.
     */
    if (url.pathname === '/api/alcance') {
      const token = process.env.CRON_TOKEN
      const enviado = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer /, '')
      if (!token || enviado !== token) return json(res, { erro: 'token inválido' }, 401)
      const alvos = (url.searchParams.get('urls') || '').split(',').filter(Boolean)
      if (!alvos.length) return json(res, { erro: 'passe ?urls=a,b,c' }, 400)
      const { buscar } = await import('./net.js')
      const saida = []
      for (const alvo of alvos.slice(0, 8)) {
        try {
          const r = await buscar(alvo, { tentativas: 1, usarCache: false })
          saida.push({ url: alvo, status: r.status, bytes: (r.html || '').length, bloqueado: Boolean(r.bloqueado) })
        } catch (erro) {
          saida.push({ url: alvo, erro: erro.message.slice(0, 80) })
        }
      }
      return json(res, { resultados: saida })
    }

    // Sinal de vida para o Render saber que a instância subiu.
    if (url.pathname === '/saude') {
      // Fora da senha de propósito: é como o Render sabe que a instância subiu.
      return json(res, { ok: true, guardando: ondeGuarda() })
    }

    // ---- porta de entrada ----
    // Só existe quando KIWI_SENHA está no ambiente. Na máquina de casa não
    // está, e o app abre direto, como sempre abriu.
    if (exigeSenha()) {
      if (url.pathname === '/entrar' && req.method === 'POST') {
        const corpo = await lerCorpoTexto(req)
        const senha = new URLSearchParams(corpo).get('senha') || ''
        if (senhaConfere(senha)) {
          res.writeHead(302, { Location: '/', 'Set-Cookie': criarCookieDeSessao() })
          return res.end()
        }
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(paginaDeLogin('Senha incorreta.'))
      }
      if (url.pathname === '/sair') {
        res.writeHead(302, { Location: '/', 'Set-Cookie': cookieDeSaida() })
        return res.end()
      }
      if (!sessaoValida(req)) {
        // A API responde 401 em JSON; a tela responde com o formulário. Sem
        // isso, uma sessão vencida devolveria HTML dentro de um fetch e o app
        // quebraria com um erro sem sentido.
        if (url.pathname.startsWith('/api')) return json(res, { erro: 'sessão expirada' }, 401)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(paginaDeLogin())
      }
    }

    if (url.pathname.startsWith('/api')) return await api(req, res, url)
    return await estatico(req, res, url)
  } catch (erro) {
    console.error('[servidor]', erro)
    if (!res.headersSent) json(res, { erro: erro.message || 'erro interno' }, 500)
    else res.end()
  }
})

servidor.listen(PORTA, () => {
  const d = db()
  console.log('')
  console.log('  KiwiFinder — Deal Finder')
  console.log(`  http://localhost:${PORTA}/`)
  console.log(`  ${d.lojas.length} loja(s), ${d.consultas.length} consulta(s), ${d.produtos.length} produto(s)`)
  console.log(`  Rodadas automáticas: ${(d.config.horarios || []).join(' e ')}` +
    `${d.config.agendadorAtivo ? '' : ' (desligadas)'}`)
  console.log('')
})

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    await salvar().catch(() => {})
    servidor.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
