// Regras de robots.txt — a parte que decide, sem rede.
//
// Novo na v2: o robots deixou de ser aviso no diagnóstico e passou a valer nas
// rodadas. Errar aqui tem dois custos opostos e ambos ruins: liberar o que a
// loja proibiu, ou bloquear o app inteiro por ler uma regra torto.
//
// Roda com: node testes/robots.test.mjs

import assert from 'node:assert/strict'
import { robotsDecide } from '../server/net.js'

const casos = []
function caso (nome, fn) { casos.push({ nome, fn }) }

caso('1. sem nenhuma regra, passa — silêncio do robots é permissão', () => {
  assert.equal(robotsDecide('/busca?q=cafeteira', [], []).permitido, true)
})

caso('2. Disallow que casa por prefixo bloqueia', () => {
  assert.equal(robotsDecide('/busca?q=cafeteira', ['/busca'], []).permitido, false)
})

caso('3. Disallow de outro caminho não atrapalha', () => {
  assert.equal(robotsDecide('/busca?q=x', ['/admin', '/checkout'], []).permitido, true)
})

caso('4. Allow mais específico ganha do Disallow geral', () => {
  // O caso comum de loja: "Disallow: /" com exceções.
  assert.equal(robotsDecide('/produto/cafeteira-oster', ['/'], ['/produto/']).permitido, true)
  assert.equal(robotsDecide('/carrinho', ['/'], ['/produto/']).permitido, false)
})

caso('5. Disallow mais específico ganha do Allow geral', () => {
  assert.equal(robotsDecide('/produto/interno/x', ['/produto/interno'], ['/produto']).permitido, false)
})

caso('6. coringa * no meio da regra', () => {
  assert.equal(robotsDecide('/loja/123/interno', ['/loja/*/interno'], []).permitido, false)
  assert.equal(robotsDecide('/loja/123/publico', ['/loja/*/interno'], []).permitido, true)
})

caso('7. âncora $ casa só no fim', () => {
  assert.equal(robotsDecide('/manual.pdf', ['/*.pdf$'], []).permitido, false)
  assert.equal(robotsDecide('/manual.pdf?v=2', ['/*.pdf$'], []).permitido, true)
})

caso('8. regra com caractere especial não derruba a leitura', () => {
  // Uma regra malformada não pode fazer o app parar de buscar tudo.
  assert.equal(robotsDecide('/busca', ['/[('], []).permitido, true)
})

caso('9. empate entre Allow e Disallow do mesmo tamanho libera', () => {
  // Regra do formato: só bloqueia quando o Disallow é ESTRITAMENTE mais
  // específico. Empate fica com quem permite.
  assert.equal(robotsDecide('/x', ['/x'], ['/x']).permitido, true)
})

let passou = 0
let falhou = 0
for (const { nome, fn } of casos) {
  try { fn(); passou++; console.log(`  ok   ${nome}`) } catch (erro) {
    falhou++
    console.log(`  FALHA ${nome}\n         ${erro.message}`)
  }
}
console.log('-'.repeat(60))
console.log(`Resumo: ${passou} passou, ${falhou} falhou, ${casos.length} total`)
if (falhou) process.exitCode = 1
