// Link de afiliado — a URL final que a pessoa clica.
//
// Errar aqui tem dois custos: link quebrado (a pessoa não chega na loja, que é
// a única coisa que o app promete) ou comissão perdida (o app não se sustenta).
// O primeiro é muito pior que o segundo, e os testes refletem isso: na dúvida,
// devolver a URL original.
//
// Roda com: node testes/afiliado.test.mjs

import assert from 'node:assert/strict'
import { aplicarAfiliado, temAfiliado, precisaDivulgar, PROGRAMAS_CONHECIDOS } from '../server/afiliado.js'

const casos = []
function caso (nome, fn) { casos.push({ nome, fn }) }

const ANUNCIO = 'https://www.amazon.com.br/dp/B0DLH97K8J?ref=sr_1_5'

caso('1. sem afiliado configurado, a URL sai intacta', () => {
  assert.equal(aplicarAfiliado(ANUNCIO, null), ANUNCIO)
  assert.equal(aplicarAfiliado(ANUNCIO, {}), ANUNCIO)
  assert.equal(aplicarAfiliado(ANUNCIO, { tipo: 'parametro' }), ANUNCIO)
})

caso('2. parâmetro: acrescenta a tag preservando o resto da URL', () => {
  const url = aplicarAfiliado(ANUNCIO, { tipo: 'parametro', chave: 'tag', valor: 'kiwi-20' })
  const alvo = new URL(url)
  assert.equal(alvo.searchParams.get('tag'), 'kiwi-20')
  assert.equal(alvo.searchParams.get('ref'), 'sr_1_5', 'o parâmetro que já existia não pode sumir')
  assert.equal(alvo.pathname, '/dp/B0DLH97K8J')
})

caso('3. parâmetro: tag existente é substituída, não duplicada', () => {
  // Link copiado de outro lugar já pode vir com tag de terceiro.
  const comTagAlheia = 'https://www.amazon.com.br/dp/X?tag=outro-21'
  const url = aplicarAfiliado(comTagAlheia, { tipo: 'parametro', chave: 'tag', valor: 'kiwi-20' })
  assert.equal(new URL(url).searchParams.getAll('tag').length, 1)
  assert.equal(new URL(url).searchParams.get('tag'), 'kiwi-20')
})

caso('4. caminho: a URL da loja vai codificada dentro do redirecionador', () => {
  const url = aplicarAfiliado(ANUNCIO, {
    tipo: 'caminho',
    modelo: 'https://www.awin1.com/cread.php?awinmid={codigo}&ued={url}',
    valor: '12345'
  })
  assert.ok(url.startsWith('https://www.awin1.com/cread.php?'))
  assert.ok(url.includes('awinmid=12345'))
  assert.ok(url.includes(encodeURIComponent(ANUNCIO)), 'a URL da loja tem que ir codificada')
})

caso('5. sufixo: respeita se a URL já tem query', () => {
  assert.ok(aplicarAfiliado('https://loja.com/p/1', { tipo: 'sufixo', valor: 'utm=kiwi' }).includes('/p/1?utm=kiwi'))
  assert.ok(aplicarAfiliado('https://loja.com/p/1?a=2', { tipo: 'sufixo', valor: 'utm=kiwi' }).includes('?a=2&utm=kiwi'))
  // Aceita o valor com ou sem o & na frente.
  assert.ok(!aplicarAfiliado('https://loja.com/p/1', { tipo: 'sufixo', valor: '&utm=kiwi' }).includes('?&'))
})

caso('6. URL malformada devolve o original em vez de explodir', () => {
  const ruim = 'nao-e-url'
  assert.equal(aplicarAfiliado(ruim, { tipo: 'parametro', chave: 'tag', valor: 'kiwi-20' }), ruim)
})

caso('7. temAfiliado só aceita configuração utilizável', () => {
  assert.equal(temAfiliado(null), false)
  assert.equal(temAfiliado({ tipo: 'parametro', chave: 'tag' }), false, 'sem código não vale')
  assert.equal(temAfiliado({ tipo: 'parametro', chave: 'tag', valor: 'kiwi-20' }), true)
  assert.equal(temAfiliado({ tipo: 'caminho' }), false)
  assert.equal(temAfiliado({ tipo: 'caminho', modelo: 'https://r/?u={url}' }), true)
})

caso('8. a divulgação aparece quando existe link de afiliado no ar', () => {
  assert.equal(precisaDivulgar([{ nome: 'A' }, { nome: 'B' }]), false)
  assert.equal(precisaDivulgar([{ nome: 'A', afiliado: { tipo: 'parametro', chave: 'tag', valor: 'k' } }]), true)
})

caso('9. os programas conhecidos vêm sem código preenchido', () => {
  // O código é dele e só ele tem. Vir preenchido seria um bug perigoso.
  for (const p of PROGRAMAS_CONHECIDOS) {
    assert.ok(p.nome && p.cadastro, `${p.id} precisa de nome e link de cadastro`)
    assert.equal(p.afiliado.valor, '', `${p.id} não pode vir com código preenchido`)
    assert.equal(temAfiliado(p.afiliado), p.afiliado.tipo === 'caminho', `${p.id}: só o tipo caminho vale sem código`)
  }
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
