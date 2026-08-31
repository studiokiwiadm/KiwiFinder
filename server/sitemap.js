// Busca pelo sitemap da loja, em vez de pela caixa de busca dela.
//
// Sitemap é um arquivo que a loja publica no endereço `/sitemap.xml` com a
// lista de tudo que ela quer que máquinas encontrem. Ele existe exatamente
// para isso — é o mecanismo padrão pelo qual uma loja diz "leia estas páginas".
//
// Para o KiwiFinder ele resolve o caso mais chato que existe: loja cuja busca
// só funciona em JavaScript. A Go Imports é assim — a caixa de busca dela não
// tem URL para chamar, e a única saída era abrir um Chrome de verdade, digitar
// e esperar a página montar. Custava 5 a 25 segundos por busca e exigia Chrome
// instalado, o que não existe num servidor.
//
// Com o sitemap, a mesma loja custa 900ms por página e nenhum navegador:
//
//   1. baixa o sitemap uma vez por dia (82 KB, 350 produtos, no caso da Go Imports)
//   2. filtra as URLs pelos termos da busca — o endereço já descreve o produto
//      (`/MacBook-Air-13-2026-M5-16GB-512GB-SSD`)
//   3. abre só as páginas que casaram
//
// É o mesmo desenho de um feed de afiliado: catálogo local, busca local, e a
// rede só entra para pegar o preço de quem interessa.

import { buscar } from './net.js'
import { extrairProduto } from './extract.js'
import { compacto, tokensDe } from './nlp.js'

// Um sitemap muda pouco: produto novo entra, produto velho sai, e nada disso
// acontece de hora em hora. Uma vez por dia é generoso.
const VALIDADE_MS = 24 * 3600 * 1000
const cache = new Map() // origem -> { ts, urls }

/** Onde procurar o sitemap, em ordem de probabilidade. */
function candidatos (origem) {
  const base = origem.replace(/\/$/, '')
  return [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`, `${base}/sitemap/sitemap.xml`]
}

/**
 * Lê o sitemap da loja e devolve as URLs de página. Segue um nível de índice
 * (`<sitemapindex>`), que é como lojas grandes dividem o arquivo.
 */
export async function lerSitemap (origem) {
  const guardado = cache.get(origem)
  if (guardado && Date.now() - guardado.ts < VALIDADE_MS) return guardado.urls

  let urls = []
  for (const alvo of candidatos(origem)) {
    const r = await buscar(alvo, { tentativas: 1 })
    if (!r.ok || !r.html || !r.html.includes('<loc>')) continue

    const achadas = [...r.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1])
    // Índice de sitemaps: as entradas apontam para outros sitemaps.
    const ehIndice = /<sitemapindex/i.test(r.html)
    if (ehIndice) {
      // Limite deliberado: um índice pode ter dezenas de arquivos, e baixar
      // todos custaria mais que a busca que estamos tentando evitar.
      for (const filho of achadas.slice(0, 5)) {
        const f = await buscar(filho, { tentativas: 1 })
        if (f.ok && f.html) urls.push(...[...f.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]))
      }
    } else {
      urls = achadas
    }
    if (urls.length) break
  }

  cache.set(origem, { ts: Date.now(), urls })
  return urls
}

/**
 * Quanto a URL casa com o que se procura.
 *
 * O endereço já descreve o produto na maioria das lojas
 * (`/MacBook-Air-13-2026-M5-16GB-512GB-SSD`), então dá para pontuar sem abrir
 * nada. Exige TODOS os termos fortes: numa busca por "macbook air", trazer todo
 * MacBook Pro da loja seria pior que não trazer nada.
 */
export function pontuarUrl (url, termos) {
  const alvo = compacto(decodeURIComponent(url))
  let acertos = 0
  for (const t of termos) {
    if (alvo.includes(t)) acertos++
  }
  if (acertos < termos.length) return 0
  // Empate entre URLs que casaram tudo: a mais curta é a mais específica
  // (`/MacBook-Air-13` ganha de `/MacBook-Air-13-capa-protetora`).
  return 1000 - Math.min(alvo.length, 900)
}

/**
 * Busca no sitemap e devolve itens no mesmo formato de `extrairResultados`.
 *
 * `limite` é o teto de páginas abertas por busca. Existe porque cada página é
 * uma requisição à loja: sem teto, uma busca genérica abriria o catálogo
 * inteiro.
 */
export async function buscarPorSitemap (loja, termo, limite = 8) {
  const termos = tokensDe(termo).filter(t => t.length > 2).map(compacto)
  if (!termos.length) return { itens: [], estrategia: 'sitemap' }

  const urls = await lerSitemap(loja.origem)
  if (!urls.length) return { itens: [], estrategia: 'sitemap', erro: 'a loja não publica sitemap' }

  const candidatas = urls
    .map(u => ({ url: u, nota: pontuarUrl(u, termos) }))
    .filter(c => c.nota > 0)
    .sort((a, b) => b.nota - a.nota)
    .slice(0, limite)

  const itens = []
  for (const c of candidatas) {
    const r = await buscar(c.url, { referer: loja.origem, tentativas: 1 })
    if (!r.ok) continue
    const p = extrairProduto(r.html, r.urlFinal)
    if (!p || !p.preco) continue
    itens.push({
      nome: p.nome,
      preco: p.preco,
      precoDe: p.precoDe || null,
      precoAVista: p.precoAVista || null,
      moeda: 'BRL',
      url: r.urlFinal,
      imagem: p.imagem || null,
      marca: p.marca || '',
      gtin: p.gtin || '',
      mpn: p.mpn || '',
      condicao: p.condicao || null,
      parcelamento: p.parcelamento || null,
      fonte: 'sitemap'
    })
  }

  return { itens, estrategia: 'sitemap', catalogo: urls.length, abertas: candidatas.length }
}
