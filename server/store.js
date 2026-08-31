// Persistência do KiwiFinder.
//
// Protótipo: banco é um arquivo JSON em dados/kiwifinder.json, carregado na
// memória e gravado de forma atômica (escreve .tmp e renomeia). É o suficiente
// para uso pessoal — a spec prevê PostgreSQL, e a troca fica isolada aqui.
//
// Decisão registrada na nota: mesmo sendo de uso pessoal, todo dado nasce com
// dono (usuarioId). Voltar atrás nisso depois custaria remodelar tudo.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configurado as temSupabase, carregarDoBanco, salvarNoBanco } from './supabase.js'

const raiz = dirname(dirname(fileURLToPath(import.meta.url)))
export const PASTA_DADOS = join(raiz, 'dados')
const ARQUIVO = join(PASTA_DADOS, 'kiwifinder.json')
const ARQUIVO_TMP = ARQUIVO + '.tmp'

export const USUARIO_PADRAO = 'gabriel'

// v2 muda a POSTURA do app com as lojas. A v1 lia qualquer loja que
// conseguisse ler; a v2 só lê o que a loja serve de bom grado, e prefere dado
// que a loja publicou de propósito (feed de afiliado, API oficial) ao dado
// raspado da vitrine. Ver "Da v1 para a v2" no LEIA-ME.
const VAZIO = {
  versao: 2,
  config: {
    usuarioId: USUARIO_PADRAO,

    // ---- postura com as lojas (novo na v2) ----
    // Loja que recusa requisição comum (403, casca vazia, bloqueio explícito)
    // deixa de ser aberta no navegador real. Recusa é resposta, não obstáculo:
    // a via para essas lojas passa a ser feed de afiliado ou API oficial.
    respeitarRecusa: true,
    // robots.txt passa a valer nas rodadas, não só no diagnóstico.
    respeitarRobots: true,
    // Ficha técnica copiada da página não é mais guardada: era conteúdo da
    // loja, sem uso em lugar nenhum da tela.
    guardarFichaTecnica: false,
    // Loja de busca só-JavaScript é lida pelo sitemap dela, não por navegador.
    usarSitemap: true,
    paginasPorSitemap: 8,
    // Seu id de publisher na Awin. Vale para TODAS as lojas da rede, então
    // mora aqui e não repetido em cada uma — cada loja guarda só o `awinmid`
    // dela. Vazio = links saem sem afiliado, que é o padrão seguro.
    awinaffid: '',

    intervaloMinutos: 60,               // atualiza de hora em hora
    atualizarAoAbrir: true,             // e assim que você abre o app, se estiver velho
    horarios: [],                       // horários fixos (opcional; vazio = só o intervalo)
    agendadorAtivo: true,
    tetoPorConsulta: 40,                // máximo de produtos monitorados por consulta
    limiarAceite: 62,                   // score mínimo para casar automaticamente
    limiarAmbiguo: 45,                  // entre ambíguo e aceite fica "para revisar"
    quedaRelevante: 5,                  // % de queda que vira oportunidade
    verificarCupons: true,              // abre a página do anúncio atrás de cupom/desconto à vista
    paginasPorBusca: 1,                 // páginas de resultado lidas por consulta
    // Navegador real continua existindo para loja que MONTA a página em
    // JavaScript sem recusar ninguém (Go Imports é assim) — usar o site como
    // qualquer visitante usa. O que saiu foi usá-lo contra uma recusa.
    usarNavegador: true,
    navegadorVisivel: false,            // false = janela fora da tela
    enriquecerProdutos: true,           // abre a página do produto novo atrás de EAN/GTIN
    tema: 'auto'
  },
  lojas: [],
  consultas: [],
  produtos: [],
  ofertas: [],        // ligação produto × loja (anúncio vigente)
  historico: [],      // ponto de preço no tempo — sobrevive à troca de URL
  oportunidades: [],
  rodadas: [],
  seq: {}
}

let dados = null
let gravando = null
let regravar = false

export function proximoId (colecao) {
  dados.seq[colecao] = (dados.seq[colecao] || 0) + 1
  return `${colecao}_${dados.seq[colecao]}`
}

/**
 * Onde os dados moram. Decidido pelo ambiente, não por configuração no app:
 * com SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente, é o Supabase; sem elas,
 * é o arquivo local de sempre.
 *
 * A mesma máquina pode rodar dos dois jeitos, e é assim que o app continua
 * funcionando offline enquanto a versão online existe em paralelo.
 */
export function ondeGuarda () {
  return temSupabase() ? 'supabase' : 'arquivo'
}

export async function carregar () {
  if (dados) return dados

  if (temSupabase()) {
    const doBanco = await carregarDoBanco()
    dados = doBanco || estruturaClonada(VAZIO)
    completarComPadroes()
    // O histórico que veio do banco já está gravado nele — sem esta marca, a
    // primeira gravação reinseriria tudo de novo, duplicando o histórico.
    for (const h of dados.historico || []) h.gravadoNoBanco = true
    return dados
  }

  if (!existsSync(PASTA_DADOS)) await mkdir(PASTA_DADOS, { recursive: true })
  if (existsSync(ARQUIVO)) {
    try {
      dados = JSON.parse(await readFile(ARQUIVO, 'utf8'))
      for (const [chave, valor] of Object.entries(VAZIO)) {
        if (dados[chave] === undefined) dados[chave] = estruturaClonada(valor)
      }
      for (const [chave, valor] of Object.entries(VAZIO.config)) {
        if (dados.config[chave] === undefined) dados.config[chave] = valor
      }
    } catch (erro) {
      // Arquivo corrompido não pode derrubar o app nem ser sobrescrito calado.
      const backup = ARQUIVO + '.quebrado-' + Date.now()
      await rename(ARQUIVO, backup).catch(() => {})
      console.error(`[store] JSON ilegível, movido para ${backup}:`, erro.message)
      dados = estruturaClonada(VAZIO)
    }
  } else {
    dados = estruturaClonada(VAZIO)
  }
  return dados
}

// Campo novo no VAZIO precisa aparecer em base antiga sem apagar o que existe.
function completarComPadroes () {
  for (const [chave, valor] of Object.entries(VAZIO)) {
    if (dados[chave] === undefined) dados[chave] = estruturaClonada(valor)
  }
  for (const [chave, valor] of Object.entries(VAZIO.config)) {
    if (dados.config[chave] === undefined) dados.config[chave] = valor
  }
}

function estruturaClonada (v) {
  return JSON.parse(JSON.stringify(v))
}

export function db () {
  if (!dados) throw new Error('store não carregado — chame carregar() antes')
  return dados
}

// Escrita com coalescência: várias chamadas seguidas viram uma gravação só.
// No arquivo ela é atômica (escreve .tmp e renomeia); no Supabase, o documento
// vai inteiro e o histórico vai incremental.
export async function salvar () {
  if (gravando) { regravar = true; return gravando }
  gravando = (async () => {
    try {
      if (temSupabase()) {
        await salvarNoBanco(dados)
      } else {
        await writeFile(ARQUIVO_TMP, JSON.stringify(dados, null, 2), 'utf8')
        await rename(ARQUIVO_TMP, ARQUIVO)
      }
    } catch (erro) {
      // Falha de gravação não pode passar em silêncio: no arquivo é raro, mas
      // na nuvem a rede cai, e perder preço coletado sem avisar é o pior
      // resultado possível.
      console.error('[store] falha ao gravar:', erro.message)
      throw erro
    } finally {
      gravando = null
      if (regravar) { regravar = false; await salvar() }
    }
  })()
  return gravando
}

export const agora = () => new Date().toISOString()
