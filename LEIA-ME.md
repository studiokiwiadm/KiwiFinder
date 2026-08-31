---
tipo: projetos
atualizado: 2026-08-14
---

# KiwiFinder — protótipo v2

> Deal Finder — Encontre o melhor momento para comprar.

Protótipo funcional do [[../KiwiFinder|KiwiFinder]]. Você cadastra suas lojas de
confiança e o que quer comprar; ele pesquisa sozinho, casa os anúncios entre as
lojas, guarda o histórico de preço e avisa quando aparece oportunidade.



## Colocar online

São três serviços e cerca de vinte minutos. A ordem importa: cada passo produz
uma informação que o passo seguinte pede.

Antes de começar: **nada disso muda o app aqui em casa**. Sem as variáveis de
ambiente, ele continua gravando em `dados/kiwifinder.json` e abrindo sem senha,
como sempre.

### Passo 1 — Supabase (o banco)

Crie um projeto novo. Ele pede uma senha para o banco: guarde num lugar
qualquer, você não vai usar.

Quando o projeto terminar de subir, abra o **SQL Editor** no menu da esquerda,
clique em **New query**, e cole ali o conteúdo do arquivo `esquema.sql` que está
nesta pasta. Clique em **Run**. Isso cria as duas tabelas onde os dados vão
morar. Não tem retorno visível além de "Success" — está certo assim.

Agora vá em **Project Settings → API**. Você precisa de dois valores dessa tela:

O **Project URL**, lá em cima, parecido com `https://abcdefgh.supabase.co`.

E, mais abaixo, em *Project API keys*, a chave **`service_role`**. Ela vem
escondida atrás de um "Reveal". **Não é a `anon`** — a `anon` é pública e não
serve aqui.

**Essa chave é o banco inteiro na mão de quem a tiver.** Não me mande por
mensagem, não cole em lugar nenhum além dos dois destinos abaixo. Crie um
arquivo chamado `.env` nesta pasta e escreva assim:

```
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_SERVICE_KEY=a-service-role-que-você-revelou
```

O `.env` está no `.gitignore`, então ele nunca vai para o GitHub. Me avise
quando salvar: eu rodo a importação e subo o seu histórico de preço, que é a
única coisa aqui que não dá para refazer.

### Passo 2 — Render (o servidor)

Em **New +**, escolha **Blueprint** (não "Web Service"). Aponte para o
repositório `KiwiFinder`. O Render acha o `render.yaml` sozinho e já sabe como
construir e iniciar — você não precisa preencher build command nem start
command.

Ele vai perguntar três valores. **`KIWI_SENHA`** é a senha da tela: invente uma,
é ela que impede qualquer um com o endereço de mexer nos seus produtos.
**`SUPABASE_URL`** e **`SUPABASE_SERVICE_KEY`** são os dois do passo 1.

Os outros dois (`SESSION_SECRET` e `CRON_TOKEN`) o Render sorteia sozinho.

Quando o deploy terminar, faça duas coisas nessa tela: **copie o endereço** que
ele te deu (algo como `https://kiwifinder.onrender.com`) e vá na aba
**Environment** para **copiar o valor do `CRON_TOKEN`**. Os dois são o passo 3.

### Passo 3 — GitHub (o despertador)

O Render suspende o serviço depois de 15 minutos parado, e o agendador de dentro
do app dorme junto. Quem acorda ele de hora em hora é o GitHub.

No repositório, vá em **Settings → Secrets and variables → Actions** e clique em
**New repository secret** duas vezes:

`KIWI_URL`, com o endereço do Render.

`CRON_TOKEN`, com o valor que você copiou do Environment.

Pronto. Para não esperar a hora cheia, vá na aba **Actions**, clique em
**Rodada de preços** e depois em **Run workflow**. Em uns três minutos ele volta
com quantos itens leu.

### O que muda ao sair desta máquina

**A Go Imports para de funcionar.** A busca dela só existe em JavaScript, e no
plano free do Render não há Chrome instalado. As outras cinco lojas leem por
requisição comum e continuam iguais. O que você já coletou lá fica no histórico;
só para de atualizar. A saída definitiva é o feed de afiliado, que é para onde a
v2 já aponta.

