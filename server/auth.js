// Porta de entrada do app quando ele está na internet.
//
// Na máquina do Gabriel o KiwiFinder não tinha senha, e estava certo: só quem
// senta no computador abre. Online é outra história — sem isto, qualquer um
// com o endereço vê os produtos que ele acompanha, cadastra loja, dispara
// rodada e apaga o histórico.
//
// É deliberadamente simples: uma senha, um cookie assinado, sem banco de
// usuário. O app tem um dono só. Quando tiver mais de um, isto vira login de
// verdade — e aí `usuarioId`, que já existe em todo registro desde o primeiro
// dia, passa a valer.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

const NOME_COOKIE = 'kiwi_sessao'
const DURACAO_DIAS = 30

// Segredo para assinar o cookie. Sem ele configurado, um é sorteado na subida:
// funciona, mas derruba as sessões a cada reinício (no Render, isso é toda vez
// que o serviço acorda). Definir SESSION_SECRET evita esse incômodo.
const SEGREDO = process.env.SESSION_SECRET || randomBytes(32).toString('hex')

export function exigeSenha () {
  return Boolean(process.env.KIWI_SENHA)
}

function assinar (valor) {
  return createHmac('sha256', SEGREDO).update(valor).digest('hex')
}

/** Compara sem vazar, pelo tempo, quantos caracteres bateram. */
function iguais (a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function criarCookieDeSessao () {
  const expira = Date.now() + DURACAO_DIAS * 24 * 3600 * 1000
  const corpo = String(expira)
  const valor = `${corpo}.${assinar(corpo)}`
  return `${NOME_COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACAO_DIAS * 24 * 3600}` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : '')
}

export function cookieDeSaida () {
  return `${NOME_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function sessaoValida (req) {
  if (!exigeSenha()) return true
  const bruto = req.headers.cookie || ''
  const par = bruto.split(';').map(p => p.trim()).find(p => p.startsWith(NOME_COOKIE + '='))
  if (!par) return false
  const valor = par.slice(NOME_COOKIE.length + 1)
  const [corpo, assinatura] = valor.split('.')
  if (!corpo || !assinatura) return false
  if (!iguais(assinatura, assinar(corpo))) return false
  return Number(corpo) > Date.now()
}

export function senhaConfere (tentativa) {
  const certa = process.env.KIWI_SENHA || ''
  if (!certa) return false
  // Normaliza o tamanho antes de comparar, para o timingSafeEqual não recusar
  // por comprimento diferente (o que já entregaria uma informação).
  return iguais(assinar(String(tentativa)), assinar(certa))
}

export function paginaDeLogin (erro = null) {
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KiwiFinder</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #16171a; color: #e8e8ea;
    font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    padding: 24px;
  }
  form { width: min(340px, 100%); }
  h1 { font-size: 1.6rem; letter-spacing: -0.03em; margin: 0 0 6px; }
  p.sub { margin: 0 0 26px; color: #8b8b93; font-size: 0.9rem; }
  input {
    width: 100%; box-sizing: border-box; padding: 12px 14px; margin-bottom: 12px;
    background: #202126; border: 1px solid #2e2f36; border-radius: 11px;
    color: inherit; font: inherit;
  }
  input:focus { outline: 2px solid #7CB342; outline-offset: 1px; }
  button {
    width: 100%; padding: 12px; border: 0; border-radius: 11px;
    background: #7CB342; color: #fff; font: inherit; font-weight: 550; cursor: pointer;
  }
  .erro { color: #ff8a80; font-size: 0.86rem; margin-bottom: 12px; }
</style></head>
<body>
  <form method="POST" action="/entrar">
    <h1>KiwiFinder</h1>
    <p class="sub">Encontre o melhor momento para comprar.</p>
    ${erro ? `<div class="erro">${erro}</div>` : ''}
    <input type="password" name="senha" placeholder="Senha" autofocus autocomplete="current-password" required>
    <button type="submit">Entrar</button>
  </form>
</body></html>`
}
