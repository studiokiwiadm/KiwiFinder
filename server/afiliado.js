// Link de afiliado: como o KiwiFinder pode se sustentar sem ficar do lado
// errado das lojas.
//
// A ideia central da v2 vem de uma constatação simples: Buscapé, Zoom e Google
// Shopping não raspam, eles RECEBEM. A loja quer aparecer no comparador porque
// comparador é canal de venda, então ela publica um feed e paga por venda. Quem
// entra por essa porta não passa pelo problema — está do lado certo dele.
//
// Este módulo cuida da ponta visível disso: transformar o link do anúncio no
// link com o código de quem indicou. É deliberadamente burro e declarativo —
// cada loja diz COMO o código dela entra na URL, e nada aqui sabe o nome de
// nenhuma loja.
//
// Três formatos cobrem praticamente tudo que existe no mercado brasileiro:
//
//   parametro  ?tag=kiwi-20            Amazon Associates, Mercado Livre
//   caminho    https://redir/?url=…    Awin, Rakuten, Lomadee, Afilio
//   sufixo     …&utm_source=kiwi       programas próprios mais simples
//
// O que este módulo NÃO faz, de propósito: esconder que o link é de afiliado.
// A divulgação é obrigatória em praticamente todo programa, e é o mínimo de
// honestidade com quem clica. Ver `precisaDivulgar`.

/**
 * @typedef {object} Afiliado
 * @property {'parametro'|'caminho'|'sufixo'} tipo
 * @property {string} [chave]     nome do parâmetro (tipo `parametro`)
 * @property {string} [valor]     seu código / id de afiliado
 * @property {string} [modelo]    URL com {url} e {codigo} (tipo `caminho`)
 * @property {string} [rede]      "Amazon Associates", "Awin"… — só para a tela
 */

/**
 * Aplica o código de afiliado a uma URL de anúncio.
 *
 * Nunca inventa: sem configuração, devolve a URL original intacta. Um link
 * quebrado é pior que um link sem comissão — o objetivo do app é levar a
 * pessoa até a compra certa.
 *
 * @param {string} url
 * @param {Afiliado|null} afiliado
 * @returns {string}
 */
export function aplicarAfiliado (url, afiliado) {
  if (!url || !afiliado || !afiliado.tipo) return url
  try {
    switch (afiliado.tipo) {
      case 'parametro': {
        if (!afiliado.chave || !afiliado.valor) return url
        const alvo = new URL(url)
        // `set`, não `append`: se o anúncio já veio com uma tag (acontece
        // quando o link foi copiado de outro lugar), a nossa substitui em vez
        // de duplicar o parâmetro.
        alvo.searchParams.set(afiliado.chave, afiliado.valor)
        return alvo.href
      }
      case 'caminho': {
        // Rede de afiliados: o clique passa pelo redirecionador dela, que
        // registra e devolve a pessoa para a loja.
        if (!afiliado.modelo) return url
        return afiliado.modelo
          .replace('{url}', encodeURIComponent(url))
          .replace('{codigo}', encodeURIComponent(afiliado.valor || ''))
      }
      case 'sufixo': {
        if (!afiliado.valor) return url
        const junta = url.includes('?') ? '&' : '?'
        return url + junta + afiliado.valor.replace(/^[?&]/, '')
      }
      default:
        return url
    }
  } catch {
    // URL malformada não pode impedir a pessoa de chegar na loja.
    return url
  }
}

/** Tem código de afiliado configurado e utilizável? */
export function temAfiliado (afiliado) {
  if (!afiliado || !afiliado.tipo) return false
  if (afiliado.tipo === 'caminho') return Boolean(afiliado.modelo)
  return Boolean(afiliado.valor)
}

/**
 * Toda rede exige que o link de afiliado seja declarado a quem clica, e é o
 * mínimo de honestidade de qualquer jeito: a pessoa precisa saber que existe
 * um interesse na indicação. Uma linha resolve — e ela só aparece quando há
 * de fato um link de afiliado no ar.
 */
export function precisaDivulgar (lojas) {
  return (lojas || []).some(l => temAfiliado(l.afiliado))
}

export const TEXTO_DIVULGACAO =
  'Alguns links levam código de afiliado: se você comprar por eles, o KiwiFinder ' +
  'recebe uma comissão da loja, sem custo nenhum para você. Isso não altera o ' +
  'preço nem a ordem da comparação — quem aparece primeiro é sempre o mais barato.'

/**
 * Programas conhecidos, para o cadastro de loja já vir com o formato certo em
 * vez de pedir para o usuário adivinhar. `valor` fica vazio: é o código dele,
 * que só ele tem.
 *
 * Isto é um ponto de partida da interface, não uma integração — entrar em cada
 * programa é um cadastro manual, com aprovação do anunciante.
 */
export const PROGRAMAS_CONHECIDOS = [
  {
    id: 'amazon-associates',
    nome: 'Amazon Associates',
    host: 'amazon.com.br',
    afiliado: { tipo: 'parametro', chave: 'tag', valor: '', rede: 'Amazon Associates' },
    cadastro: 'https://associados.amazon.com.br/',
    observacao: 'Dá também acesso à Product Advertising API, que entrega preço e ' +
      'estoque de forma oficial — é o caminho certo para a Amazon, que hoje recusa leitura comum.'
  },
  {
    id: 'mercado-livre',
    nome: 'Mercado Livre Afiliados',
    host: 'mercadolivre.com.br',
    afiliado: { tipo: 'parametro', chave: 'matt_word', valor: '', rede: 'Mercado Livre' },
    cadastro: 'https://www.mercadolivre.com.br/afiliados',
    observacao: 'Tem API pública de busca de produtos, sem necessidade de raspagem.'
  },
  {
    id: 'awin',
    nome: 'Awin',
    host: null,
    afiliado: { tipo: 'caminho', modelo: 'https://www.awin1.com/cread.php?awinmid={codigo}&awinaffid=SEU_ID&ued={url}', valor: '', rede: 'Awin' },
    cadastro: 'https://www.awin.com/br',
    observacao: 'Rede: você entra uma vez e se candidata a vários anunciantes. Muitos ' +
      'entregam feed de produtos ao afiliado — que é exatamente o dado que o app precisa, com permissão embutida.'
  },
  {
    id: 'rakuten',
    nome: 'Rakuten Advertising',
    host: null,
    afiliado: { tipo: 'caminho', modelo: 'https://click.linksynergy.com/deeplink?id={codigo}&mid=SEU_MID&murl={url}', valor: '', rede: 'Rakuten' },
    cadastro: 'https://rakutenadvertising.com/',
    observacao: 'Mesma lógica da Awin, com catálogo internacional maior.'
  },
  {
    id: 'lomadee',
    nome: 'Lomadee',
    host: null,
    afiliado: { tipo: 'parametro', chave: 'sourceId', valor: '', rede: 'Lomadee' },
    cadastro: 'https://www.lomadee.com/',
    observacao: 'Rede brasileira, com boa cobertura de varejo nacional.'
  },
  {
    id: 'afilio',
    nome: 'Afilio',
    host: null,
    afiliado: { tipo: 'caminho', modelo: 'https://afilio.com.br/redirect?pid={codigo}&url={url}', valor: '', rede: 'Afilio' },
    cadastro: 'https://www.afilio.com.br/',
    observacao: 'Rede brasileira, forte em varejo e moda.'
  }
]
