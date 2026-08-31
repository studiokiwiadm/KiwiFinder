// Sobe o estado local para o Supabase. Roda uma vez, na mudança de casa para a
// nuvem.
//
//   node importar-para-supabase.mjs
//
// Precisa de SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente. Lê o
// dados/kiwifinder.json desta pasta e grava lá — sem apagar nada que já exista
// no banco além do documento de estado.

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configurado, testarConexao, importarParaOBanco } from './server/supabase.js'

const aqui = dirname(fileURLToPath(import.meta.url))

if (!configurado()) {
  console.error('Faltam SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente.')
  process.exit(1)
}

const conexao = await testarConexao()
if (!conexao.ok) {
  console.error('Não consegui falar com o Supabase:', conexao.motivo)
  process.exit(1)
}

const arquivo = join(aqui, 'dados', 'kiwifinder.json')
const dados = JSON.parse(await readFile(arquivo, 'utf8'))

console.log('Vou subir:')
console.log('  lojas .......... ' + (dados.lojas || []).length)
console.log('  consultas ...... ' + (dados.consultas || []).length)
console.log('  produtos ....... ' + (dados.produtos || []).length)
console.log('  ofertas ........ ' + (dados.ofertas || []).length)
console.log('  histórico ...... ' + (dados.historico || []).length + ' leituras de preço')
console.log('  oportunidades .. ' + (dados.oportunidades || []).length)

const r = await importarParaOBanco(dados)
console.log('\nPronto. ' + r.historico + ' pontos de histórico gravados.')
