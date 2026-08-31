// Suíte de regressão da inteligência de correspondência (nlp.js + match.js +
// extract.js). Sem framework: mini-runner próprio, node:assert/strict.
//
// Roda com: node testes/correspondencia.test.mjs
//
// Cada caso aqui corresponde a um bug real já corrigido no código de produção.
// Se algum caso falhar, NÃO altere server/*.js para fazê-lo passar — reporte a
// falha para revisão humana.

import assert from 'node:assert/strict'
import { interpretar } from '../server/nlp.js'
import {
  pontuar, mesmoProduto, mesmoProdutoNaBusca, chaveProduto,
  filtrarPorSanidadeDePreco, marcaConfiavel
} from '../server/match.js'
import { lerPreco } from '../server/extract.js'

// --------------------------------------------------------------- mini-runner

const casos = []
function caso (nome, fn) { casos.push({ nome, fn }) }

let passou = 0
let falhou = 0
const falhas = []

async function rodar () {
  console.log('Suíte de regressão — correspondência\n')
  for (const { nome, fn } of casos) {
    try {
      await fn()
      passou++
      console.log(`✓ ${nome}`)
    } catch (erro) {
      falhou++
      falhas.push({ nome, erro })
      console.log(`✗ ${nome}`)
      console.log(`  ${erro.message.split('\n').join('\n  ')}`)
    }
  }

  console.log('\n' + '-'.repeat(60))
  console.log(`Resumo: ${passou} passou, ${falhou} falhou, ${casos.length} total`)
  if (falhas.length) {
    console.log('\nCasos que falharam:')
    for (const { nome } of falhas) console.log(`  ✗ ${nome}`)
  }
  process.exit(falhou ? 1 : 0)
}

// ==================================================================
// INTERPRETAÇÃO
// ==================================================================

caso('1. "Apple" sozinha é rejeitada — marca sem escopo devolveria o catálogo inteiro', () => {
  const r = interpretar('Apple')
  assert.equal(r.aceita, false)
})

caso('2. "cafeteira oster maxima" extrai marca, categoria e a palavra-chave "maxima"', () => {
  const r = interpretar('cafeteira oster maxima')
  assert.equal(r.marca, 'oster')
  assert.equal(r.categoria, 'cafeteira')
  assert.ok(r.palavrasChave.includes('maxima'), `palavrasChave deveria incluir "maxima", veio ${JSON.stringify(r.palavrasChave)}`)
})

caso('3. "RTX 5070 Gigabyte 12GB" extrai marca gigabyte, modelo rtx5070 e spec 12gb', () => {
  const r = interpretar('RTX 5070 Gigabyte 12GB')
  assert.equal(r.marca, 'gigabyte')
  assert.ok(r.modelos.includes('rtx5070'), `modelos deveria incluir "rtx5070", veio ${JSON.stringify(r.modelos)}`)
  assert.ok(r.specs.includes('12gb'), `specs deveria incluir "12gb", veio ${JSON.stringify(r.specs)}`)
})

caso('4. "iPhone 17 Pro 256GB" resolve marca via linha de produto (apple) e extrai spec 256gb', () => {
  const r = interpretar('iPhone 17 Pro 256GB')
  assert.equal(r.marca, 'apple')
  assert.ok(r.specs.includes('256gb'), `specs deveria incluir "256gb", veio ${JSON.stringify(r.specs)}`)
})

caso('5. "monitor aoc 27" não gera o modelo falso "aoc27" (27 é medida, prefixo é a marca)', () => {
  const r = interpretar('monitor aoc 27')
  assert.ok(!r.modelos.includes('aoc27'), `modelos não deveria incluir "aoc27", veio ${JSON.stringify(r.modelos)}`)
})

caso('6. Voltagem normalizada: "110V" e "127 v" produzem a mesma spec', () => {
  const a = interpretar('Aparelho 110V')
  const b = interpretar('Aparelho 127 v')
  assert.deepEqual(a.specs, b.specs)
  assert.ok(a.specs.includes('127v'), `esperava spec normalizada "127v", veio ${JSON.stringify(a.specs)}`)
})

// ==================================================================
// PONTUAÇÃO (aceita/rejeita)
// ==================================================================

caso('7. "RTX 5070" não aceita "RTX 5070 Ti" — variante diferente', () => {
  const interp = interpretar('RTX 5070')
  const item = { nome: 'Placa de Vídeo RTX 5070 Ti 16GB' }
  const r = pontuar(interp, item)
  assert.equal(r.aceito, false)
})

