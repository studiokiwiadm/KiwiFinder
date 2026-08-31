// Persistência no Supabase, falando com o PostgREST por `fetch`.
//
// Por que REST e não um driver de Postgres: o núcleo do KiwiFinder não tem
// dependência nenhuma, e essa escolha se paga toda vez que o app precisa rodar
// em outro lugar. O Supabase expõe o banco por HTTP; `fetch` é nativo no Node.
// Também evita o problema chato de pool de conexão num serviço que dorme e
// acorda (o plano free do Render suspende a instância entre acessos).
//
// O desenho é deliberadamente conservador, e o motivo é o valor de cada peça:
//
//   estado     — UMA linha com o documento inteiro em JSONB (config, lojas,
//                consultas, produtos, ofertas…). Muda junto, é pequeno, e
//                reescrever tudo é mais simples e mais seguro que sincronizar
//                dez tabelas com o código que já existe.
//
//   historico  — tabela de verdade, append-only. É o único dado que NÃO dá
//                para reconstruir: preço de ontem não volta. Cresce para
//                sempre, então não pode viver dentro de um documento que é
//                reescrito por inteiro a cada gravação.

// O plano free do Supabase dá 2 projetos ativos por organização. Com prefixo
// configurável, dois apps dividem um projeto só e sobra slot — basta rodar o
// esquema.sql trocando os nomes e apontar SUPABASE_PREFIXO aqui.
const PREFIXO = process.env.SUPABASE_PREFIXO || ''
const TABELA_ESTADO = PREFIXO + 'estado'
const TABELA_HISTORICO = PREFIXO + 'historico'
const ID_DOCUMENTO = 'kiwifinder'

let base = null
let chave = null

export function configurado () {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
}

function iniciar () {
  if (base) return
  // A tela do Supabase mostra o endereço já com /rest/v1 no fim, e é natural
  // copiar assim. Aceitar as duas formas evita um /rest/v1/rest/v1 que só
  // apareceria como "não achei nada" bem mais tarde.
  const cru = String(process.env.SUPABASE_URL).trim().replace(/\/+$/, '')
  base = cru.replace(/\/rest\/v1$/, '') + '/rest/v1'
  chave = String(process.env.SUPABASE_SERVICE_KEY).trim()
}

async function chamar (caminho, opcoes = {}) {
  iniciar()
  const resposta = await fetch(base + caminho, {
    ...opcoes,
    headers: {
      apikey: chave,
      Authorization: `Bearer ${chave}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {})
    }
  })
  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '')
    throw new Error(`Supabase ${resposta.status}: ${corpo.slice(0, 300)}`)
  }
  if (resposta.status === 204) return null
  const texto = await resposta.text()
  return texto ? JSON.parse(texto) : null
}

/**
 * Traz o documento e TODO o histórico, montando na memória a mesma estrutura
 * que o resto do app sempre usou. É o que permite ligar o Postgres sem tocar
 * nas 12 mil linhas que leem `db()` de forma síncrona.
 */
export async function carregarDoBanco () {
  const linhas = await chamar(`/${TABELA_ESTADO}?id=eq.${ID_DOCUMENTO}&select=documento`)
  const documento = linhas && linhas[0] ? linhas[0].documento : null
  if (!documento) return null

  documento.historico = await carregarHistorico()
  return documento
}

async function carregarHistorico () {
  // Paginado: o PostgREST devolve no máximo 1000 linhas por vez.
  const tudo = []
  const passo = 1000
  for (let inicio = 0; ; inicio += passo) {
    const pagina = await chamar(
      `/${TABELA_HISTORICO}?select=*&order=id.asc&offset=${inicio}&limit=${passo}`
    )
    if (!pagina || !pagina.length) break
    for (const l of pagina) {
      tudo.push({
        id: 'hist_' + l.id,
        produtoId: l.produto_id,
        lojaId: l.loja_id,
        preco: l.preco === null ? null : Number(l.preco),
        precoDe: l.preco_de === null ? null : Number(l.preco_de),
        disponivel: l.disponivel,
        url: l.url,
        ts: l.ts
      })
    }
    if (pagina.length < passo) break
  }
  return tudo
}

/**
 * Grava. O documento vai inteiro; do histórico vão só as linhas novas.
 *
 * "Nova" é decidido pelo carimbo `gravadoNoBanco` que esta função mesmo põe —
 * não por contagem nem por data, que erram quando duas gravações se cruzam.
 */
export async function salvarNoBanco (dados) {
  const novas = (dados.historico || []).filter(h => !h.gravadoNoBanco)
  if (novas.length) {
    await chamar(`/${TABELA_HISTORICO}`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(novas.map(h => ({
        produto_id: h.produtoId,
        loja_id: h.lojaId,
        preco: h.preco,
        preco_de: h.precoDe ?? null,
        disponivel: h.disponivel ?? null,
        url: h.url ?? null,
        ts: h.ts
      })))
    })
    // Só depois de o banco confirmar. Se a chamada acima falhar, elas
    // continuam pendentes e entram na próxima gravação.
    for (const h of novas) h.gravadoNoBanco = true
  }

  // O histórico sai do documento: ele tem tabela própria, e duplicar seria
  // reescrever megabytes a cada salvamento.
  const documento = { ...dados, historico: undefined }
  delete documento.historico

  await chamar(`/${TABELA_ESTADO}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      id: ID_DOCUMENTO,
      documento,
      atualizado_em: new Date().toISOString()
    }])
  })
}

/**
 * Sobe um estado local para o banco — é o caminho de mudança da máquina para a
 * nuvem, rodado uma vez.
 */
export async function importarParaOBanco (dados) {
  for (const h of dados.historico || []) delete h.gravadoNoBanco
  await salvarNoBanco(dados)
  return { historico: (dados.historico || []).length }
}

/** Confere se as tabelas existem e respondem, com mensagem útil quando não. */
export async function testarConexao () {
  try {
    await chamar(`/${TABELA_ESTADO}?select=id&limit=1`)
    await chamar(`/${TABELA_HISTORICO}?select=id&limit=1`)
    return { ok: true }
  } catch (erro) {
    return {
      ok: false,
      motivo: erro.message.includes('42P01') || erro.message.includes('does not exist')
        ? 'as tabelas ainda não existem — rode o SQL de dados/esquema.sql no editor do Supabase'
        : erro.message
    }
  }
}
