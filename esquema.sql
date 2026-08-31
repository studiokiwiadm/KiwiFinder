-- Esquema do KiwiFinder no Supabase.
--
-- Como rodar: painel do Supabase -> SQL Editor -> cole isto -> Run.
-- É idempotente: rodar de novo não apaga nada.
--
-- Duas tabelas, por motivos diferentes:
--
--   estado     UMA linha com o documento inteiro em JSONB. Config, lojas,
--              consultas, produtos e ofertas mudam juntos e são pequenos;
--              reescrever tudo é mais simples e mais seguro do que manter dez
--              tabelas em sincronia com o código que já existe.
--
--   historico  Tabela de verdade, só de inserção. É o único dado que NÃO dá
--              para reconstruir — preço de ontem não volta — e cresce para
--              sempre. Não pode viver dentro de um documento reescrito por
--              inteiro a cada gravação.

create table if not exists estado (
  id            text primary key,
  documento     jsonb not null,
  atualizado_em timestamptz not null default now()
);

create table if not exists historico (
  id          bigserial primary key,
  produto_id  text not null,
  loja_id     text not null,
  preco       numeric(12,2),
  preco_de    numeric(12,2),
  disponivel  boolean,
  url         text,
  ts          timestamptz not null default now()
);

-- A consulta que o app mais faz é "todo o histórico deste produto", para
-- desenhar a curva e achar o mínimo.
create index if not exists historico_produto_ts on historico (produto_id, ts);
create index if not exists historico_produto_loja on historico (produto_id, loja_id);

-- ---------------------------------------------------------------- segurança
--
-- RLS ligado e SEM política de acesso: assim as chaves públicas (anon) não
-- leem nem escrevem nada. O app fala com o banco pela service key, que passa
-- por cima do RLS — e essa chave vive só nas variáveis de ambiente do Render,
-- nunca no repositório e nunca no navegador.
alter table estado    enable row level security;
alter table historico enable row level security;

-- ------------------------------------------------------------------ higiene
--
-- Opcional, para quando o histórico ficar grande: apaga leituras com mais de
-- dois anos. Descomente e agende no cron do Supabase se um dia fizer falta.
--
-- delete from historico where ts < now() - interval '2 years';