**O primeiro acesso do dia demora cerca de um minuto.** O serviço estava
dormindo. É o preço de não queimar a cota — e a cota é o motivo de tudo isso
existir: o Render dá 750 horas de instância por mês para a conta inteira, e um
serviço ligado dia e noite come 730. Acordando só para rodar, o KiwiFinder gasta
umas 36 e sobra espaço para os seus outros projetos.

**Preço passa a vir do IP do servidor**, que está em Oregon. Para preço de
produto costuma dar no mesmo; para frete, não.

**O Supabase pausa projeto free depois de uma semana parado.** As rodadas de
hora em hora resolvem isso sozinhas — mas se você desligar o despertador, é bom
saber.

## Da v1 para a v2 — o que mudou e por quê

A v1 está congelada no git na tag `kiwifinder-v1`. Para voltar a ela:
`git checkout kiwifinder-v1`.

A v2 não mudou o que o app faz. Mudou **a postura dele com as lojas**, depois de
uma conversa sobre risco jurídico. A pergunta que reorganizou tudo foi: como
Buscapé, Zoom e Google Shopping fazem sem brigar com ninguém? A resposta é que
eles **não raspam, recebem** — a loja quer aparecer no comparador, porque
comparador é canal de venda, e por isso publica um feed de produtos e paga
comissão. Quem entra por essa porta não passa pelo problema; está do lado certo
dele.

### 1. Recusa virou resposta, não obstáculo

A v1 tratava bloqueio como problema técnico: levou 403, abria um navegador real
e pegava a página assim mesmo. A v2 aceita o não.

Quando a loja recusa, ela fica marcada como **"precisa de acesso autorizado"** e
aparece assim na aba Lojas, com o caminho legítimo explicado: programa de
afiliado com feed, ou API oficial.

O navegador real **continua existindo** — para loja que ATENDE e só monta a
página em JavaScript. Isso é usar o site como qualquer visitante usa. A
diferença entre os dois casos é medida, não presumida (ver `classificarRecusa`
em `server/navegador.js`): resposta de 403/captcha é recusa; resposta de 200 com
menos de 8 KB é recusa disfarçada (servir casca para quem não é navegador); 200
com a página inteira é só JavaScript faltando.

Medido nas 6 lojas cadastradas em 14/08/2026:

| loja | resposta a requisição comum | v2 |
|---|---|---|
| KaBuM! | 573 KB | lê normal |
| Carrefour | página completa | lê normal |
| Kalunga | página completa | lê normal |
| Amazon | 1,2 MB | atende — segue com navegador para o JavaScript |
| Go Imports | 246 KB | atende — busca digitada, como um visitante |
| Terabyte | **403** | **precisa de acesso autorizado** |

Ou seja: o custo de ser honesto foi **uma loja**. Que volta pela porta certa, com
feed de afiliado.

Saiu junto o disfarce de automação (`--disable-blink-features=
AutomationControlled` e o script que apagava `navigator.webdriver`). Existia
para não parecer robô — o que só faz sentido para quem quer passar por um
bloqueio.

### 2. O robots.txt passou a valer

Na v1 ele era lido só no diagnóstico, para avisar — e o aviso não impedia nada,
que é o pior dos dois mundos: o app sabia e ia assim mesmo. Agora nenhuma URL é
buscada sem passar por ele.

A leitura implementa o desempate do formato (entre Allow e Disallow que casam,
ganha o mais específico), os coringas `*` e `$`, e trata silêncio como
permissão. Nove casos de regressão em `testes/robots.test.mjs`.

### 3. Ficha técnica deixou de ser guardada

O app copiava a tabela de especificações da página do produto e guardava no
arquivo, sem usar em lugar nenhum da tela. Era conteúdo da loja parado no disco
sem servir para nada. As 45 fichas que existiam foram apagadas.

### 4. Link de afiliado (`server/afiliado.js`)

A ponta visível do modelo que sustenta o app sem ficar do lado errado. Três
formatos cobrem o mercado brasileiro:

| formato | como entra na URL | quem usa |
|---|---|---|
| `parametro` | `?tag=seu-codigo` | Amazon Associates, Mercado Livre |
| `caminho` | redirecionador da rede | Awin, Rakuten, Lomadee, Afilio |
| `sufixo` | `&utm_source=…` | programas próprios simples |