caso('8. "RTX 5070 Ti 16GB" não aceita a 5070 base — o contrário também vale', () => {
  const interp = interpretar('RTX 5070 Ti 16GB')
  const item = { nome: 'Placa de Vídeo RTX 5070 16GB' }
  const r = pontuar(interp, item)
  assert.equal(r.aceito, false)
})

caso('9. "RTX 5070" aceita "...RTX 5070 12G VENTUS 2X OC" — 12G não é sufixo de variante', () => {
  const interp = interpretar('RTX 5070')
  const item = { nome: 'Placa de Vídeo MSI GeForce RTX 5070 12G VENTUS 2X OC' }
  const r = pontuar(interp, item)
  assert.equal(r.aceito, true, `motivos: ${JSON.stringify(r.motivos)}`)
})

caso('10. "cafeteira oster maxima" não aceita "Cafeteira Oster Digital Flavor" — falta a palavra exigida', () => {
  const interp = interpretar('cafeteira oster maxima')
  const item = { nome: 'Cafeteira Oster Digital Flavor' }
  const r = pontuar(interp, item)
  assert.equal(r.aceito, false)
})

caso('11. "cafeteira oster maxima" aceita "Cafeteira Oster Expresso Maximma" — uma letra de diferença é tolerada', () => {
  const interp = interpretar('cafeteira oster maxima')
  const item = { nome: 'Cafeteira Oster Expresso Maximma' }
  const r = pontuar(interp, item)
  assert.equal(r.aceito, true, `motivos: ${JSON.stringify(r.motivos)}`)
})

caso('12. "ninja creami" não aceita livro nem acessório (pote) da busca', () => {
  const interp = interpretar('ninja creami')
  const livro = pontuar(interp, { nome: 'Ninja Creami Cookbook for Beginners' })
  const potes = pontuar(interp, { nome: 'Potes Ninja Creami 2 Unidades' })
  assert.equal(livro.aceito, false, `livro: motivos ${JSON.stringify(livro.motivos)}`)
  assert.equal(potes.aceito, false, `potes: motivos ${JSON.stringify(potes.motivos)}`)
})

caso('13. Anúncio "usado"/"seminovo" é sempre rejeitado, mesmo que o resto combine', () => {
  const interp = interpretar('notebook dell inspiron')
  const usado = pontuar(interp, { nome: 'Notebook Dell Inspiron Usado, ótimo estado' })
  const seminovo = pontuar(interp, { nome: 'Notebook Dell Inspiron Seminovo' })
  assert.equal(usado.aceito, false)
  assert.equal(usado.eliminado, true)
  assert.equal(seminovo.aceito, false)
  assert.equal(seminovo.eliminado, true)
})

caso('14. Conflito de spec: pedir 16GB e o anúncio ser 12GB rejeita', () => {
  const interp = interpretar('notebook 16gb')
  const item = { nome: 'Notebook Acer Aspire 12GB RAM SSD 256GB' }
  const r = pontuar(interp, item)
  assert.equal(r.aceito, false)
  assert.equal(r.eliminado, true)
})

// ==================================================================
// IDENTIDADE / FUSÃO
// ==================================================================

caso('15. Mesmo produto em lojas diferentes, títulos diferentes, é reconhecido na busca específica', () => {
  const interp = interpretar('ninja creami')
  const a = { nome: 'Ninja Máquina de Sorvete Creami 110V', preco: 2199 }
  const b = { nome: 'Ninja, Sorveteira, Creami, 7 Programas Auto-iQ, 127 v', preco: 2299 }
  const r = mesmoProdutoNaBusca(a, b, interp)
  assert.equal(r.igual, true, `base: ${r.base}`)
})

caso('16. 110V × 220V do mesmo aparelho não são o mesmo produto', () => {
  const a = { nome: 'Ninja Máquina de Sorvete Creami 110V', preco: 2199 }
  const b = { nome: 'Ninja Máquina de Sorvete Creami 220V', preco: 2199 }
  const r = mesmoProduto(a, b)
  assert.equal(r.igual, false, `base: ${r.base}`)
})

caso('17. Gigabyte RTX 5070 EAGLE × AERO não são o mesmo — linha diferente', () => {
  const a = { nome: 'Placa de Vídeo Gigabyte RTX 5070 EAGLE 12G', preco: 4500 }
  const b = { nome: 'Placa de Vídeo Gigabyte RTX 5070 AERO 12G', preco: 4600 }
  const r = mesmoProduto(a, b)
  assert.equal(r.igual, false, `base: ${r.base}`)
})

