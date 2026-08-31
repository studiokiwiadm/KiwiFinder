// Biblioteca de lojas brasileiras conhecidas, so para agilizar o cadastro do
// usuario (evitar digitar host/URL na mao para lojas comuns). Nada aqui e
// garantia de nada: a lista pode ter dados desatualizados ou errados, e quem
// decide de fato se uma loja entra no KiwiFinder e o teste de compatibilidade
// do proprio sistema (server/diagnose.js), nao esta lista.

export const LOJAS_CONHECIDAS = [
  // --- Informática / hardware ---
  {
    nome: 'KaBuM!',
    host: 'www.kabum.com.br',
    origem: 'https://www.kabum.com.br',
    buscaUrl: 'https://www.kabum.com.br/busca/{q}',
    categoria: 'informática',
    observacao: 'Loja de hardware; costuma expor dados estruturados e funcionar bem em automação.',
  },
  {
    nome: 'Pichau',
    host: 'www.pichau.com.br',
    origem: 'https://www.pichau.com.br',
    buscaUrl: null,
    categoria: 'informática',
    observacao: 'Padrão de busca a descobrir no teste; loja de hardware, tende a ser amigável com automação.',
  },
  {
    nome: 'Terabyte Shop',
    host: 'www.terabyteshop.com.br',
    origem: 'https://www.terabyteshop.com.br',
    buscaUrl: null,
    categoria: 'informática',
    observacao: 'Padrão de busca a descobrir no teste; loja de hardware, tende a ser amigável com automação.',
  },
  {
    nome: 'Kalunga',
    host: 'www.kalunga.com.br',
    origem: 'https://www.kalunga.com.br',
    buscaUrl: null,
    categoria: 'informática',
    observacao: 'Padrão de busca a descobrir no teste; mistura papelaria e informática, resultado pode vir misto.',
  },
  {
    nome: 'Girafa',
    host: 'www.girafa.com.br',
    origem: 'https://www.girafa.com.br',
    buscaUrl: null,
    categoria: 'informática',
    observacao: 'Padrão de busca a descobrir no teste; loja de hardware/games menor, comportamento incerto.',
  },

  // --- Varejo geral ---
  {
    nome: 'Amazon.com.br',
    host: 'www.amazon.com.br',
    origem: 'https://www.amazon.com.br',
    buscaUrl: 'https://www.amazon.com.br/s?k={q}',
    categoria: 'varejo geral',
    observacao: 'Marketplace grande; costuma bloquear acesso automatizado, provável veredito incompatível.',
  },
  {
    nome: 'Magazine Luiza',
    host: 'www.magazineluiza.com.br',
    origem: 'https://www.magazineluiza.com.br',
    buscaUrl: 'https://www.magazineluiza.com.br/busca/{q}/',
    categoria: 'varejo geral',
    observacao: 'Marketplace grande; costuma bloquear acesso automatizado, provável veredito incompatível.',
  },
  {
    nome: 'Americanas',
    host: 'www.americanas.com.br',
    origem: 'https://www.americanas.com.br',
    buscaUrl: null,
    categoria: 'varejo geral',
    observacao: 'Padrão de busca a descobrir no teste; marketplace grande, provável veredito incompatível.',
  },
  {
    nome: 'Casas Bahia',
    host: 'www.casasbahia.com.br',
    origem: 'https://www.casasbahia.com.br',
    buscaUrl: null,
    categoria: 'varejo geral',
    observacao: 'Padrão de busca a descobrir no teste; rede grande, chance de bloqueio a automação.',
  },
  {
    nome: 'Ponto',
    host: 'www.pontofrio.com.br',
    origem: 'https://www.pontofrio.com.br',
    buscaUrl: null,
    categoria: 'varejo geral',
    observacao: 'Padrão de busca a descobrir no teste; mesmo grupo da Casas Bahia, chance de bloqueio a automação.',
  },
  {
    nome: 'Submarino',
    host: 'www.submarino.com.br',
    origem: 'https://www.submarino.com.br',
    buscaUrl: null,
    categoria: 'varejo geral',
    observacao: 'Padrão de busca a descobrir no teste; marketplace grande, provável veredito incompatível.',
  },
  {
    nome: 'Fast Shop',
    host: 'www.fastshop.com.br',
    origem: 'https://www.fastshop.com.br',
    buscaUrl: null,
    categoria: 'eletrônicos',
    observacao: 'Padrão de busca a descobrir no teste; foco em eletrônicos/eletrodomésticos, comportamento incerto.',
  },
  {
    nome: 'Carrefour',
    host: 'www.carrefour.com.br',
    origem: 'https://www.carrefour.com.br',
    buscaUrl: null,
    categoria: 'varejo geral',
    observacao: 'Padrão de busca a descobrir no teste; rede grande de mercado/varejo, chance de bloqueio a automação.',
  },
  {
    nome: 'Mercado Livre',
    host: 'lista.mercadolivre.com.br',
    origem: 'https://www.mercadolivre.com.br',
    buscaUrl: 'https://lista.mercadolivre.com.br/{q}',
    categoria: 'varejo geral',
    observacao: 'Maior marketplace do país; costuma bloquear acesso automatizado, provável veredito incompatível.',
  },
  {
    nome: 'Extra',
    host: 'www.extra.com.br',
    origem: 'https://www.extra.com.br',
    buscaUrl: null,
    categoria: 'varejo geral',
    observacao: 'Página inicial abre normal, mas nenhum dos caminhos de busca testados (nem o formulário da home) devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },
  {
    nome: 'Shoptime',
    host: 'www.shoptime.com.br',
    origem: 'https://www.shoptime.com.br',
    buscaUrl: null,
    categoria: 'varejo geral',
    observacao: 'Página inicial abre normal, mas nenhum caminho de busca testado devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },
  {
    nome: 'Havan',
    host: 'www.havan.com.br',
    origem: 'https://www.havan.com.br',
    buscaUrl: 'https://www.havan.com.br/catalogsearch/result/?q={q}',
    categoria: 'varejo geral',
    observacao: 'Busca funciona sem navegador: 21 itens com preço lidos por heurística de layout (95% de relevância no teste com "ventilador"). Sem dados estruturados — leitura pode quebrar se o layout mudar. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'parcial',
  },

  // --- Esporte / vestuário ---
  {
    nome: 'Nike',
    host: 'www.nike.com.br',
    origem: 'https://www.nike.com.br',
    buscaUrl: null,
    categoria: 'esporte/vestuário',
    observacao: 'Padrão de busca a descobrir no teste; loja oficial de marca, comportamento incerto.',
  },
  {
    nome: 'Adidas',
    host: 'www.adidas.com.br',
    origem: 'https://www.adidas.com.br',
    buscaUrl: null,
    categoria: 'esporte/vestuário',
    observacao: 'Padrão de busca a descobrir no teste; loja oficial de marca, comportamento incerto.',
  },
  {
    nome: 'Centauro',
    host: 'www.centauro.com.br',
    origem: 'https://www.centauro.com.br',
    buscaUrl: null,
    categoria: 'esporte/vestuário',
    observacao: 'Padrão de busca a descobrir no teste; rede grande de esporte, chance de bloqueio a automação.',
  },
  {
    nome: 'Netshoes',
    host: 'www.netshoes.com.br',
    origem: 'https://www.netshoes.com.br',
    buscaUrl: null,
    categoria: 'esporte/vestuário',
    observacao: 'Padrão de busca a descobrir no teste; rede grande de esporte, chance de bloqueio a automação.',
  },
  {
    nome: 'Decathlon',
    host: 'www.decathlon.com.br',
    origem: 'https://www.decathlon.com.br',
    buscaUrl: 'https://www.decathlon.com.br/busca/{q}',
    categoria: 'esporte/vestuário',
    observacao: 'Atenção: o domínio sem "www" (decathlon.com.br) não resolve — use sempre www.decathlon.com.br. Busca funciona sem navegador, mas a leitura é fraca: só 1 produto com preço veio de forma confiável nos testes com "tenis" e "bicicleta" (heurística de layout, sem dados estruturados). Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'parcial',
  },

  // --- Vestuário / moda ---
  {
    nome: 'Lojas Renner',
    host: 'www.lojasrenner.com.br',
    origem: 'https://www.lojasrenner.com.br',
    buscaUrl: null,
    categoria: 'vestuário',
    observacao: 'Página inicial abre normal, mas nenhum caminho de busca testado devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },
  {
    nome: 'Riachuelo',
    host: 'www.riachuelo.com.br',
    origem: 'https://www.riachuelo.com.br',
    buscaUrl: null,
    categoria: 'vestuário',
    observacao: 'Página inicial abre normal, mas nenhum caminho de busca testado devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },
  {
    nome: 'Dafiti',
    host: 'www.dafiti.com.br',
    origem: 'https://www.dafiti.com.br',
    buscaUrl: 'https://dafiti.com.br/catalog/?q={q}&wtqs=1',
    categoria: 'vestuário',
    observacao: 'Busca funciona sem navegador: 12 itens com preço lidos por heurística de layout (100% de relevância no teste com "tenis"). Sem dados estruturados — leitura pode quebrar se o layout mudar. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'parcial',
  },

  // --- Casa / cozinha ---
  {
    nome: 'Camicado',
    host: 'www.camicado.com.br',
    origem: 'https://www.camicado.com.br',
    buscaUrl: null,
    categoria: 'casa/cozinha',
    observacao: 'Padrão de busca a descobrir no teste; loja de casa e decoração, comportamento incerto.',
  },
  {
    nome: 'Etna',
    host: 'www.etna.com.br',
    origem: 'https://www.etna.com.br',
    buscaUrl: null,
    categoria: 'casa/cozinha',
    observacao: 'Padrão de busca a descobrir no teste; loja de casa e decoração, comportamento incerto.',
  },
  {
    nome: 'Madeira Madeira',
    host: 'www.madeiramadeira.com.br',
    origem: 'https://www.madeiramadeira.com.br',
    buscaUrl: 'https://madeiramadeira.com.br/busca/{q}',
    categoria: 'casa/móveis',
    observacao: 'Busca funciona sem navegador: 60 itens com preço lidos por heurística de layout (97% de relevância no teste com "sofa"). Sem dados estruturados — leitura pode quebrar se o layout mudar. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'parcial',
  },
  {
    nome: 'Mobly',
    host: 'www.mobly.com.br',
    origem: 'https://www.mobly.com.br',
    buscaUrl: 'https://mobly.com.br/catalogsearch/result/?q={q}',
    categoria: 'casa/móveis',
    observacao: 'Busca funciona sem navegador: 48 itens com preço lidos por heurística de layout (100% de relevância no teste com "sofa"). Sem dados estruturados — leitura pode quebrar se o layout mudar. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'parcial',
  },
  {
    nome: 'Leroy Merlin',
    host: 'www.leroymerlin.com.br',
    origem: 'https://www.leroymerlin.com.br',
    buscaUrl: null,
    categoria: 'casa/construção',
    observacao: 'Bloqueia a página de busca — todos os caminhos testados voltaram com bloqueio, inclusive tentando com navegador real. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },

  // --- Supermercado ---
  {
    nome: 'Gimba',
    host: 'www.gimba.com.br',
    origem: 'https://www.gimba.com.br',
    buscaUrl: null,
    categoria: 'supermercado',
    observacao: 'Página inicial abre normal, mas nenhum caminho de busca testado devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },

  // --- Farmácia ---
  {
    nome: 'Drogasil',
    host: 'www.drogasil.com.br',
    origem: 'https://www.drogasil.com.br',
    buscaUrl: null,
    categoria: 'farmácia',
    observacao: 'Página inicial abre normal, mas nenhum caminho de busca testado devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },
  {
    nome: 'Panvel',
    host: 'www.panvel.com',
    origem: 'https://www.panvel.com',
    buscaUrl: null,
    categoria: 'farmácia',
    observacao: 'Página inicial abre normal, mas nenhum caminho de busca testado devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },

  // --- Beleza ---
  {
    nome: 'Época Cosméticos',
    host: 'www.epocacosmeticos.com.br',
    origem: 'https://www.epocacosmeticos.com.br',
    buscaUrl: null,
    categoria: 'beleza',
    observacao: 'Página inicial abre normal, mas nenhum caminho de busca testado devolveu uma listagem de produtos legível — provável busca montada via JavaScript. Testado em 13/08/2026.',
    testadaEm: '2026-08-13',
    resultadoTeste: 'incompativel',
  },
]

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos (marcas diacríticas combinadas)
    .toLowerCase()
}

export function buscarNaBiblioteca(termo) {
  const alvo = normalizar(termo || '')
  if (!alvo) return LOJAS_CONHECIDAS
  return LOJAS_CONHECIDAS.filter(
    (loja) => normalizar(loja.nome).includes(alvo) || normalizar(loja.host).includes(alvo)
  )
}