Nada aqui sabe o nome de nenhuma loja: cada loja declara como o código dela
entra. Sem configuração, a URL sai intacta — link quebrado é pior que link sem
comissão.

A **divulgação é obrigatória** e aparece sozinha no rodapé quando existe algum
link de afiliado no ar. Não é só exigência dos programas: é o mínimo de
honestidade com quem clica.

`GET /api/afiliados/programas` lista os seis programas conhecidos com o formato
de link já montado e o endereço de cadastro. Entrar em cada um é um cadastro
manual, com aprovação do anunciante — o app não faz isso por você.

### O que falta na v2

- **Ler feed de produtos** (XML/CSV) como fonte, no lugar da leitura de vitrine.
  É a metade que realmente muda o jogo: dado estruturado, com EAN, que não
  quebra quando a loja mexe no site. Metade dos defeitos corrigidos nesta semana
  simplesmente não existe com feed.
- **API oficial da Amazon** (Product Advertising API), que vem junto do
  Associates.
- Cadastro de afiliado pela interface (hoje é editar o JSON à mão).

## Como abrir

Duplo clique em **`Abrir KiwiFinder.bat`**. Ele sobe o servidor e abre o
navegador em `http://localhost:4173/`.

Fechar a janela minimizada "servidor kiwifinder" encerra o app. Enquanto ela
estiver aberta, as rodadas automáticas acontecem nos horários configurados.

**Praticamente não precisa instalar nada.** O núcleo não tem dependência
nenhuma. A única exceção é o `playwright-core`, que serve só para dirigir o
Chrome que já existe na sua máquina quando a loja monta a página em JavaScript
— e ele já está instalado aqui. Se um dia sumir, `npm install` na pasta
resolve, e sem ele tudo continua funcionando pelo caminho normal.

### O navegador de verdade (o que destrava loja bloqueada)

Algumas lojas não olham só o cabeçalho da requisição: olham a impressão digital
do TLS. O Node não "parece" um Chrome e leva 403 antes de qualquer outra coisa.

Quando isso acontece, o KiwiFinder abre o **Chrome que já está instalado no seu
computador**, com um perfil separado em `dados/perfil-navegador`, e lê a página
por lá. Ele não encosta no seu Chrome do dia a dia: não lê seus cookies, não vê
suas senhas, não usa seu perfil.

- A janela abre **fora da tela** para não atrapalhar (dá para mostrar, em Ajustes).
- É mais lento que o caminho normal — mas como coleta de lojas diferentes
  roda em paralelo (ver abaixo), o custo não se soma direto no tempo da rodada.
- Só entra em ação quando o caminho normal é recusado — e a loja fica marcada
  para as próximas rodadas já irem direto pelo navegador (`precisaNavegador`).
- Foi assim que o **Terabyte saiu de ❌ para ⚠️** originalmente. E foi assim
  que a **Amazon também passou a funcionar de verdade**: ela não bloqueia com
  um HTTP de erro — devolve uma casca de ~2KB de HTML para requisição comum
  (não é bloqueio "declarado", é página vazia), e só entrega o conteúdo de
  verdade para quem carrega como navegador. O teste de compatibilidade
  (`server/diagnose.js`) aprendeu a reconhecer essa casca e cair para o
  navegador nela.

### A rodada ficou mais rápida

Duas mudanças em `server/engine.js`, ambas para não pagar em série o que pode
rodar ao mesmo tempo:

- **Busca por loja e por consulta, em paralelo.** Antes, uma consulta esperava
  a loja anterior terminar; agora todas as lojas de uma consulta (e todas as
  consultas) são buscadas ao mesmo tempo. Cada domínio ainda respeita seu
  próprio intervalo mínimo entre requisições (`server/net.js`), então
  paralelizar aqui não atropela loja nenhuma — só evita que a KaBuM, que é
  rápida, espere a Terabyte, que precisa de navegador e é lenta.
- **Enriquecimento de ficha (ida à página do produto atrás de EAN) também
  virou paralelo.** Rodando em série, essa etapa sozinha dobrava o tempo da
  rodada — é a própria anotação do código.