caso('18. Gigabyte RTX 5070 WINDFORCE em duas lojas, títulos diferentes, é o mesmo', () => {
  const a = { nome: 'Placa de Vídeo Gigabyte RTX 5070 WINDFORCE OC 12G', preco: 4500 }
  const b = { nome: 'Gigabyte GeForce RTX 5070 WINDFORCE OC 12GB GDDR7', preco: 4600 }
  const r = mesmoProduto(a, b)
  assert.equal(r.igual, true, `base: ${r.base}`)
})

caso('19. Notebook mesma linha e RAM, processadores diferentes (Ryzen 5 × Celeron), não são o mesmo', () => {
  const a = { nome: 'Notebook Acer Aspire Ryzen 5 8GB SSD 256GB', preco: 2500 }
  const b = { nome: 'Notebook Acer Aspire Celeron 8GB SSD 256GB', preco: 2200 }
  const r = mesmoProduto(a, b)
  assert.equal(r.igual, false, `base: ${r.base}`)
})

caso('20. Busca ampla ("cafeteira expresso"): cafeteiras de marcas diferentes não são fundidas', () => {
  const interp = interpretar('cafeteira expresso')
  const a = { nome: 'Cafeteira Expresso Oster Prima Latte', preco: 800 }
  const b = { nome: 'Cafeteira Expresso Philips Walita Daily', preco: 750 }
  const r = mesmoProdutoNaBusca(a, b, interp)
  assert.equal(r.igual, false, `base: ${r.base}`)
})

caso('21. marcaConfiavel ignora razão social e "Não Informado", preferindo a marca do título', () => {
  const comRazaoSocial = marcaConfiavel({
    nome: 'Placa de Vídeo Gigabyte RTX 5070 Eagle 12G',
    marca: 'FLER EQUIPAMENTOS E INTERMEDIACAO DE NEGOCIOS LTDA'
  })
  assert.equal(comRazaoSocial, 'gigabyte')

  const semMarcaConhecida = marcaConfiavel({
    nome: 'Cafeteira sem marca reconhecida no título',
    marca: 'Não Informado'
  })
  assert.equal(semMarcaConhecida, '')
})

// ==================================================================
// PREÇO
// ==================================================================

caso('22. lerPreco interpreta formato brasileiro (milhar com ponto, centavos com vírgula)', () => {
  assert.equal(lerPreco('R$ 4.599,00'), 4599)
  assert.equal(lerPreco('1.234'), 1234)
  assert.equal(lerPreco('89,90'), 89.9)
})

caso('23. filtrarPorSanidadeDePreco descarta item de R$ 204 no meio de itens de ~R$ 2.000', () => {
  const interp = interpretar('cafeteira oster maxima')
  assert.ok(interp.especificidade >= 55, `pré-condição: especificidade deveria ser >= 55, veio ${interp.especificidade}`)
  const aceitos = [
    { item: { preco: 204 } },
    { item: { preco: 1950 } },
    { item: { preco: 2000 } },
    { item: { preco: 2050 } }
  ]
  const { mantidos, descartados } = filtrarPorSanidadeDePreco(aceitos, interp)
  assert.equal(descartados.length, 1, `esperava 1 descartado, veio ${descartados.length}`)
  assert.equal(descartados[0].item.preco, 204)
  assert.equal(mantidos.length, 3)
})

caso('24. o nome da loja nunca vira marca do produto', () => {
  // Bug real: a KaBuM! preenche o campo de marca com "KaBuM" em parte do
  // catálogo. O mesmo MacBook Pro virava `marca:kabum` de um lado e
  // `marca:apple` do outro, os dois nunca se fundiam, e a MESMA oferta da Go
  // Imports aparecia nos dois cartões como se fossem lojas concorrentes.
  const kabum = { nome: 'KaBuM!', host: 'kabum.com.br', origem: 'https://www.kabum.com.br' }
  assert.equal(marcaConfiavel({ nome: 'Notebook 15 polegadas', marca: 'KaBuM' }, kabum), '')
  assert.equal(marcaConfiavel({ nome: 'Notebook 15 polegadas', marca: 'kabum!' }, kabum), '')
  // Marca de verdade continua passando.
  assert.equal(marcaConfiavel({ nome: 'Notebook 15 polegadas', marca: 'Dell' }, kabum), 'Dell')
  // Também vale para o domínio, quando o nome cadastrado difere.
  const go = { nome: 'Goimports', host: 'goimports.com.br', origem: 'https://www.goimports.com.br' }
  assert.equal(marcaConfiavel({ nome: 'MacBook Pro 14', marca: 'GoImports' }, go), '')
})

// ------------------------------------------------------------------- rodar

rodar()