- **A gravação continua em série**, uma consulta por vez: é aí que produto,
  oferta e histórico são criados, e paralelizar geraria corrida entre dois
  anúncios disputando o mesmo produto.

### Por que este protótipo tem servidor, se os outros do vault são um HTML só

Porque o navegador proíbe uma página de ler outro site (CORS). Uma página aberta
por duplo clique não consegue buscar preço na KaBuM — quem consegue é o
servidor. É a mesma razão pela qual o Pesquisador de logos do Guipa Manager não
consegue ler o Google Imagens.

## Os dois passos de uso

**1. Cadastre uma loja** — aba Lojas, digite o endereço (ex. `kabum.com.br`) e
clique em testar. O KiwiFinder abre a loja, descobre sozinho a URL de busca,
roda uma busca de teste e responde:

| | |
|---|---|
| ✅ **compatível** | achou a busca, leu nome e preço, com dado estruturado |
| ⚠️ **parcial** | dá para acompanhar, com a limitação escrita na tela |
| ❌ **incompatível** | bloqueia robô, exige login, ou não tem busca legível |

Loja ⚠️ parcial pode ser cadastrada — acompanhar com limite é melhor que não
acompanhar. O veredito fica salvo com data e pode ser refeito a qualquer
momento pelo botão **retestar**, porque site de loja muda.

**2. Cadastre uma consulta** — aba Consultas. Pode ser específica
(`Cafeteira Oster Máxima 127V`) ou ampla (`Cafeteira expresso`). Enquanto você
digita, ele mostra o que entendeu: marca, modelo, categoria, especificações.

Depois disso é só esperar: duas rodadas por dia (08:30 e 20:30, editáveis em
Ajustes) mais o botão **Atualizar agora** quando você quiser.

## O que já está funcionando de verdade

Testado contra lojas reais desde 11/08/2026, não em dado de mentira:

- **Teste de compatibilidade** com descoberta automática da URL de busca — lê os
  formulários da página inicial e testa os 12 padrões de busca mais comuns do
  varejo brasileiro.
- **Extração em escada**: JSON-LD → estado embutido da própria loja
  (`__NEXT_DATA__` e afins) → microdata → seletores configurados → heurística de
  blocos repetidos. A escolha da estratégia é medida por qualidade do resultado,
  não por quantidade.
- **Interpretação da consulta**: separa marca, linha, modelo, categoria e specs
  sem você informar nada. **Palavra que sobra também virou exigência**: em
  "cafeteira oster maxima", "maxima" não é marca nem categoria — é o nome da
  linha, e sem cobrar essa palavra a busca devolvia a Oster inteira.
- **Voltagem normalizada**: 110V, 115V, 120V e 127V são a mesma tomada no
  Brasil e viram uma coisa só (`127v`) na identidade do produto — lojas
  diferentes escrevem isso de jeitos diferentes. 220V continua sendo um
  produto à parte, porque é uma compra diferente de verdade.
- **Correspondência**: casa nomes diferentes do mesmo produto entre lojas,
  descarta acessório, livro de receita, usado, variante errada (RTX 5070 ≠
  RTX 5070 Ti) e spec divergente (pediu 16GB, anúncio é 12GB). Verificado com
  o mesmo notebook anunciado por KaBuM e Kalunga com títulos diferentes: virou
  um produto só, com as duas ofertas lado a lado e a diferença de R$ 937
  calculada.
- **Regra de agrupamento numa busca específica**: quando a consulta mira um
  produto (`cafeteira oster maxima`, `ninja creami`), o padrão virou juntar os
  anúncios das lojas por padrão — cada loja escreve o mesmo aparelho de um
  jeito diferente, e exigir título parecido multiplicava o mesmo produto por
  loja. Só separa quando um atributo que realmente distingue diverge: voltagem,
  capacidade, memória, processador, modelo ou linha.
- **Identidade do produto** por EAN/GTIN → MPN → marca + modelo + linha +
  specs + processador. É o que separa Eagle de Aero na mesma RTX 5070, e Ryzen
  5 de Celeron no mesmo Vivobook Go 15.
- **Histórico por produto × loja**, independente de URL — anúncio pode trocar de
  endereço que o histórico continua.
- **Série diária de preço mínimo** (`serieDiaria`, em `server/engine.js`) e o
  gráfico que a desenha (`public/graficos.js`) — o valor do dia é o menor entre
  todas as lojas; dia sem leitura arrasta o último preço conhecido e marca
  como estimado (traço pontilhado no gráfico), em vez de virar buraco.
- **Avaliação "vale a pena comprar agora"**: compara o preço de hoje com o
  histórico do próprio produto (percentil dentro da janela recente) e devolve
  uma classificação — ótimo, bom, normal ou caro para o padrão daquele
  produto. Não compara com preço de mercado nenhum, só com o que aquele
  produto já custou.
- **Produtos podem ser arquivados**: manualmente pelo usuário (botão na
  interface), ou automaticamente quando um ajuste na regra de correspondência
  faz um produto que entrou antes deixar de corresponder à busca — nesse caso
  o motivo fica registrado (`motivoArquivo`). Arquivado não some: o histórico
  de preço continua, dá para reverter, e ele não volta a ser criado como
  produto novo na rodada seguinte.
- **Oportunidades**: novo menor preço, queda relevante, melhor preço entre lojas
  e preço abaixo do objetivo.

## O que as lojas responderam no teste (atualizado em 13/08/2026)

Rodei o teste de compatibilidade contra as lojas da biblioteca. Este é o retrato
do dia — loja muda, então vale reteste:

| Loja | Veredito | Como leu | Observação |
|---|---|---|---|
| KaBuM! | ⚠️ parcial | JSON-LD | melhor resultado: nome, preço, link e SKU |
| **Terabyte** | ⚠️ parcial | navegador 🌐 | só responde a navegador real; foi de onde saiu o **primeiro EAN capturado** (11/08) |
| **Amazon** | ⚠️ parcial | navegador 🌐 | não bloqueia com erro — devolve casca de ~2KB de HTML para requisição comum; navegador real recupera a página inteira |
| Kalunga | ⚠️ parcial | layout | segue lendo produto com preço normalmente |
| Carrefour | ⚠️ parcial | JSON-LD | segue lendo produto normalmente |
| Tramontina | ⚠️ parcial | layout | preço certo depois de ensinar a ignorar "ECONOMIZE" e parcela |
| Pichau | ❌ | — | responde "Site em Manutenção" a qualquer automação, até de navegador real |
| Magalu · Mercado Livre · Americanas · Casas Bahia · Netshoes · Centauro · Nike | ❌ | — | bloqueiam **mesmo com navegador real** — testado, um por um (11/08) |
| Fast Shop · Girafa | ❌ | — | busca não localizável / não responderam (11/08) |

**Já vêm cadastradas: KaBuM!, Terabyte, Kalunga, Carrefour e Amazon** — as
cinco que passaram até agora. Pode excluir as que não interessarem.

## O que NÃO funciona, e por quê

**Marketplaces grandes bloqueiam de verdade.** Magalu, Mercado Livre,
Americanas, Casas Bahia, Netshoes, Centauro e Nike foram testados **com
navegador real**, um por um, e continuam barrando. Não é limitação de
implementação: é proteção que só cede com sessão de gente de verdade. Era o
risco nº 1 registrado na nota da ideia; está confirmado.

**A Pichau é o caso mais fechado**: responde "Site em Manutenção" a qualquer
automação, inclusive navegador real.

**A Terabyte e a Amazon foram resgatadas** pelo navegador — a Terabyte porque a
Cloudflare barra pela impressão digital do TLS, a Amazon porque devolve uma
casca vazia para quem não "parece" navegador. Isso mostra a fronteira: bloqueio
técnico (TLS, casca vazia) o navegador resolve; proteção comportamental de
marketplace grande, não.

**Busca só por marca (`Apple`) é recusada** — decisão de escopo de 11/08/2026,
não limitação técnica. A mensagem na tela explica e sugere como reescrever.

**EAN/GTIN quase não aparece** em listagem de busca do varejo brasileiro. A
ordem de prioridade da spec está implementada e o degrau 1 funciona quando o
dado existe — a primeira captura real foi na Terabyte, abrindo a página do
produto (`4719331355777`). Mas na maioria dos casos quem resolve é a combinação
marca + modelo + linha + specs + processador.

**Sem IA por enquanto.** Nada aqui chama modelo de linguagem: a correspondência é
determinística e auditável (cada decisão devolve o motivo). O gancho para o
degrau 6 da spec existe em `precisaDeDesempate()`, em `server/match.js`.

## Onde ficam seus dados

`dados/kiwifinder.json`, dentro desta pasta. Um arquivo só, legível, com lojas,
consultas, produtos, ofertas, histórico e oportunidades. Gravado de forma
atômica (escreve `.tmp` e renomeia), então desligar no meio não corrompe.

Para **começar do zero**, feche o app e apague esse arquivo.
Para **fazer backup**, copie esse arquivo.

## Mapa do código

| Arquivo | O que faz |
|---|---|
| `server/index.js` | servidor HTTP, rotas da API e eventos ao vivo (SSE) |
| `server/diagnose.js` | teste de compatibilidade da loja — a etapa nº 1 |
| `server/extract.js` | a escada de extração e a escolha de estratégia |
| `server/html.js` | parser de HTML e seletores, escritos aqui para não ter dependência |
| `server/net.js` | rede: uma requisição por domínio, intervalo mínimo, detecção de bloqueio |
| `server/nlp.js` | interpretação da consulta (marca, modelo, categoria, specs) |
| `server/match.js` | pontuação de correspondência e identidade do produto |
| `server/engine.js` | a rodada: buscar, casar, gravar histórico, achar oportunidade, série diária |
| `server/navegador.js` | o navegador real (Chrome instalado, via `playwright-core`) para loja que bloqueia requisição comum |
| `server/store.js` | persistência em JSON |
| `server/library.js` | lojas conhecidas, só como atalho de cadastro |
| `public/app.js` | a interface (JS puro, sem framework) |
| `public/graficos.js` | os gráficos (SVG puro, sem lib de gráfico) |

## Além do básico, também já está aí

- **Aviso no computador** quando aparece oportunidade — notificação do sistema,
  funciona com a aba em segundo plano. Ativa em Ajustes.
- **Mais de uma página de resultado por busca** — configurável em Ajustes
  (padrão 1; subir aumenta cobertura e tempo na mesma proporção).
- **Ficha completa do produto novo**: abre a página do anúncio uma vez atrás de
  EAN/GTIN, MPN e tabela de especificações. Quando acha EAN, a identidade do
  produto passa a ser à prova de mudança de título.
- **Exportar histórico em CSV** (Ajustes), com vírgula decimal e BOM — abre
  direto no Excel em português.
- **Reencontrar anúncio que sumiu**: se o produto sai da busca, ele abre a URL
  guardada; se ela morreu, procura de novo pelos atributos.
- **Ajuste manual de leitura por loja** ("Ajustar leitura", na aba Lojas):
  quando a heurística de layout pega o campo errado, dá para apontar o seletor
  CSS do cartão, nome, preço e link na mão, testar contra uma busca real antes
  de salvar, e voltar ao automático quando quiser. Isso é o que a v1 registrava
  como próximo passo e já está pronto.
- **Filtros de ruído novos** na correspondência: livro de receita e ebook (a
  armadilha da Amazon — "ninja creami" devolvia mais livro que máquina) e
  acessório de cozinha (pote, tampa, peça de reposição) entraram na lista de
  `ACESSORIOS`, em `server/match.js`. E o campo marca ganhou reconhecimento de
  "Não Informado", "sem marca", "genérico" e afins como marca vazia — antes
  esses valores eram tratados como se fossem uma marca de verdade.

## Próximos passos naturais

1. **IA no desempate** dos casos ambíguos, com o gancho que já existe em
   `precisaDeDesempate()`.
2. **Alerta por e-mail**, para saber da oportunidade sem estar no computador.
3. **Frete e parcelamento no histórico** — o campo existe, falta extrair.
4. **Gráfico com uma linha por loja** ao longo do tempo — hoje o gráfico do
   produto mostra a faixa mín/máx do dia entre as lojas, não uma curva por
   loja individual.

## Ver também

[[../KiwiFinder|KiwiFinder — a ideia]] · [[../Sobre Ideias de Negócio]] ·
[[LEIA-ME — Guipa Manager]]
