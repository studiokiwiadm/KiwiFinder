// ============================================================================
// KIWIFINDER — app.js
// SPA em JavaScript puro (sem frameworks). Consome a API em /api e eventos
// em tempo real via SSE (/api/eventos). Renderização por strings HTML +
// delegação de eventos em `document` (click, change, input, submit).
// ============================================================================

import { graficoPrecoDiario, sparkline, barrasComparacao, faixaDePreco } from './graficos.js';
import { tornarArrastavel } from './arrastar.js';

const BASE = '/api';

// ----------------------------------------------------------------------------
// Estado da aplicação
// ----------------------------------------------------------------------------
const state = {
  config: {}, lojas: [], consultas: [], produtos: [], oportunidades: [],
  rodadas: [], resumo: {},
  // Texto de divulgação de afiliado; null quando nenhuma loja tem código.
  divulgacaoAfiliado: null,
};

const ui = {
  // Só claro e escuro. Quem já tinha "auto" salvo entra no tema que o sistema
  // estava mostrando naquele momento, e a escolha passa a ser dele.
  tema: (() => {
    const salvo = localStorage.getItem('kiwifinder.tema');
    if (salvo === 'claro' || salvo === 'escuro') return salvo;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
  })(),
  sidebarRecolhida: localStorage.getItem('kiwifinder.sidebar') === 'recolhida',
  rota: 'painel',
  carregandoInicial: true,
  erroCarregamento: null,
  sseConectado: false,
  diagAtivo: null,      // {entrada, passos, resultado, erro, emAndamento}
  retestando: null,     // {lojaId, passos}
  bibliotecaLojas: null,
  bibliotecaCarregando: false,
  consultaRascunho: { texto: '', precoDesejado: '', interpretacao: null, aceita: null, motivo: null, carregando: false },
  rodadaProgresso: null,
  rodadaEmAndamento: false,
  // Família aberta no momento. Enquanto isto tem valor, a ficha de produto
  // sabe que foi aberta de dentro de um grupo e oferece "voltar" no lugar de
  // "fechar".
  grupoAberto: null,
  produtosFiltroConsulta: 'todas',
  produtosBusca: '',
  produtosOrdenar: 'queda',
  produtosMostrarArquivados: false,
  oportunidadesFiltroTipo: 'todas',
};

let rodadaSalvaguardaTimer = null;
let confirmarCallback = null;

// ----------------------------------------------------------------------------
// Utilidades de formatação
// ----------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function formatMoney(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}
function formatMoneyCompacto(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);
}
function formatPercent(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function formatDataHora(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}
function formatDataCurta(ts) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(new Date(ts));
}
// Datas relativas em pt-BR ("há 2 horas", "ontem", "em 3 dias"...)
function formatRelativo(iso) {
  if (!iso) return '';
  const diffMs = new Date(iso) - new Date();
  const diffSeg = Math.round(diffMs / 1000);
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  const abs = Math.abs(diffSeg);
  if (abs < 60) return rtf.format(diffSeg, 'second');
  const diffMin = Math.round(diffSeg / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const diffHora = Math.round(diffMin / 60);
  if (Math.abs(diffHora) < 24) return rtf.format(diffHora, 'hour');
  const diffDia = Math.round(diffHora / 24);
  if (Math.abs(diffDia) < 30) return rtf.format(diffDia, 'day');
  const diffMes = Math.round(diffDia / 30);
  if (Math.abs(diffMes) < 12) return rtf.format(diffMes, 'month');
  return rtf.format(Math.round(diffMes / 12), 'year');
}

// ----------------------------------------------------------------------------
// Camada de API
// ----------------------------------------------------------------------------
class ApiError extends Error {}

async function apiFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new ApiError('Não consegui falar com o servidor. Verifique sua conexão e tente novamente.');
  }
  const texto = await res.text();
  let dados = null;
  if (texto) { try { dados = JSON.parse(texto); } catch (e) { dados = null; } }
  if (!res.ok) {
    const msg = (dados && (dados.erro || dados.motivo || dados.mensagem)) || `Não foi possível concluir a operação (HTTP ${res.status}).`;
    const err = new ApiError(msg);
    err.status = res.status;
    err.dados = dados;
    throw err;
  }
  return dados;
}

const api = {
  estado: () => apiFetch('/estado'),
  diagnosticarLoja: (entrada) => apiFetch('/lojas/diagnosticar', { method: 'POST', body: { entrada } }),
  criarLoja: (diagnostico, nome) => apiFetch('/lojas', { method: 'POST', body: { diagnostico, ...(nome ? { nome } : {}) } }),
  atualizarLoja: (id, campos) => apiFetch(`/lojas/${id}`, { method: 'PATCH', body: campos }),
  retestarLoja: (id) => apiFetch(`/lojas/${id}/retestar`, { method: 'POST' }),
  excluirLoja: (id) => apiFetch(`/lojas/${id}`, { method: 'DELETE' }),
  biblioteca: () => apiFetch('/lojas/biblioteca'),
  interpretarConsulta: (texto) => apiFetch('/consultas/interpretar', { method: 'POST', body: { texto } }),
  criarConsulta: (texto, precoDesejado) => apiFetch('/consultas', { method: 'POST', body: { texto, ...(precoDesejado != null ? { precoDesejado } : {}) } }),
  atualizarConsulta: (id, campos) => apiFetch(`/consultas/${id}`, { method: 'PATCH', body: campos }),
  excluirConsulta: (id) => apiFetch(`/consultas/${id}`, { method: 'DELETE' }),
  rodarConsulta: (id) => apiFetch(`/consultas/${id}/rodar`, { method: 'POST' }),
  rodarTudo: () => apiFetch('/rodar', { method: 'POST' }),
  historicoProduto: (id) => apiFetch(`/produtos/${id}/historico`),
  atualizarProduto: (id, campos) => apiFetch(`/produtos/${id}`, { method: 'PATCH', body: campos }),
  adicionarLink: (id, url) => apiFetch(`/produtos/${id}/link`, { method: 'POST', body: { url } }),
  marcarOportunidadeLida: (id) => apiFetch(`/oportunidades/${id}/lida`, { method: 'POST' }),
  marcarTodasLidas: () => apiFetch('/oportunidades/lidas', { method: 'POST' }),
  salvarConfig: (campos) => apiFetch('/config', { method: 'PATCH', body: campos }),
};

async function carregarEstado() {
  try {
    const dados = await api.estado();
    const idsAntes = new Set((state.oportunidades || []).map(o => o.id));
    Object.assign(state, dados);
    ui.erroCarregamento = null;
    avisarNovasOportunidades(idsAntes);
  } catch (e) {
    ui.erroCarregamento = e.message;
  }
}

// ----------------------------------------------------------------------------
// Avisos do sistema — o ponto do app é justamente não precisar ficar olhando
// para ele. Só dispara para oportunidade nova e não lida, no máximo três de
// uma vez, para não virar enxurrada depois de uma rodada grande.
// ----------------------------------------------------------------------------
let primeiraCarga = true;

function pedirPermissaoDeAviso() {
  if (typeof Notification === 'undefined') {
    mostrarToast('Este navegador não suporta avisos do sistema.', 'erro');
    return;
  }
  Notification.requestPermission().then(resultado => {
    mostrarToast(resultado === 'granted' ? 'Avisos ativados.' : 'Avisos não foram permitidos.',
      resultado === 'granted' ? 'sucesso' : 'erro');
    render();
  });
}

function avisarNovasOportunidades(idsAntes) {
  if (primeiraCarga) { primeiraCarga = false; return; }
  if (!notificacoesLigadas()) return;
  const novas = (state.oportunidades || []).filter(o => !o.lida && !idsAntes.has(o.id));
  for (const op of novas.slice(0, 3)) {
    try {
      const aviso = new Notification('KiwiFinder — oportunidade', {
        body: op.texto,
        tag: op.id,
        icon: 'data:image/svg+xml,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#7CB342"/><circle cx="32" cy="32" r="20" fill="#EFF3E4"/><circle cx="32" cy="32" r="6" fill="#F4F7EC"/></svg>')
      });
      aviso.onclick = () => { window.focus(); location.hash = '#/oportunidades'; aviso.close(); };
    } catch { /* aviso é conforto, não pode quebrar a tela */ }
  }
  if (novas.length > 3) {
    try {
      // eslint-disable-next-line no-new
      new Notification('KiwiFinder', { body: `+ ${novas.length - 3} outras oportunidades novas.`, tag: 'resumo' });
    } catch { /* idem */ }
  }
}

// ----------------------------------------------------------------------------
// Tema (claro ou escuro, com transição animada na troca)
// ----------------------------------------------------------------------------
function aplicarTema() {
  document.documentElement.setAttribute('data-theme', ui.tema);
  document.querySelectorAll('.kf-tema-btn').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.tema === ui.tema));
  });
}

// A troca de tema é animada. Onde o navegador tem View Transitions, a página
// inteira faz um crossfade; onde não tem, uma classe temporária liga transição
// de cor em tudo por meio segundo. A classe é temporária de propósito: deixar
// transição de cor ligada o tempo todo faz cada hover ficar preguiçoso.
function setTema(valor) {
  if (valor === ui.tema) return;
  const menosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const trocar = () => {
    ui.tema = valor;
    localStorage.setItem('kiwifinder.tema', valor);
    aplicarTema();
    if (!document.getElementById('kf-conta-menu')?.hidden) renderContaMenu();
  };

  if (menosMovimento) { trocar(); return; }

  if (document.startViewTransition) {
    document.startViewTransition(trocar);
    return;
  }
  const raiz = document.documentElement;
  raiz.classList.add('kf-trocando-tema');
  trocar();
  setTimeout(() => raiz.classList.remove('kf-trocando-tema'), 420);
}

// ----------------------------------------------------------------------------
// Barra lateral recolhível e menu da conta
//
// O tema saiu do cabeçalho e foi para dentro do menu da conta: no topo ele
// competia com a marca e com o estado da conexão, e é uma coisa que se ajusta
// uma vez e nunca mais.
// ----------------------------------------------------------------------------
function aplicarSidebar() {
  document.getElementById('kf-app')?.classList.toggle('kf-sidebar-recolhida', ui.sidebarRecolhida);
  const botao = document.querySelector('[data-action="sidebar.alternar"]');
  if (botao) {
    const rotulo = ui.sidebarRecolhida ? 'Expandir o menu' : 'Recolher o menu';
    botao.setAttribute('aria-label', rotulo);
    botao.title = rotulo;
    const texto = botao.querySelector('span');
    if (texto) texto.textContent = 'Recolher';
  }
}

function alternarSidebar() {
  ui.sidebarRecolhida = !ui.sidebarRecolhida;
  localStorage.setItem('kiwifinder.sidebar', ui.sidebarRecolhida ? 'recolhida' : 'aberta');
  aplicarSidebar();
}

function renderContaMenu() {
  const menu = document.getElementById('kf-conta-menu');
  if (!menu) return;
  const nome = (state.config?.usuarioId || 'você').replace(/^./, c => c.toUpperCase());
  const temas = [
    ['claro', 'Claro'],
    ['escuro', 'Escuro']
  ];
  menu.innerHTML = `
    <div class="kf-conta-cabecalho">
      <span class="kf-avatar kf-avatar--grande" aria-hidden="true"><span class="kf-avatar-inicial">${escapeHtml(nome[0] || 'K')}</span></span>
      <div>
        <strong>${escapeHtml(nome)}</strong>
        <span class="kf-texto-pequeno kf-texto-suave">Uso pessoal · dados só nesta máquina</span>
      </div>
    </div>
    <div class="kf-conta-secao">
      <span class="kf-conta-rotulo">Tema</span>
      <div class="kf-tema-alternador" role="group" aria-label="Tema da interface">
        ${temas.map(([valor, rotulo]) => `
          <button type="button" class="kf-tema-btn" data-tema="${valor}" aria-pressed="${ui.tema === valor}">${rotulo}</button>
        `).join('')}
      </div>
    </div>
    <div class="kf-conta-secao">
      <a href="#/ajustes" class="kf-conta-item" role="menuitem" data-action="conta.fechar">Ajustes da plataforma</a>
      <a href="/api/exportar/historico.csv" class="kf-conta-item" role="menuitem" download>Baixar histórico (CSV)</a>
    </div>`;
}

function alternarContaMenu(forcarFechar = false) {
  const menu = document.getElementById('kf-conta-menu');
  const botao = document.getElementById('kf-avatar');
  if (!menu || !botao) return;
  const abrir = forcarFechar ? false : menu.hidden;
  if (abrir) renderContaMenu();
  menu.hidden = !abrir;
  botao.setAttribute('aria-expanded', String(abrir));
}

// ----------------------------------------------------------------------------
// Notificações discretas (toast)
// ----------------------------------------------------------------------------
function mostrarToast(mensagem, tipo = 'info', duracaoMs = 4200) {
  const root = document.getElementById('kf-toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'kf-toast';
  el.dataset.tipo = tipo;
  el.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  el.textContent = mensagem;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, duracaoMs);
}

// ----------------------------------------------------------------------------
// Modais próprios (sem alert/confirm nativos)
// ----------------------------------------------------------------------------
function modalRoot() { return document.getElementById('kf-modal-root'); }

function abrirModal({ titulo, corpoHtml, rodapeHtml = '', largo = false, tamanho = null, voltarPara = null }) {
  const classeTamanho = tamanho === 'xl' ? 'kf-modal--xl' : (largo ? 'kf-modal--largo' : '');
  // Entrou por uma família? Então o botão do canto volta para a família. Um
  // "x" ali jogaria a pessoa na grade inteira e ela perderia o lugar.
  const botaoCanto = voltarPara
    ? `<button type="button" class="kf-btn-icone" data-action="modal.voltar" data-id="${escapeHtml(voltarPara)}" aria-label="Voltar" title="Voltar">
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M15.4 4.6L13.98 3.2 5.17 12l8.81 8.8 1.42-1.4L8 12z"/></svg>
      </button>`
    : `<button type="button" class="kf-btn-icone" data-action="modal.fechar" aria-label="Fechar modal">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.89 18.3 9.17 12 2.89 5.71 4.3 4.29l6.29 6.3 6.3-6.3z"/></svg>
      </button>`;
  modalRoot().innerHTML = `
    <div class="kf-modal-overlay" data-action="modal.overlay">
      <div class="kf-modal ${classeTamanho}" role="dialog" aria-modal="true" aria-labelledby="kf-modal-titulo-txt">
        <div class="kf-modal-cabecalho">
          <h2 class="kf-modal-titulo" id="kf-modal-titulo-txt">${escapeHtml(titulo)}</h2>
          ${botaoCanto}
        </div>
        <div class="kf-modal-corpo">${corpoHtml}</div>
        ${rodapeHtml ? `<div class="kf-modal-rodape">${rodapeHtml}</div>` : ''}
      </div>
    </div>`;
  document.addEventListener('keydown', fecharModalEsc);
}
function fecharModal() {
  modalRoot().innerHTML = '';
  ui.grupoAberto = null;
  document.removeEventListener('keydown', fecharModalEsc);
  confirmarCallback = null;
}
function fecharModalEsc(e) { if (e.key === 'Escape') fecharModal(); }

function confirmarAcao(titulo, mensagem, textoBotao, aoConfirmar, perigo = true) {
  confirmarCallback = aoConfirmar;
  abrirModal({
    titulo,
    corpoHtml: `<p>${escapeHtml(mensagem)}</p>`,
    rodapeHtml: `
      <button type="button" class="kf-btn kf-btn-secundaria" data-action="modal.fechar">Cancelar</button>
      <button type="button" class="kf-btn ${perigo ? 'kf-btn-perigo' : 'kf-btn-primaria'}" data-action="confirmar.sim">${escapeHtml(textoBotao)}</button>
    `,
  });
}

// ----------------------------------------------------------------------------
// Server-Sent Events
// ----------------------------------------------------------------------------
function conectarSSE() {
  let es;
  try { es = new EventSource(BASE + '/eventos'); } catch (e) { atualizarIndicadorConexao(false); return; }
  es.onopen = () => atualizarIndicadorConexao(true);
  es.onerror = () => atualizarIndicadorConexao(false);
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    tratarEventoSSE(msg);
  };
}
function atualizarIndicadorConexao(ativo) {
  ui.sseConectado = ativo;
  const wrap = document.getElementById('kf-conexao');
  const texto = document.getElementById('kf-conexao-texto');
  if (wrap) wrap.dataset.estado = ativo ? 'ativo' : 'inativo';
  if (texto) texto.textContent = ativo ? 'em tempo real' : 'sem conexão em tempo real';
}
function tratarEventoSSE(msg) {
  if (msg.tipo === 'passo') {
    if (ui.diagAtivo && ui.diagAtivo.emAndamento) ui.diagAtivo.passos.push({ texto: msg.texto, ok: msg.ok, detalhe: msg.detalhe });
    if (ui.retestando) ui.retestando.passos.push({ texto: msg.texto, ok: msg.ok, detalhe: msg.detalhe });
    if (ui.rota === 'lojas') renderPreservandoFoco();
  } else if (msg.tipo === 'rodada') {
    ui.rodadaProgresso = { fase: msg.fase, atual: msg.atual, total: msg.total, texto: msg.texto };
    if (ui.rota === 'painel') renderPreservandoFoco();
  } else if (msg.tipo === 'atualizado') {
    const estavaRodando = ui.rodadaEmAndamento;
    carregarEstado().then(() => {
      if (estavaRodando) {
        ui.rodadaEmAndamento = false;
        ui.rodadaProgresso = null;
        clearTimeout(rodadaSalvaguardaTimer);
      }
      renderPreservandoFoco();
    });
  }
}

// ----------------------------------------------------------------------------
// Roteamento e renderização
// ----------------------------------------------------------------------------
const ROTAS = ['painel', 'consultas', 'produtos', 'lojas', 'oportunidades', 'ajustes'];
function rotaAtual() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROTAS.includes(hash) ? hash : 'painel';
}
function capturarFoco() {
  const el = document.activeElement;
  const main = document.getElementById('kf-main');
  if (!el || !el.id || !main || !main.contains(el)) return null;
  return { id: el.id, inicio: el.selectionStart, fim: el.selectionEnd };
}
function restaurarFoco(foco) {
  if (!foco) return;
  const el = document.getElementById(foco.id);
  if (!el) return;
  el.focus();
  if (typeof foco.inicio === 'number' && el.setSelectionRange) {
    try { el.setSelectionRange(foco.inicio, foco.fim); } catch (e) {}
  }
}
function renderPreservandoFoco() {
  const foco = capturarFoco();
  render();
  restaurarFoco(foco);
}
function atualizarNavAtiva() {
  document.querySelectorAll('.kf-nav-link').forEach(a => a.classList.toggle('ativo', a.dataset.rota === ui.rota));
}
function atualizarBadgeOportunidades() {
  const badge = document.getElementById('kf-nav-badge-oportunidades');
  if (!badge) return;
  const naoLidas = (state.oportunidades || []).filter(o => !o.lida).length;
  badge.hidden = naoLidas === 0;
  badge.textContent = naoLidas > 99 ? '99+' : String(naoLidas);
}

// O botão de atualizar vive no cabeçalho, fora do main que é re-renderizado —
// então o estado dele (rodando / parado) é atualizado à mão.
function atualizarBotaoRodada() {
  const botao = document.getElementById('kf-atualizar-tudo');
  if (!botao) return;
  const rodando = ui.rodadaEmAndamento || state.resumo?.rodando;
  botao.disabled = Boolean(rodando);
  botao.classList.toggle('kf-girando', Boolean(rodando));
  const texto = botao.querySelector('span');
  if (texto) texto.textContent = rodando ? 'Buscando…' : 'Atualizar';
  botao.title = rodando
    ? 'Busca em andamento nas suas lojas'
    : 'Buscar preços agora em todas as lojas';
}

function render() {
  ui.rota = rotaAtual();
  atualizarNavAtiva();
  const main = document.getElementById('kf-main');
  if (!main) return;
  if (ui.carregandoInicial) return;
  if (ui.erroCarregamento) { main.innerHTML = renderErroCarregamento(); return; }

  let html = '';
  switch (ui.rota) {
    case 'painel': html = renderPainel(); break;
    case 'consultas': html = renderConsultas(); break;
    case 'produtos': html = renderProdutos(); break;
    case 'lojas': html = renderLojas(); break;
    case 'oportunidades': html = renderOportunidades(); break;
    case 'ajustes': html = renderAjustes(); break;
  }
  // Divulgação de link de afiliado: exigência de praticamente todo programa, e
  // o mínimo de honestidade com quem clica. Fica no rodapé de toda tela, e só
  // existe quando há de fato um link de afiliado configurado.
  main.innerHTML = html + (state.divulgacaoAfiliado
    ? `<p class="kf-divulgacao">${escapeHtml(state.divulgacaoAfiliado)}</p>`
    : '');
  atualizarBadgeOportunidades();
  atualizarBotaoRodada();
  posRender();
}
let desligarArrastar = null;

function posRender() {
  if (ui.rota === 'lojas' && ui.bibliotecaLojas === null && !ui.bibliotecaCarregando) carregarBiblioteca();

  // O container é recriado a cada render, então os ouvintes do arrasto
  // precisam ser desligados antes — senão vazam a cada evento em tempo real.
  if (desligarArrastar) { desligarArrastar(); desligarArrastar = null; }
  const grade = document.querySelector('.kf-grade-produtos');
  if (ui.rota === 'produtos') curarFotosDeGrupo();
  if (ui.rota === 'produtos' && grade) {
    desligarArrastar = tornarArrastavel(grade, {
      seletorItem: '.kf-produto-cartao, .kf-grupo-cartao',
      atributoId: 'data-id',
      ignorar: 'button, a, input, select, .kf-produto-curva',
      aoReordenar: salvarOrdemProdutos
    });
  }
}

async function salvarOrdemProdutos(ids) {
  // A grade mistura cartão de produto e cartão de família. O servidor só
  // conhece produto, então cada grupo é aberto na ordem em que suas
  // configurações estão dentro dele.
  const grupos = new Map(agruparProdutos(produtosFiltrados())
    .filter(g => g.tipo === 'grupo')
    .map(g => [g.id, g.produtos.map(p => p.id)]));
  ids = ids.flatMap(id => grupos.get(id) || [id]);
  try {
    await apiFetch('/produtos/ordem', { method: 'POST', body: { ids } });
    // Passa a ordenar pela ordem manual, senão o próximo render desfaz o que
    // acabou de ser arrastado.
    ui.produtosOrdenar = 'manual';
    await carregarEstado();
    render();
    mostrarToast('Ordem salva.', 'sucesso');
  } catch (e) {
    mostrarToast('Não consegui salvar a ordem.', 'erro');
  }
}
function renderErroCarregamento() {
  return `<div class="kf-erro-rede kf-mt-16">
    <span>Não consegui falar com o servidor. Verifique se ele está rodando.</span>
    <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="app.tentarNovamente">Tentar novamente</button>
  </div>`;
}
async function recarregarTudo() { await carregarEstado(); render(); }

async function carregarBiblioteca() {
  ui.bibliotecaCarregando = true;
  try { const dados = await api.biblioteca(); ui.bibliotecaLojas = dados.lojas || []; }
  catch (e) { ui.bibliotecaLojas = []; mostrarToast('Não consegui carregar as lojas conhecidas.', 'erro'); }
  ui.bibliotecaCarregando = false;
  if (ui.rota === 'lojas') renderPreservandoFoco();
}

// ----------------------------------------------------------------------------
// Componentes reutilizáveis
// ----------------------------------------------------------------------------
function statCard(rotulo, valor, destaque = false) {
  return `<div class="kf-stat-card ${destaque ? 'kf-stat-card--destaque' : ''}"><span class="kf-stat-valor">${valor}</span><span class="kf-stat-rotulo">${escapeHtml(rotulo)}</span></div>`;
}
function iconeOportunidade(tipo) {
  const icones = {
    minimo_historico: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>',
    queda: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M4 6l6 6 4-4 6 8H4z"/></svg>',
    melhor_entre_lojas: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>',
    abaixo_do_objetivo: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2zm1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>',
  };
  return icones[tipo] || icones.queda;
}
function rotuloTipoOportunidade(tipo) {
  return { minimo_historico: 'Mínimo histórico', queda: 'Queda de preço', melhor_entre_lojas: 'Melhor entre lojas', abaixo_do_objetivo: 'Abaixo do seu objetivo' }[tipo] || tipo;
}
function timelineItem(op) {
  return `<div class="kf-timeline-item" data-lida="${!!op.lida}">
    <span class="kf-timeline-icone">${iconeOportunidade(op.tipo)}</span>
    <div class="kf-timeline-corpo">
      <div class="kf-timeline-texto">${escapeHtml(op.texto || `${rotuloTipoOportunidade(op.tipo)}: ${op.produtoNome || ''}`)}</div>
      <div class="kf-timeline-meta">
        ${op.produtoNome ? `<span>${escapeHtml(op.produtoNome)}</span>` : ''}
        ${op.lojaNome ? `<span>${escapeHtml(op.lojaNome)}</span>` : ''}
        <span class="kf-timeline-preco">${formatMoney(op.preco)}</span>
        ${op.percentual != null ? `<span class="${op.percentual < 0 ? 'kf-diff-queda' : op.percentual > 0 ? 'kf-diff-alta' : ''}">${formatPercent(op.percentual)}</span>` : ''}
        <span>${formatRelativo(op.ts)}</span>
      </div>
    </div>
    ${!op.lida ? `<button type="button" class="kf-btn kf-btn-fantasma kf-btn-pequeno" data-action="oportunidades.lida" data-id="${op.id}">Marcar como lida</button>` : ''}
  </div>`;
}
function chipsInterpretacao(interp) {
  if (!interp) return '';
  const partes = [];
  if (interp.marca) partes.push(`<span class="kf-chip kf-chip--marca">Marca: <strong>${escapeHtml(interp.marca)}</strong></span>`);
  if (interp.modelo) partes.push(`<span class="kf-chip">Modelo: <strong>${escapeHtml(interp.modelo)}</strong></span>`);
  if (interp.categoria) partes.push(`<span class="kf-chip">Categoria: <strong>${escapeHtml(interp.categoria)}</strong></span>`);
  (interp.specs || []).forEach(s => partes.push(`<span class="kf-chip">${escapeHtml(s)}</span>`));
  return partes.join('');
}
function passoHtml(p) {
  return `<div class="kf-passo" data-ok="${!!p.ok}"><span class="kf-passo-icone">${p.ok ? '✓' : '✕'}</span><span>${escapeHtml(p.texto)}${p.detalhe ? `<span class="kf-passo-detalhe">${escapeHtml(p.detalhe)}</span>` : ''}</span></div>`;
}
function amostraItem(item) {
  const extras = [item.marca, item.gtin].filter(Boolean).join(' · ');
  return `<div class="kf-amostra-item"><span class="kf-amostra-nome">${escapeHtml(item.nome)}${extras ? ` <span class="kf-texto-suave">(${escapeHtml(extras)})</span>` : ''}</span><span class="kf-amostra-preco">${formatMoney(item.preco)}</span></div>`;
}

// ----------------------------------------------------------------------------
// TELA: Painel
// ----------------------------------------------------------------------------
function renderPainel() {
  const r = state.resumo || {};
  const semLojas = (state.lojas || []).length === 0;
  const naoLidas = [...(state.oportunidades || [])].filter(o => !o.lida).sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 8);
  const semConsultas = (state.consultas || []).length === 0;
  // O título responde a pergunta que traz a pessoa aqui: tem algo pra mim hoje?
  const titulo = semLojas || semConsultas
    ? 'Bem-vindo'
    : naoLidas.length
      ? `${naoLidas.length} ${naoLidas.length === 1 ? 'oportunidade' : 'oportunidades'} esperando por você`
      : 'Nada novo por enquanto';
  const subtitulo = semLojas || semConsultas
    ? 'Dois passos e o KiwiFinder começa a trabalhar sozinho.'
    : naoLidas.length
      ? 'Preços que caíram, chegaram ao menor valor já visto ou ficaram abaixo do seu objetivo.'
      : `Acompanhando ${r.produtosMonitorados ?? 0} ${r.produtosMonitorados === 1 ? 'produto' : 'produtos'} em ${r.lojasAtivas ?? 0} ${r.lojasAtivas === 1 ? 'loja' : 'lojas'}. Avisamos assim que algo mudar.`;

  return `
  <div class="kf-tela-cabecalho">
    <div>
      <h1 class="kf-tela-titulo">${escapeHtml(titulo)}</h1>
      <p class="kf-tela-subtitulo">${escapeHtml(subtitulo)}</p>
    </div>
    <div class="kf-coluna-fim">
      <button type="button" class="kf-btn kf-btn-primaria" data-action="painel.atualizar" ${ui.rodadaEmAndamento ? 'disabled' : ''}>
        ${ui.rodadaEmAndamento ? '<span class="kf-spinner kf-spinner-pequeno" aria-hidden="true"></span> Atualizando…' : 'Atualizar agora'}
      </button>
      <div class="kf-texto-pequeno kf-texto-suave kf-mt-8">${r.proximaRodada
        ? `Próxima rodada ${escapeHtml(formatRelativo(r.proximaRodada))}`
        : 'Rodadas automáticas desligadas'}</div>
    </div>
  </div>

  ${ui.rodadaEmAndamento ? renderProgressoRodada() : ''}

  ${semLojas || semConsultas ? renderBoasVindas() : `
    ${naoLidas.length
      ? `<div class="kf-timeline">${naoLidas.map(timelineItem).join('')}</div>
         <div class="kf-mt-16"><a href="#/oportunidades" class="kf-btn kf-btn-secundaria kf-btn-pequeno">Ver todas as oportunidades</a></div>`
      : `<div class="kf-vazio"><strong>Nenhuma oportunidade nova</strong>Assim que um preço cair, chegar ao menor valor já visto ou bater seu objetivo, aparece aqui.</div>`}

    <div class="kf-secao">
      <h2 class="kf-secao-titulo">Como estão suas buscas</h2>
      <div class="kf-stats-grid">
        ${statCard('Buscas ativas', r.consultasAtivas ?? 0)}
        ${statCard('Produtos acompanhados', r.produtosMonitorados ?? 0)}
        ${statCard('Caíram de preço', r.produtosEmQueda ?? 0, (r.produtosEmQueda ?? 0) > 0)}
        ${statCard('No menor preço já visto', r.novosMinimos ?? 0, (r.novosMinimos ?? 0) > 0)}
        ${statCard('Leituras de preço hoje', r.atualizacoesHoje ?? 0)}
      </div>
    </div>
  `}
  `;
}
function renderProgressoRodada() {
  const p = ui.rodadaProgresso;
  if (!p) return `<div class="kf-progresso"><div class="kf-progresso-titulo"><span class="kf-spinner kf-spinner-pequeno" aria-hidden="true"></span> Iniciando atualização…</div></div>`;
  const pct = p.total ? Math.round((p.atual / p.total) * 100) : null;
  return `<div class="kf-progresso">
    <div class="kf-progresso-titulo"><span class="kf-spinner kf-spinner-pequeno" aria-hidden="true"></span> ${escapeHtml(p.texto || 'Atualizando…')} ${p.total ? `(${p.atual}/${p.total}${pct != null ? ` · ${pct}%` : ''})` : ''}</div>
  </div>`;
}
function renderBoasVindas() {
  return `<div class="kf-card kf-mt-16">
    <h2 class="kf-secao-titulo">Bem-vindo ao KiwiFinder</h2>
    <p class="kf-texto-suave kf-mt-8">Para começar a encontrar boas oportunidades, siga dois passos simples:</p>
    <div class="kf-boas-vindas kf-mt-16">
      <div class="kf-boas-vindas-passo">
        <span class="kf-boas-vindas-numero">1</span>
        <div>
          <strong class="kf-texto-pequeno">Cadastre uma loja</strong>
          <p class="kf-texto-suave kf-texto-pequeno">Cole o endereço de uma loja que você gosta e a gente testa se consegue ler os preços dela.</p>
          <div class="kf-mt-8"><a href="#/lojas" class="kf-btn kf-btn-primaria kf-btn-pequeno">Ir para Lojas</a></div>
        </div>
      </div>
      <div class="kf-boas-vindas-passo">
        <span class="kf-boas-vindas-numero">2</span>
        <div>
          <strong class="kf-texto-pequeno">Diga o que você quer acompanhar</strong>
          <p class="kf-texto-suave kf-texto-pequeno">Descreva um produto, por exemplo "Notebook Dell Inspiron 15", e deixe o KiwiFinder de olho nele.</p>
          <div class="kf-mt-8"><a href="#/consultas" class="kf-btn kf-btn-primaria kf-btn-pequeno">Ir para Consultas</a></div>
        </div>
      </div>
    </div>
  </div>`;
}

// ----------------------------------------------------------------------------
// TELA: Lojas
// ----------------------------------------------------------------------------
function renderLojas() {
  const lojas = state.lojas || [];
  return `
  <div class="kf-tela-cabecalho">
    <div><h1 class="kf-tela-titulo">Lojas</h1><p class="kf-tela-subtitulo">Suas lojas de confiança. Antes de cadastrar qualquer uma, o KiwiFinder testa se consegue mesmo ler os preços dela — e diz por quê.</p></div>
  </div>

  <div class="kf-card">
    <label class="kf-campo">
      <span class="kf-campo-rotulo">Endereço da loja</span>
      <div class="kf-linha-busca">
        <input type="text" id="kf-loja-entrada" class="kf-input" placeholder="ex. kabum.com.br" value="${escapeHtml(ui.diagAtivo?.entrada || '')}" ${ui.diagAtivo?.emAndamento ? 'disabled' : ''}>
        <button type="button" class="kf-btn kf-btn-primaria" data-action="lojas.testar" ${ui.diagAtivo?.emAndamento ? 'disabled' : ''}>${ui.diagAtivo?.emAndamento ? 'Testando…' : 'Testar compatibilidade'}</button>
      </div>
      <span class="kf-campo-ajuda">Pode colar a URL completa ou só o domínio. O teste pode levar até 40 segundos.</span>
    </label>
    ${ui.diagAtivo ? renderPainelDiagnostico() : ''}
  </div>

  <div class="kf-secao">
    <h2 class="kf-secao-titulo">Lojas cadastradas</h2>
    ${lojas.length ? `<div class="kf-grade">${lojas.map(lojaCartao).join('')}</div>` : `<div class="kf-vazio"><strong>Nenhuma loja cadastrada ainda</strong>Cole o endereço de uma loja acima para começar.</div>`}
  </div>

  <div class="kf-secao">
    <h2 class="kf-secao-titulo">Lojas conhecidas</h2>
    ${renderBibliotecaLojas()}
  </div>
  `;
}
function renderPainelDiagnostico() {
  const d = ui.diagAtivo;
  if (d.erro) {
    return `<div class="kf-erro-rede kf-mt-16">
      <span>Não consegui testar essa loja: ${escapeHtml(d.erro)}</span>
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="lojas.descartar">Fechar</button>
    </div>`;
  }
  if (d.emAndamento) {
    return `<div class="kf-progresso">
      <div class="kf-progresso-titulo"><span class="kf-spinner kf-spinner-pequeno" aria-hidden="true"></span> Testando ${escapeHtml(d.entrada)}…</div>
      ${d.passos.length ? `<div class="kf-passos">${d.passos.map(passoHtml).join('')}</div>` : `<p class="kf-texto-suave kf-texto-pequeno">Aguardando os primeiros passos do teste…</p>`}
    </div>`;
  }
  if (d.resultado) {
    const r = d.resultado;
    const selos = { compativel: 'kf-selo-compativel', parcial: 'kf-selo-parcial', incompativel: 'kf-selo-incompativel' };
    const rotulos = { compativel: 'Compatível', parcial: 'Parcial', incompativel: 'Incompatível' };
    return `<div class="kf-veredito" data-veredito="${r.veredito}">
      <div class="kf-veredito-cabecalho">
        <h3>${escapeHtml(r.titulo || '')}</h3>
        <span class="kf-selo ${selos[r.veredito] || 'kf-selo-incompativel'}">${rotulos[r.veredito] || r.veredito}</span>
      </div>
      <p class="kf-veredito-explicacao">${escapeHtml(r.explicacao || '')}</p>
      ${r.limitacoes?.length ? `<ul class="kf-veredito-limitacoes">${r.limitacoes.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
      ${r.estrategia ? `<p class="kf-texto-pequeno kf-texto-suave"><strong>Como lemos os preços:</strong> ${escapeHtml(r.estrategia)}</p>` : ''}
      ${r.amostra?.length ? `<div class="kf-mt-16"><strong class="kf-texto-pequeno">Produtos lidos como exemplo (${r.lidos ?? r.amostra.length} lidos, ${r.comPreco ?? '—'} com preço)</strong><div class="kf-amostra kf-mt-8">${r.amostra.slice(0, 8).map(amostraItem).join('')}</div></div>` : ''}
      <div class="kf-veredito-acoes">
        ${r.veredito !== 'incompativel' ? `<button type="button" class="kf-btn kf-btn-primaria" data-action="lojas.cadastrar">${r.veredito === 'parcial' ? 'Cadastrar mesmo assim (compatibilidade parcial)' : 'Cadastrar loja'}</button>` : ''}
        <button type="button" class="kf-btn kf-btn-fantasma" data-action="lojas.descartar">Descartar</button>
      </div>
    </div>`;
  }
  return '';
}
function lojaCartao(l) {
  const selos = { compativel: 'kf-selo-compativel', parcial: 'kf-selo-parcial', incompativel: 'kf-selo-incompativel' };
  const rotulos = { compativel: 'Compatível', parcial: 'Parcial', incompativel: 'Incompatível' };
  const totalProdutos = (state.produtos || []).filter(p => (p.ofertas || []).some(o => o.lojaId === l.id)).length;
  const retestandoEsta = ui.retestando && ui.retestando.lojaId === l.id;
  return `<div class="kf-card kf-loja-cartao">
    <div class="kf-cartao-topo">
      <div><div class="kf-cartao-titulo">${escapeHtml(l.nome)}</div><div class="kf-cartao-sub">${escapeHtml(l.host)}</div></div>
      <span class="kf-selo ${selos[l.veredito] || 'kf-selo-incompativel'}">${rotulos[l.veredito] || l.veredito}</span>
    </div>
    <div class="kf-cartao-meta">
      <span>Testado ${formatRelativo(l.diagnostico?.testadoEm) || '—'}</span>
      ${l.precisaNavegador ? '<span title="A loja atende, mas monta a página em JavaScript — o KiwiFinder abre um navegador real, como qualquer visitante faria.">Página montada em JavaScript</span>' : ''}
      ${l.afiliado?.rede ? `<span title="Link de afiliado ativo nesta loja">Afiliado: ${escapeHtml(l.afiliado.rede)}</span>` : ''}
      <span>${totalProdutos} produto${totalProdutos === 1 ? '' : 's'} monitorado${totalProdutos === 1 ? '' : 's'}</span>
    </div>
    ${l.precisaAcessoAutorizado ? `<div class="kf-aviso-autorizacao">
      <strong>Esta loja não quer ser lida assim.</strong>
      Ela recusou a requisição, e o KiwiFinder respeita a recusa em vez de contornar.
      Para acompanhar preço aqui, o caminho é o que a própria loja abre: programa de
      afiliado com feed de produtos, ou API oficial. Enquanto isso ela fica sem preço.
      ${l.ultimoErro ? `<span class="kf-texto-pequeno kf-texto-tenue">${escapeHtml(l.ultimoErro)}</span>` : ''}
    </div>` : ''}
    ${l.robotsProibe ? `<div class="kf-aviso-autorizacao">
      <strong>O robots.txt da loja não autoriza esta leitura.</strong>
      É a loja dizendo por escrito o que aceita, e o KiwiFinder obedece.
    </div>` : ''}
    ${!l.precisaAcessoAutorizado && !l.robotsProibe && l.ultimoErro ? `<p class="kf-texto-pequeno kf-diff-alta">Último erro: ${escapeHtml(l.ultimoErro)}${l.falhasSeguidas ? ` (${l.falhasSeguidas}x seguidas)` : ''}</p>` : ''}
    ${retestandoEsta ? `<div class="kf-progresso"><div class="kf-progresso-titulo"><span class="kf-spinner kf-spinner-pequeno" aria-hidden="true"></span> Retestando…</div>${ui.retestando.passos.length ? `<div class="kf-passos">${ui.retestando.passos.map(passoHtml).join('')}</div>` : ''}</div>` : ''}
    <div class="kf-cartao-acoes">
      <label class="kf-linha-toggle">
        <span class="kf-switch"><input type="checkbox" data-action="lojas.toggle" data-id="${l.id}" ${l.ativa ? 'checked' : ''} aria-label="Ativar ou desativar loja ${escapeHtml(l.nome)}"><span class="kf-switch-trilho"></span></span>
        <span class="kf-texto-pequeno">${l.ativa ? 'Ativa' : 'Inativa'}</span>
      </label>
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="lojas.retestar" data-id="${l.id}" ${retestandoEsta ? 'disabled' : ''}>Retestar</button>
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="lojas.diagnostico" data-id="${l.id}">Ver diagnóstico</button>
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="lojas.seletores" data-id="${l.id}">Ajustar leitura</button>
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="lojas.escopo" data-id="${l.id}">${l.escopo ? 'Vende: ' + escapeHtml(l.escopo.slice(0, 22)) : 'O que vende'}</button>
      <button type="button" class="kf-btn kf-btn-perigo kf-btn-pequeno" data-action="lojas.excluir" data-id="${l.id}">Excluir</button>
    </div>
  </div>`;
}
function renderBibliotecaLojas() {
  if (ui.bibliotecaCarregando) return `<p class="kf-texto-suave kf-texto-pequeno">Carregando sugestões…</p>`;
  const lista = ui.bibliotecaLojas || [];
  if (!lista.length) return `<div class="kf-vazio"><strong>Nenhuma sugestão disponível</strong>Ainda não temos lojas conhecidas para sugerir.</div>`;
  return `<div class="kf-grade-1col">${lista.map(item => `
    <div class="kf-card kf-biblioteca-item">
      <div><div class="kf-cartao-titulo">${escapeHtml(item.nome)}</div><div class="kf-cartao-sub">${escapeHtml(item.host)}${item.observacao ? ` — ${escapeHtml(item.observacao)}` : ''}</div></div>
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="lojas.biblioteca.testar" data-host="${escapeHtml(item.host)}">Testar</button>
    </div>`).join('')}</div>`;
}
// ----------------------------------------------------------------------------
// Ajuste manual da leitura de uma loja. Serve para resgatar loja ⚠️ parcial em
// que a heurística de layout pegou o campo errado: você aponta o seletor CSS do
// cartão, do nome e do preço, testa contra uma busca real e só então salva.
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// Escopo da loja: o que ela vende. Serve para o KiwiFinder não procurar
// cafeteira numa loja que só vende Apple — cada busca inútil custa segundos, e
// loja que exige navegador custa mais ainda.
// ----------------------------------------------------------------------------
function abrirModalEscopo(id) {
  const l = (state.lojas || []).find(x => x.id === id);
  if (!l) return;
  const buscas = (state.consultas || []).map(c => c.texto);
  abrirModal({
    titulo: `O que a ${l.nome} vende`,
    corpoHtml: `
      <p class="kf-texto-pequeno kf-texto-suave">Escreva em poucas palavras. Suas buscas que não tiverem nada a ver com isso deixam de ser feitas nesta loja, e a rodada fica mais rápida. Em branco, ela participa de todas.</p>
      <label class="kf-campo kf-mt-16">
        <span class="kf-campo-rotulo">Assunto da loja</span>
        <input class="kf-input" id="kf-escopo" value="${escapeHtml(l.escopo || '')}" placeholder="produtos apple, macbook, iphone, ipad">
        <span class="kf-campo-ajuda">Separe por vírgula. Ex.: “hardware de PC, placa de vídeo” ou “eletroportátil, cozinha”.</span>
      </label>
      ${buscas.length ? `<div class="kf-mt-16"><span class="kf-campo-rotulo">Suas buscas hoje</span><div class="kf-chips">${buscas.map(b => `<span class="kf-chip">${escapeHtml(b)}</span>`).join('')}</div></div>` : ''}`,
    rodapeHtml: `
      <button type="button" class="kf-btn kf-btn-fantasma" data-action="modal.fechar">Cancelar</button>
      <button type="button" class="kf-btn kf-btn-primaria" data-action="escopo.salvar" data-id="${id}">Salvar</button>`
  });
}

async function salvarEscopo(id) {
  const valor = (document.getElementById('kf-escopo')?.value || '').trim();
  try {
    await apiFetch(`/lojas/${id}`, { method: 'PATCH', body: { escopo: valor } });
    await carregarEstado();
    fecharModal();
    render();
    mostrarToast(valor ? 'Assunto da loja salvo.' : 'A loja voltou a participar de todas as buscas.', 'sucesso');
  } catch (e) {
    mostrarToast(e.message, 'erro');
  }
}

function abrirModalSeletores(id) {
  const l = (state.lojas || []).find(x => x.id === id);
  if (!l) return;
  const s = l.seletores || {};
  abrirModal({
    titulo: `Ajustar leitura — ${l.nome}`,
    largo: true,
    corpoHtml: `
      <p class="kf-texto-pequeno kf-texto-suave">Deixe tudo em branco para o KiwiFinder continuar descobrindo sozinho. Preencha só se a leitura automática estiver pegando o texto errado. Use seletor CSS, como <code>.product-card</code> ou <code>[data-testid=price]</code>.</p>
      <div class="kf-ajustes-grade kf-mt-16">
        <label class="kf-campo"><span class="kf-campo-rotulo">Cartão do produto (obrigatório)</span><input class="kf-input" id="sel-item" placeholder=".product-card" value="${escapeHtml(s.item || '')}"></label>
        <label class="kf-campo"><span class="kf-campo-rotulo">Nome, dentro do cartão</span><input class="kf-input" id="sel-nome" placeholder="h2, .title" value="${escapeHtml(s.nome || '')}"></label>
        <label class="kf-campo"><span class="kf-campo-rotulo">Preço, dentro do cartão</span><input class="kf-input" id="sel-preco" placeholder=".price" value="${escapeHtml(s.preco || '')}"></label>
        <label class="kf-campo"><span class="kf-campo-rotulo">Link, dentro do cartão</span><input class="kf-input" id="sel-link" placeholder="a" value="${escapeHtml(s.link || '')}"></label>
        <label class="kf-campo"><span class="kf-campo-rotulo">Termo para o teste</span><input class="kf-input" id="sel-termo" value="notebook"></label>
      </div>
      <div id="sel-resultado" class="kf-mt-16"></div>`,
    rodapeHtml: `
      <button type="button" class="kf-btn kf-btn-fantasma" data-action="seletores.limpar" data-id="${id}">Voltar ao automático</button>
      <button type="button" class="kf-btn kf-btn-secundaria" data-action="seletores.testar" data-id="${id}">Testar</button>
      <button type="button" class="kf-btn kf-btn-primaria" data-action="seletores.salvar" data-id="${id}">Salvar</button>`
  });
}

function lerCamposSeletores() {
  const v = (sel) => (document.getElementById(sel)?.value || '').trim();
  return { item: v('sel-item'), nome: v('sel-nome'), preco: v('sel-preco'), link: v('sel-link') };
}

async function testarSeletores(id) {
  const alvo = document.getElementById('sel-resultado');
  const seletores = lerCamposSeletores();
  if (!seletores.item) { alvo.innerHTML = '<p class="kf-texto-pequeno kf-diff-alta">Informe pelo menos o seletor do cartão.</p>'; return; }
  alvo.innerHTML = '<p class="kf-texto-pequeno kf-texto-suave">Testando contra uma busca real…</p>';
  try {
    const r = await apiFetch(`/lojas/${id}/testar-seletores`, {
      method: 'POST',
      body: { seletores, termo: (document.getElementById('sel-termo')?.value || 'notebook').trim() }
    });
    alvo.innerHTML = r.total
      ? `<p class="kf-texto-pequeno"><strong>${r.total}</strong> cartões lidos, <strong>${r.comPreco}</strong> com preço.</p>
         <ul class="kf-lista-amostra">${r.amostra.map(i => `<li><span>${escapeHtml((i.nome || '(sem nome)').slice(0, 70))}</span><strong>${i.preco ? formatMoney(i.preco) : '—'}</strong></li>`).join('')}</ul>`
      : '<p class="kf-texto-pequeno kf-diff-alta">Nenhum cartão bateu com esse seletor.</p>';
  } catch (e) {
    alvo.innerHTML = `<p class="kf-texto-pequeno kf-diff-alta">${escapeHtml(e.message)}</p>`;
  }
}

async function salvarSeletores(id, limpar = false) {
  try {
    await apiFetch(`/lojas/${id}`, { method: 'PATCH', body: { seletores: limpar ? null : lerCamposSeletores() } });
    await carregarEstado();
    fecharModal();
    render();
    mostrarToast(limpar ? 'Voltou para a leitura automática.' : 'Leitura ajustada.', 'sucesso');
  } catch (e) {
    mostrarToast(e.message, 'erro');
  }
}

function abrirModalDiagnostico(id) {
  const loja = state.lojas.find(l => l.id === id);
  if (!loja) return;
  const d = loja.diagnostico || {};
  const selos = { compativel: 'kf-selo-compativel', parcial: 'kf-selo-parcial', incompativel: 'kf-selo-incompativel' };
  const corpo = `
    <div class="kf-flex-entre">
      <span class="kf-selo ${selos[loja.veredito] || 'kf-selo-incompativel'}">${loja.veredito}</span>
      <span class="kf-texto-pequeno kf-texto-suave">Testado ${formatDataHora(d.testadoEm)}</span>
    </div>
    <p class="kf-mt-16">${escapeHtml(d.explicacao || '')}</p>
    ${d.limitacoes?.length ? `<ul class="kf-veredito-limitacoes">${d.limitacoes.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}
    ${d.estrategia ? `<p class="kf-texto-pequeno"><strong>Estratégia:</strong> ${escapeHtml(d.estrategia)}</p>` : ''}
    <p class="kf-texto-pequeno kf-texto-suave">${d.lidos ?? '—'} itens lidos · ${d.comPreco ?? '—'} com preço${d.robots ? ` · robots.txt: ${d.robots.proibeBusca ? 'proíbe busca' : 'permite busca'}${d.robots.crawlDelay != null ? `, atraso de ${d.robots.crawlDelay}s` : ''}` : ''}</p>
    ${d.passos?.length ? `<div class="kf-mt-16"><strong class="kf-texto-pequeno">Passos do teste</strong><div class="kf-passos kf-mt-8">${d.passos.map(passoHtml).join('')}</div></div>` : ''}
    ${d.amostra?.length ? `<div class="kf-mt-16"><strong class="kf-texto-pequeno">Amostra</strong><div class="kf-amostra kf-mt-8">${d.amostra.map(amostraItem).join('')}</div></div>` : ''}
  `;
  abrirModal({ titulo: `Diagnóstico — ${loja.nome}`, corpoHtml: corpo, largo: true });
}

// ações — Lojas
async function iniciarDiagnostico(entradaBruta) {
  const entrada = (entradaBruta || '').trim();
  if (!entrada) { mostrarToast('Digite o endereço de uma loja primeiro.', 'aviso'); return; }
  ui.diagAtivo = { entrada, passos: [], resultado: null, erro: null, emAndamento: true };
  renderPreservandoFoco();
  try {
    const resultado = await api.diagnosticarLoja(entrada);
    ui.diagAtivo.resultado = resultado;
  } catch (e) {
    ui.diagAtivo.erro = e.message;
  }
  ui.diagAtivo.emAndamento = false;
  renderPreservandoFoco();
}
function descartarDiagnostico() { ui.diagAtivo = null; render(); }
async function cadastrarLoja() {
  if (!ui.diagAtivo?.resultado) return;
  try {
    const { loja } = await api.criarLoja(ui.diagAtivo.resultado, ui.diagAtivo.resultado.nome);
    state.lojas = [...state.lojas.filter(l => l.id !== loja.id), loja];
    ui.diagAtivo = null;
    mostrarToast(`Loja "${loja.nome}" cadastrada.`, 'sucesso');
    render();
  } catch (e) { mostrarToast(e.message, 'erro'); }
}
async function toggleLoja(id, ativa) {
  try {
    const { loja } = await api.atualizarLoja(id, { ativa });
    state.lojas = state.lojas.map(l => (l.id === id ? loja : l));
  } catch (e) { mostrarToast(e.message, 'erro'); }
  render();
}
async function retestarLoja(id) {
  ui.retestando = { lojaId: id, passos: [] };
  renderPreservandoFoco();
  try {
    const { loja } = await api.retestarLoja(id);
    state.lojas = state.lojas.map(l => (l.id === id ? loja : l));
    mostrarToast('Loja retestada.', 'sucesso');
  } catch (e) { mostrarToast(e.message, 'erro'); }
  ui.retestando = null;
  render();
}
function excluirLojaConfirmar(id) {
  const loja = state.lojas.find(l => l.id === id);
  confirmarAcao('Excluir loja', `Tem certeza que quer excluir "${loja?.nome || ''}"? Os produtos associados deixam de ser comparados nela.`, 'Excluir', async () => {
    try {
      await api.excluirLoja(id);
      state.lojas = state.lojas.filter(l => l.id !== id);
      mostrarToast('Loja excluída.', 'sucesso');
    } catch (e) { mostrarToast(e.message, 'erro'); }
    render();
  });
}

// ----------------------------------------------------------------------------
// TELA: Consultas
// ----------------------------------------------------------------------------
function renderConsultas() {
  const consultas = state.consultas || [];
  const rasc = ui.consultaRascunho;
  return `
  <div class="kf-tela-cabecalho"><div><h1 class="kf-tela-titulo">Buscas</h1><p class="kf-tela-subtitulo">Escreva o que você quer comprar. Pode ser específico, como “Cafeteira Oster Máxima 127V”, ou aberto, como “cafeteira expresso”.</p></div></div>

  <form class="kf-card" data-action-submit="consultas.criar">
    <label class="kf-campo">
      <span class="kf-campo-rotulo">O que você quer acompanhar?</span>
      <textarea id="kf-consulta-texto" class="kf-textarea" placeholder="ex. Notebook Dell Inspiron 15 16GB" data-action-input="consultas.digitar">${escapeHtml(rasc.texto)}</textarea>
    </label>
    ${rasc.carregando ? `<p class="kf-texto-pequeno kf-texto-suave kf-mt-8">Interpretando…</p>` : ''}
    ${rasc.interpretacao && rasc.aceita ? `<div class="kf-chips kf-mt-8">${chipsInterpretacao(rasc.interpretacao)}</div>` : ''}
    ${rasc.aceita === false ? `<div class="kf-aviso kf-mt-8">${escapeHtml(rasc.motivo || 'Essa busca não pôde ser aceita ainda.')}</div>` : ''}
    <label class="kf-campo kf-mt-16" style="max-width:220px;">
      <span class="kf-campo-rotulo">Preço desejado (opcional)</span>
      <input type="number" min="0" step="0.01" id="kf-consulta-preco" class="kf-input" placeholder="R$" value="${escapeHtml(rasc.precoDesejado)}" data-action-input="consultas.preco.digitar">
    </label>
    <div class="kf-mt-16"><button type="submit" class="kf-btn kf-btn-primaria" ${rasc.aceita === false || !rasc.texto.trim() ? 'disabled' : ''}>Começar a acompanhar</button></div>
  </form>

  <div class="kf-secao">
    <h2 class="kf-secao-titulo">Suas consultas</h2>
    ${consultas.length ? `<div class="kf-grade">${consultas.map(consultaCartao).join('')}</div>` : `<div class="kf-vazio"><strong>Nenhuma consulta ainda</strong>Use o campo acima para começar a acompanhar um produto.</div>`}
  </div>
  `;
}
function consultaCartao(c) {
  return `<div class="kf-card kf-consulta-cartao">
    <div class="kf-cartao-topo">
      <div class="kf-cartao-titulo">${escapeHtml(c.texto)}</div>
      <label class="kf-linha-toggle">
        <span class="kf-switch"><input type="checkbox" data-action="consultas.toggle" data-id="${c.id}" ${c.ativa ? 'checked' : ''} aria-label="Ativar ou desativar consulta"><span class="kf-switch-trilho"></span></span>
      </label>
    </div>
    ${c.interpretacao ? `<div class="kf-chips">${chipsInterpretacao(c.interpretacao)}</div>` : ''}
    <div class="kf-cartao-meta">
      <span>${c.totalProdutos ?? 0} produto${c.totalProdutos === 1 ? '' : 's'} encontrado${c.totalProdutos === 1 ? '' : 's'}</span>
      <span>Última rodada: ${c.ultimaRodada ? formatRelativo(c.ultimaRodada) : 'ainda não rodou'}</span>
    </div>
    <label class="kf-campo">
      <span class="kf-campo-rotulo">Preço desejado</span>
      <input type="number" min="0" step="0.01" class="kf-input" data-action="consultas.preco.salvar" data-id="${c.id}" value="${c.precoDesejado ?? ''}" placeholder="Sem preço definido">
    </label>
    <div class="kf-cartao-acoes">
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="consultas.rodar" data-id="${c.id}">Rodar agora</button>
      <button type="button" class="kf-btn kf-btn-perigo kf-btn-pequeno" data-action="consultas.excluir" data-id="${c.id}">Excluir</button>
    </div>
  </div>`;
}

// ações — Consultas
const debouncedInterpretar = debounce((texto) => interpretarRascunho(texto), 400);
async function interpretarRascunho(texto) {
  if (texto !== ui.consultaRascunho.texto) return;
  ui.consultaRascunho.carregando = true;
  try {
    const resp = await api.interpretarConsulta(texto);
    if (texto !== ui.consultaRascunho.texto) return;
    ui.consultaRascunho.interpretacao = resp.interpretacao;
    ui.consultaRascunho.aceita = resp.aceita;
    ui.consultaRascunho.motivo = resp.motivo;
  } catch (e) {
    mostrarToast(e.message, 'erro');
  }
  ui.consultaRascunho.carregando = false;
  renderPreservandoFoco();
}
async function criarConsulta() {
  const rasc = ui.consultaRascunho;
  const texto = rasc.texto.trim();
  if (!texto) return;
  const precoDesejado = rasc.precoDesejado !== '' && rasc.precoDesejado != null ? Number(rasc.precoDesejado) : undefined;
  try {
    const { consulta } = await api.criarConsulta(texto, precoDesejado);
    state.consultas = [...state.consultas, consulta];
    ui.consultaRascunho = { texto: '', precoDesejado: '', interpretacao: null, aceita: null, motivo: null, carregando: false };
    mostrarToast('Consulta criada.', 'sucesso');
    render();
  } catch (e) {
    if (e.status === 422 && e.dados) {
      ui.consultaRascunho.aceita = false;
      ui.consultaRascunho.motivo = e.dados.motivo || e.message;
      ui.consultaRascunho.interpretacao = e.dados.interpretacao || ui.consultaRascunho.interpretacao;
      render();
    } else {
      mostrarToast(e.message, 'erro');
    }
  }
}
async function salvarPrecoConsulta(id, valor) {
  const precoDesejado = valor === '' ? null : Number(valor);
  try {
    const { consulta } = await api.atualizarConsulta(id, { precoDesejado });
    state.consultas = state.consultas.map(c => (c.id === id ? consulta : c));
    mostrarToast('Preço desejado atualizado.', 'sucesso');
  } catch (e) { mostrarToast(e.message, 'erro'); }
  render();
}
async function toggleConsulta(id, ativa) {
  try {
    const { consulta } = await api.atualizarConsulta(id, { ativa });
    state.consultas = state.consultas.map(c => (c.id === id ? consulta : c));
  } catch (e) { mostrarToast(e.message, 'erro'); }
  render();
}
async function rodarConsulta(id) {
  try {
    await api.rodarConsulta(id);
    mostrarToast('Rodada iniciada — acompanhe as novidades no Painel e nas Oportunidades.', 'sucesso');
  } catch (e) { mostrarToast(e.message, 'erro'); }
}
function excluirConsultaConfirmar(id) {
  const c = state.consultas.find(x => x.id === id);
  confirmarAcao('Excluir consulta', `Tem certeza que quer excluir "${c?.texto || ''}"? Os produtos encontrados por ela deixam de ser atualizados.`, 'Excluir', async () => {
    try {
      await api.excluirConsulta(id);
      state.consultas = state.consultas.filter(x => x.id !== id);
      mostrarToast('Consulta excluída.', 'sucesso');
    } catch (e) { mostrarToast(e.message, 'erro'); }
    render();
  });
}

// ----------------------------------------------------------------------------
// TELA: Produtos
// ----------------------------------------------------------------------------
function produtosFiltrados() {
  let lista = [...(state.produtos || [])];
  if (!ui.produtosMostrarArquivados) lista = lista.filter(p => !p.arquivado);
  if (ui.produtosFiltroConsulta !== 'todas') lista = lista.filter(p => p.consultaId === ui.produtosFiltroConsulta);
  const busca = ui.produtosBusca.trim().toLowerCase();
  if (busca) lista = lista.filter(p => (p.nome || '').toLowerCase().includes(busca) || (p.marca || '').toLowerCase().includes(busca));
  const comparadores = {
    // Ordem escolhida na mão, arrastando os cartões. Quem ainda não foi
    // arrastado não tem `ordem` e fica depois, na ordem de descoberta.
    manual: (a, b) => (a.ordem ?? Infinity) - (b.ordem ?? Infinity) || new Date(b.criadoEm) - new Date(a.criadoEm),
    queda: (a, b) => (a.resumo?.variacao24h ?? 999) - (b.resumo?.variacao24h ?? 999),
    preco: (a, b) => (a.resumo?.menorAtual ?? Infinity) - (b.resumo?.menorAtual ?? Infinity),
    recente: (a, b) => new Date(b.criadoEm) - new Date(a.criadoEm),
    distancia: (a, b) => (a.resumo?.distanciaDoMinimo ?? Infinity) - (b.resumo?.distanciaDoMinimo ?? Infinity),
  };
  lista.sort(comparadores[ui.produtosOrdenar] || comparadores.recente);
  return lista;
}

function temOrdemManual() {
  return (state.produtos || []).some(p => Number.isFinite(p.ordem));
}

// ----------------------------------------------------------------------------
// Famílias de produto
//
// Uma busca por "macbook pro" traz o de 16GB, o de 24GB e o de 1TB — o mesmo
// produto em configurações diferentes. Na grade eles viram três cartões quase
// idênticos, e a tela deixa de responder "o que eu estou acompanhando" para
// virar uma lista de variações. Agrupados, cada família ocupa um cartão só; as
// configurações ficam a um clique.
// ----------------------------------------------------------------------------

/**
 * O título do grupo sai do nome real dos produtos, não da busca digitada: é o
 * maior trecho de palavras seguidas que TODOS os nomes têm em comum. Para
 * "Apple 2026 MacBook Pro (de 14 polegadas…)" e "Macbook Pro M5 14 Inch 1tb"
 * isso dá exatamente "MacBook Pro" — e mantém a grafia bonita do original.
 */
function trechoComum(a, b) {
  // Maior subsequência contígua de palavras, comparando sem acento/caixa.
  let melhor = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k].chave === b[j + k].chave) k++;
      if (k > melhor.length) melhor = a.slice(i, i + k);
    }
  }
  return melhor;
}

function palavrasDoNome(nome) {
  return String(nome || '')
    .split(/[\s,;()[\]"'/\\|–—-]+/)
    .filter(Boolean)
    .map(p => ({ texto: p, chave: p.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') }))
    .filter(p => p.chave);
}

// Palavra de sobra no fim do título ("de", "com", "chip") deixa o nome
// pendurado; no começo, tira o foco da marca.
const APARAR = new Set(['de', 'da', 'do', 'com', 'para', 'e', 'a', 'o', 'em', 'the', 'chip', 'processador', 'polegadas', 'pol', 'modelo', 'novo', 'nova']);

/**
 * Uma loja escreve "Macbook", outra escreve "MacBook". Entre as grafias que
 * aparecem nos nomes, a boa é a que tem maiúscula no meio — foi escrita por
 * quem conhece a marca, não pelo formulário de cadastro da loja.
 */
function grafiaBonita(chave, nomes) {
  const vistas = new Map();
  for (const nome of nomes) {
    for (const p of nome) {
      if (p.chave !== chave) continue;
      vistas.set(p.texto, (vistas.get(p.texto) || 0) + 1);
    }
  }
  if (!vistas.size) return null;
  const nota = (t) => (/[a-zà-ÿ][A-ZÀ-Þ]/.test(t) ? 100 : 0) + (/^[A-ZÀ-Þ]/.test(t) ? 10 : 0) - (t === t.toUpperCase() ? 20 : 0);
  return [...vistas.entries()]
    .sort((a, b) => nota(b[0]) - nota(a[0]) || b[1] - a[1])[0][0];
}

function tituloDaFamilia(produtos, consulta) {
  const nomes = produtos.map(p => palavrasDoNome(p.nome)).filter(n => n.length);
  if (nomes.length) {
    let comum = nomes.reduce((acc, n) => (acc === null ? n : trechoComum(acc, n)), null) || [];
    const sobra = (p) => APARAR.has(p.chave) || /^\d+$/.test(p.chave);
    while (comum.length && sobra(comum[0])) comum = comum.slice(1);
    while (comum.length && sobra(comum[comum.length - 1])) comum = comum.slice(0, -1);
    if (comum.length > 5) comum = comum.slice(0, 5);
    // Para a grafia vale olhar também o título de cada anúncio: o nome do
    // produto veio de uma loja só, e é ela que decide entre "Macbook" e
    // "MacBook" — mas outra loja pode ter escrito melhor.
    const grafias = nomes.concat(
      produtos.flatMap(p => (p.ofertas || []).map(o => palavrasDoNome(o.titulo))).filter(n => n.length));
    // Palavra de ligação no meio do título fica minúscula, sempre: uma loja
    // que escreve "Máquina De Sorvete" não deve ditar a grafia do "de".
    const titulo = comum
      .map(p => (APARAR.has(p.chave) ? p.chave : (grafiaBonita(p.chave, grafias) || p.texto)))
      .join(' ').trim();
    if (titulo.length >= 4) return titulo;
  }
  // Sem trecho em comum, a busca digitada é o melhor rótulo que existe.
  const texto = (consulta?.texto || 'Produtos').trim();
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * Devolve a grade já montada: famílias com duas ou mais configurações viram um
 * item de grupo; produto sozinho continua sendo ele mesmo. Com uma busca
 * escolhida no filtro, não agrupa — o filtro já é o grupo.
 */
function agruparProdutos(lista) {
  if (ui.produtosFiltroConsulta !== 'todas') return lista.map(p => ({ tipo: 'produto', produto: p }));
  const porConsulta = new Map();
  for (const p of lista) {
    const chave = p.consultaId || p.id;
    if (!porConsulta.has(chave)) porConsulta.set(chave, []);
    porConsulta.get(chave).push(p);
  }
  const saida = [];
  for (const [chave, produtos] of porConsulta) {
    if (produtos.length < 2) { saida.push({ tipo: 'produto', produto: produtos[0] }); continue; }
    const consulta = (state.consultas || []).find(c => c.id === chave);
    saida.push({
      tipo: 'grupo',
      id: 'grp:' + chave,
      consultaId: chave,
      titulo: tituloDaFamilia(produtos, consulta),
      produtos
    });
  }
  // A posição do grupo é a do seu melhor produto: a ordenação escolhida no
  // filtro continua valendo, sem regra paralela para grupo.
  const posicao = new Map(lista.map((p, i) => [p.id, i]));
  saida.sort((a, b) => {
    const pa = a.tipo === 'grupo' ? Math.min(...a.produtos.map(p => posicao.get(p.id))) : posicao.get(a.produto.id);
    const pb = b.tipo === 'grupo' ? Math.min(...b.produtos.map(p => posicao.get(p.id))) : posicao.get(b.produto.id);
    return pa - pb;
  });
  return saida;
}


/**
 * Curadoria da foto do cartão de família.
 *
 * A foto é cortada para preencher um retângulo largo, e nem toda foto sobrevive
 * a isso: a do MacBook Pro na Go Imports é um close da tampa, e cortada virava
 * um borrão escuro. Não dá para saber isso pelo endereço da imagem — só
 * carregando e medindo. Então cada família carrega as suas candidatas uma vez,
 * mede, e fica com a que aguenta o corte.
 *
 * Critério, do mais importante para o menos:
 *   1. foto grande o bastante para não borrar (>= 300px de largura);
 *   2. proporção perto do quadrado, que é como catálogo fotografa produto —
 *      é a que menos perde quando cortada num retângulo largo;
 *   3. entre as parecidas, a de maior área.
 */
const fotoEscolhidaPorGrupo = new Map();

function medirFoto(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ src, largura: img.naturalWidth, altura: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function notaDaFoto(f) {
  if (!f || !f.largura || !f.altura) return -Infinity;
  const proporcao = f.largura / f.altura;
  // Distância da proporção quadrada, em escala logarítmica: 2:1 e 1:2 pesam
  // igual, que é o certo — o corte machuca dos dois lados.
  const desvio = Math.abs(Math.log(proporcao));
  let nota = 100 - desvio * 60;
  if (f.largura < 300) nota -= 40;      // pequena demais: vai borrar esticada
  if (f.largura < 160) nota -= 60;
  nota += Math.min(f.largura * f.altura, 1_000_000) / 200_000;  // desempate
  return nota;
}

async function curarFotosDeGrupo() {
  for (const figura of document.querySelectorAll('.kf-grupo-figura[data-fotos]')) {
    const grupo = figura.dataset.grupo;
    const candidatas = (figura.dataset.fotos || '').split(' ').filter(Boolean);
    if (candidatas.length < 2) continue;

    const img = figura.querySelector('img');
    if (!img) continue;

    const jaEscolhida = fotoEscolhidaPorGrupo.get(grupo);
    if (jaEscolhida) { if (img.src !== jaEscolhida) img.src = jaEscolhida; continue; }

    // Marca antes de medir para duas renderizações seguidas não medirem o
    // mesmo grupo duas vezes.
    fotoEscolhidaPorGrupo.set(grupo, candidatas[0]);
    const medidas = (await Promise.all(candidatas.slice(0, 5).map(medirFoto))).filter(Boolean);
    if (!medidas.length) continue;
    const melhor = medidas.reduce((a, b) => (notaDaFoto(b) > notaDaFoto(a) ? b : a));
    fotoEscolhidaPorGrupo.set(grupo, melhor.src);
    const atual = document.querySelector(`.kf-grupo-figura[data-grupo="${CSS.escape(grupo)}"] img`);
    if (atual && atual.src !== melhor.src) atual.src = melhor.src;
  }
}

function grupoCartao(grupo) {
  const comPreco = grupo.produtos.filter(p => p.resumo?.menorAtual != null);
  const barato = comPreco.length
    ? comPreco.reduce((a, b) => (a.resumo.menorAtual <= b.resumo.menorAtual ? a : b))
    : null;
  const noMinimo = grupo.produtos.some(p => p.resumo?.menorAtual != null && p.resumo.menorAtual <= (p.resumo.menorHistorico ?? Infinity));
  // Uma imagem só, grande: o cartão representa a família inteira, e miniatura
  // empilhada com três fotos quase iguais não informava nada que o "N
  // configurações" já não diga.
  //
  // Qual foto, porém, não pode ser "a da configuração mais barata e pronto".
  // A da Go Imports para o MacBook Pro é um recorte da tampa — cortada no
  // retângulo, virava um borrão escuro impossível de reconhecer. Todas as
  // fotos da família vão no `data-fotos` e a escolha final acontece depois de
  // medir cada uma (ver `curarFotosDeGrupo`).
  const fotos = [...new Set(grupo.produtos.map(p => p.imagem).filter(Boolean))];
  const imagem = fotos[0] || null;

  return `<article class="kf-card kf-grupo-cartao" data-action="produtos.grupo" data-id="${escapeHtml(grupo.id)}"
    role="button" tabindex="0" aria-label="Ver as ${grupo.produtos.length} configurações de ${escapeHtml(grupo.titulo)}">
    <div class="kf-grupo-figura" data-fotos="${escapeHtml(fotos.join(' '))}" data-grupo="${escapeHtml(grupo.id)}">
      ${imagem
        ? `<img class="kf-grupo-imagem" src="${escapeHtml(imagem)}" alt="" loading="lazy">`
        : '<div class="kf-grupo-imagem kf-produto-imagem--vazia" aria-hidden="true"></div>'}
    </div>
    <div class="kf-grupo-info">
      <h3 class="kf-grupo-titulo">${escapeHtml(grupo.titulo)}</h3>
      <div class="kf-produto-legenda">${grupo.produtos.length} configurações</div>
      ${barato ? `
        <div class="kf-grupo-preco">
          <span class="kf-produto-legenda">a partir de</span>
          <span class="kf-preco-grande ${noMinimo ? 'kf-preco--minimo' : ''}">${formatMoney(barato.resumo.menorAtual)}</span>
          <span class="kf-produto-legenda">${escapeHtml(barato.resumo.lojaMaisBarata || '')}</span>
        </div>` : '<div class="kf-produto-legenda">sem oferta no momento</div>'}
      ${noMinimo ? '<div class="kf-produto-selo"><span class="kf-selo-minimo">alguma no menor preço já visto</span></div>' : ''}
    </div>
  </article>`;
}

function abrirModalGrupo(id) {
  const grupo = agruparProdutos(produtosFiltrados()).find(g => g.tipo === 'grupo' && g.id === id);
  if (!grupo) return;
  ui.grupoAberto = grupo.id;
  abrirModal({
    titulo: grupo.titulo,
    // Aqui cabem quantas colunas o monitor permitir: são cartões completos,
    // e comparar configurações lado a lado é o motivo do modal existir.
    tamanho: 'xl',
    corpoHtml: `<div class="kf-grade-produtos kf-grade-produtos--modal">${grupo.produtos.map(produtoCartao).join('')}</div>`
  });
}
function renderProdutos() {
  const consultas = state.consultas || [];
  const lista = produtosFiltrados();
  return `
  <div class="kf-tela-cabecalho"><div><h1 class="kf-tela-titulo">Produtos</h1><p class="kf-tela-subtitulo">${lista.length} ${lista.length === 1 ? 'produto acompanhado' : 'produtos acompanhados'}.</p></div></div>

  <div class="kf-filtros">
    <select class="kf-select" data-action="produtos.filtro" style="max-width:220px;">
      <option value="todas">Todas as buscas</option>
      ${consultas.map(c => `<option value="${c.id}" ${ui.produtosFiltroConsulta === c.id ? 'selected' : ''}>${escapeHtml(c.texto)}</option>`).join('')}
    </select>
    <input type="search" class="kf-input" placeholder="Buscar por nome ou marca…" value="${escapeHtml(ui.produtosBusca)}" data-action-input="produtos.busca" style="max-width:240px;">
    <select class="kf-select" data-action="produtos.ordenar" style="max-width:220px;">
      <option value="manual" ${ui.produtosOrdenar === 'manual' ? 'selected' : ''}>Minha ordem</option>
      <option value="queda" ${ui.produtosOrdenar === 'queda' ? 'selected' : ''}>Maior queda</option>
      <option value="preco" ${ui.produtosOrdenar === 'preco' ? 'selected' : ''}>Menor preço</option>
      <option value="recente" ${ui.produtosOrdenar === 'recente' ? 'selected' : ''}>Mais recente</option>
      <option value="distancia" ${ui.produtosOrdenar === 'distancia' ? 'selected' : ''}>Distância do mínimo histórico</option>
    </select>
    <label class="kf-linha-toggle kf-texto-pequeno">
      <input type="checkbox" data-action="produtos.mostrarArquivados" ${ui.produtosMostrarArquivados ? 'checked' : ''}> Mostrar arquivados
    </label>
  </div>

  ${lista.length
    ? `<div class="kf-grade-produtos">${agruparProdutos(lista).map(item => (item.tipo === 'grupo' ? grupoCartao(item) : produtoCartao(item.produto))).join('')}</div>`
    : `<div class="kf-vazio"><strong>Nenhum produto encontrado</strong>${(state.produtos || []).length ? 'Tente ajustar os filtros.' : 'Cadastre uma busca e os produtos aparecem aqui.'}</div>`}
  `;
}
// Condições de compra da loja mais barata: "no Pix", "em 10x sem juros".
// É o que decide a compra junto com o preço — e o que faz o valor da tela
// bater (ou não) com o que aparece no site da loja.
function condicoesDeCompra(oferta) {
  if (!oferta) return '';
  const partes = [];
  if (oferta.condicao) partes.push(escapeHtml(oferta.condicao));
  if (oferta.parcelamento?.vezes) {
    partes.push(`${oferta.parcelamento.vezes}x de ${formatMoney(oferta.parcelamento.valor)}${oferta.parcelamento.semJuros ? ' sem juros' : ''}`);
  } else if (oferta.precoAVista && oferta.precoAVista > oferta.preco) {
    partes.push(`${formatMoney(oferta.precoAVista)} no cartão`);
  }
  return partes.length ? `<div class="kf-condicoes">${partes.join(' · ')}</div>` : '';
}

/**
 * Comparação entre as lojas de um produto, com a linha de detalhe de cada uma.
 * Saiu do cartão e passou a morar no modal: na grade, três produtos com quatro
 * lojas cada viravam doze linhas de texto miúdo.
 */
function comparacaoDeLojas(produto) {
  const ofertas = (produto.ofertas || []).filter(o => o.preco != null);
  if (!ofertas.length) return '<p class="kf-texto-pequeno kf-texto-suave">Sem oferta no momento.</p>';
  return barrasComparacao(ofertas
    // A comparação usa o preço que sai de verdade: com cupom, a segunda
    // colocada vira a primeira, e é isso que precisa aparecer.
    .map(o => ({
      rotulo: o.lojaNome + (o.precoComDesconto ? ' · com desconto' : ''),
      valor: o.precoEfetivo ?? o.preco,
      detalhe: detalheDaOferta(o),
      titulo: horaDaLeitura(o)
    }))
    .sort((a, b) => a.valor - b.valor));
}

// A linha fina de cada loja na comparação: como se paga aquele preço e quando
// ele foi visto. Sem isso, comparar R$ 17.299 no Pix com R$ 19.349 em 12x é
// comparar coisas diferentes.
function detalheDaOferta(oferta) {
  const partes = [];
  if (oferta.condicao) partes.push(oferta.condicao);
  if (oferta.parcelamento?.vezes) {
    partes.push(`${oferta.parcelamento.vezes}x de ${formatMoney(oferta.parcelamento.valor)}${oferta.parcelamento.semJuros ? ' sem juros' : ''}`);
  }
  if (oferta.precoComDesconto && oferta.comoChegou) partes.push(oferta.comoChegou);
  const visto = oferta.precoConferidoNaPagina || oferta.atualizadoEm;
  if (visto) partes.push(`visto ${formatRelativo(visto)}${idadePreocupante(visto) ? ' · pode ter mudado' : ''}`);
  return partes.join(' · ');
}

function horaDaLeitura(oferta) {
  const visto = oferta.precoConferidoNaPagina || oferta.atualizadoEm;
  if (!visto) return '';
  return oferta.precoConferidoNaPagina
    ? `Preço conferido na página do anúncio em ${formatDataHora(visto)}`
    : `Preço lido na busca da loja em ${formatDataHora(visto)}`;
}

// Mais de duas horas sem conferir já merece ressalva na tela.
function idadePreocupante(iso) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > 2 * 60 * 60 * 1000;
}

// "com cupom de 10%", "à vista no Pix", ou os dois juntos.
function rotuloDesconto(oferta) {
  const partes = [];
  if (oferta.cupom) {
    partes.push(oferta.cupom.tipo === 'percentual'
      ? `com cupom de ${oferta.cupom.valor}%`
      : `com cupom de ${formatMoney(oferta.cupom.valor)}`);
  }
  if (oferta.descontoAVista) {
    partes.push(`${oferta.descontoAVista.percentual}% ${oferta.descontoAVista.forma === 'pix' ? 'no Pix' : 'à vista'}`);
  }
  return partes.join(' + ') || 'com desconto';
}

function produtoCartao(p) {
  const ofertas = [...(p.ofertas || [])].sort((a, b) => (a.preco ?? Infinity) - (b.preco ?? Infinity));
  const precos = ofertas.map(o => o.preco).filter(v => v != null);
  const maisCara = precos.length ? Math.max(...precos) : null;
  const menorAtual = p.resumo?.menorAtual;
  // No primeiro dia de uso ainda não existe histórico de 24h — aí vale a
  // variação desde a leitura anterior, que é o que a rodada acabou de medir.
  const variacao = p.resumo?.variacao24h != null ? p.resumo.variacao24h : p.resumo?.variacaoUltima;
  const variacaoRotulo = p.resumo?.variacao24h != null ? 'Variação 24h' : 'Desde a última leitura';
  const varClasse = variacao < 0 ? 'kf-diff-queda' : variacao > 0 ? 'kf-diff-alta' : '';
  // O cartão foi refeito para ser lido de relance: imagem, preço grande, a
  // curva do preço e as lojas em barras. Tabela e frases explicativas saíram —
  // o que precisa ser dito, o desenho diz.
  const noMinimo = p.resumo?.distanciaDoMinimo != null && p.resumo.distanciaDoMinimo <= 0;
  // O botão leva à loja do MELHOR preço real, não à do menor preço anunciado.
  // O preço com cupom/Pix é o que sai de verdade — a loja anuncia sem ele.
  // O destaque do cartão passa a ser esse preço: é o que você pagaria hoje,
  // na melhor loja, e é a pergunta que traz alguém a um caça-promoção.
  const comDesconto = ofertas.find(o => o.precoComDesconto) || null;
  const porEfetivo = [...ofertas].filter(o => o.preco != null)
    .sort((a, b) => (a.precoEfetivo ?? a.preco) - (b.precoEfetivo ?? b.preco));
  const melhor = porEfetivo[0] || null;
  const melhorOferta = melhor
    ? {
        valor: melhor.precoEfetivo ?? melhor.preco,
        loja: melhor.lojaNome,
        precoComDesconto: Boolean(melhor.precoComDesconto),
        precoAnunciado: melhor.preco
      }
    : { valor: menorAtual, loja: p.resumo?.lojaMaisBarata, precoComDesconto: false, precoAnunciado: menorAtual };

  // O cartão responde uma pergunta só: quanto custa, na loja mais barata. A
  // comparação entre lojas, o gráfico e o histórico moram no modal — na grade
  // eles empilhavam texto e faziam três cartões parecerem uma planilha.
  return `<article class="kf-card kf-produto-cartao" data-id="${p.id}"
    data-action="produtos.abrir" role="button" tabindex="0"
    aria-label="Ver detalhes de ${escapeHtml(p.nome)}">
    <button type="button" class="kf-btn-icone kf-produto-menu" data-action="produtos.arquivar.toggle" data-id="${p.id}"
      aria-label="${p.arquivado ? 'Desarquivar' : 'Arquivar'} ${escapeHtml(p.nome)}" title="${p.arquivado ? 'Desarquivar' : 'Arquivar'}">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 5h18v4H3V5zm2 6h14v8H5v-8zm4 2v2h6v-2H9z"/></svg>
    </button>

    <div class="kf-produto-cabeca">
      ${p.imagem
        ? `<img class="kf-produto-imagem" src="${escapeHtml(p.imagem)}" alt="" loading="lazy">`
        : '<div class="kf-produto-imagem kf-produto-imagem--vazia" aria-hidden="true"></div>'}
      <div class="kf-produto-numeros">
        <div class="kf-preco-grande ${noMinimo || melhorOferta.precoComDesconto ? 'kf-preco--minimo' : ''}">${formatMoney(melhorOferta.valor)}</div>
        <div class="kf-produto-legenda">
          ${escapeHtml(melhorOferta.loja || 'sem oferta')}
          ${melhorOferta.precoComDesconto ? ` · <span class="kf-primaria">${escapeHtml(rotuloDesconto(comDesconto))}</span>` : ''}
          ${variacao != null && Math.abs(variacao) >= 0.05 ? ` · <span class="${varClasse}">${formatPercent(variacao)}</span>` : ''}
        </div>
        ${melhorOferta.precoComDesconto
          ? `<div class="kf-preco-riscado" title="Preço anunciado, sem o desconto">${formatMoney(melhorOferta.precoAnunciado)} anunciado</div>`
          : ''}
        ${condicoesDeCompra(melhor)}
        ${noMinimo
          ? '<div class="kf-produto-selo"><span class="kf-selo-minimo">menor preço já visto</span></div>'
          : (p.resumo?.menorHistorico != null
              ? `<div class="kf-produto-legenda">menor já visto ${formatMoney(p.resumo.menorHistorico)}</div>`
              : '')}
      </div>
    </div>

    <h3 class="kf-produto-nome">${escapeHtml(p.nome)}</h3>
    <div class="kf-produto-tags">
      ${p.marca ? `<span class="kf-chip kf-chip--marca">${escapeHtml(p.marca)}</span>` : ''}
      ${(p.specs || []).slice(0, 3).map(s => `<span class="kf-chip">${escapeHtml(s)}</span>`).join('')}
    </div>

    ${p.resumo?.avaliacao
      ? `<div class="kf-avaliacao kf-avaliacao-${p.resumo.avaliacao.classificacao}" title="Comparado com ${p.resumo.avaliacao.leituras} leituras deste produto">${escapeHtml(p.resumo.avaliacao.texto)}</div>`
      : ''}

    ${(p.serie || []).length > 1
      // Resumo dos últimos dias: responde "está caindo ou subindo?" de relance.
      // O gráfico completo continua no clique, com eixo e datas.
      ? `<div class="kf-produto-curva" title="Preço mínimo por dia — clique para o gráfico completo">
          ${sparkline(p.serie, { largura: 240, altura: 52, comArea: true })}
          <span class="kf-produto-legenda">últimos ${p.serie.length} dias</span>
        </div>`
      : ''}

    <div class="kf-cartao-acoes">
      ${melhor && melhor.url ? `<a class="kf-btn kf-btn-primaria kf-btn-pequeno" href="${escapeHtml(melhor.urlSaida || melhor.url)}" target="_blank" rel="noopener noreferrer">Abrir na ${escapeHtml(melhor.lojaNome)}</a>` : ''}
      ${ofertas.length > 1 ? `<span class="kf-produto-legenda kf-cartao-dica">+${ofertas.length - 1} ${ofertas.length === 2 ? 'outra loja' : 'outras lojas'}</span>` : ''}
    </div>
  </article>`;
}

// ações — Produtos
/**
 * Nem toda loja tem busca que presta — a Go Imports responde "macbook air m5"
 * com os mais vendidos, e o MacBook Air que ela vende por R$ 8.599 nunca
 * aparecia. Quando você já tem o link, você sabe mais que a busca da loja.
 */
async function adicionarLinkDeLoja(id) {
  const url = prompt('Cole o link do anúncio nessa outra loja:');
  if (!url) return;
  mostrarToast('Abrindo a página do anúncio…');
  try {
    const r = await api.adicionarLink(id, url.trim());
    mostrarToast(`${r.loja}: ${formatMoney(r.preco)}${r.condicao ? ' ' + r.condicao : ''}`, 'ok');
    await carregarEstado();
  } catch (e) { mostrarToast(e.message, 'erro'); }
}

async function toggleArquivarProduto(id) {
  const p = state.produtos.find(x => x.id === id);
  if (!p) return;
  try {
    const { produto } = await api.atualizarProduto(id, { arquivado: !p.arquivado });
    state.produtos = state.produtos.map(x => (x.id === id ? produto : x));
  } catch (e) { mostrarToast(e.message, 'erro'); }
  render();
}

// gráfico de histórico de preços (SVG puro)
const PALETA_GRAFICO = ['#7CB342', '#8D6E4A', '#D2544B', '#E8A33D', '#2E9E5B', '#5c8a2c', '#b98a5a', '#4c6b8a'];
function construirGraficoHistorico(pontos, precoDesejado) {
  const porLoja = new Map();
  pontos.forEach(pt => {
    if (!porLoja.has(pt.lojaId)) porLoja.set(pt.lojaId, { nome: pt.lojaNome, pontos: [] });
    porLoja.get(pt.lojaId).pontos.push(pt);
  });
  porLoja.forEach(g => g.pontos.sort((a, b) => new Date(a.ts) - new Date(b.ts)));

  const todosTs = pontos.map(p => new Date(p.ts).getTime());
  const todosPrecos = pontos.map(p => p.preco).filter(v => v != null);
  if (precoDesejado != null) todosPrecos.push(precoDesejado);
  const tsMin = Math.min(...todosTs), tsMax = Math.max(...todosTs);
  const precoMin = Math.min(...todosPrecos), precoMax = Math.max(...todosPrecos);
  const margem = (precoMax - precoMin) * 0.12 || precoMax * 0.12 || 10;
  const yMin = Math.max(0, precoMin - margem), yMax = precoMax + margem;

  const L = 56, R = 20, T = 16, B = 30, W = 760, H = 300;
  const areaW = W - L - R, areaH = H - T - B;
  const escalaX = ts => (tsMax === tsMin ? L + areaW / 2 : L + ((ts - tsMin) / (tsMax - tsMin)) * areaW);
  const escalaY = preco => (yMax === yMin ? T + areaH / 2 : T + areaH - ((preco - yMin) / (yMax - yMin)) * areaH);

  let idxCor = 0;
  const cores = new Map();
  const linhas = [], pontosSvg = [];
  porLoja.forEach((grupo, lojaId) => {
    const c = PALETA_GRAFICO[idxCor % PALETA_GRAFICO.length]; idxCor++;
    cores.set(lojaId, c);
    const coordStr = grupo.pontos.map(p => `${escalaX(new Date(p.ts).getTime())},${escalaY(p.preco)}`).join(' ');
    linhas.push(`<polyline points="${coordStr}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    grupo.pontos.forEach(p => {
      pontosSvg.push(`<circle cx="${escalaX(new Date(p.ts).getTime())}" cy="${escalaY(p.preco)}" r="4" fill="${c}" stroke="var(--kf-cor-superficie)" stroke-width="1.5" data-loja="${escapeHtml(grupo.nome)}" data-preco="${formatMoney(p.preco)}" data-ts="${formatDataHora(p.ts)}"/>`);
    });
  });

  const marcasY = [];
  for (let i = 0; i <= 3; i++) {
    const valor = yMin + (yMax - yMin) * (i / 3);
    const y = escalaY(valor);
    marcasY.push(`<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="var(--kf-cor-borda)" stroke-width="1"/><text x="${L - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--kf-cor-texto-suave)">${formatMoneyCompacto(valor)}</text>`);
  }
  const marcasX = [];
  for (let i = 0; i <= 4; i++) {
    const ts = tsMin + (tsMax - tsMin) * (i / 4);
    marcasX.push(`<text x="${escalaX(ts)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--kf-cor-texto-suave)">${formatDataCurta(ts)}</text>`);
  }
  let linhaDesejado = '';
  if (precoDesejado != null) {
    const y = escalaY(precoDesejado);
    linhaDesejado = `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="var(--kf-alerta)" stroke-width="1.5" stroke-dasharray="5,4"/><text x="${W - R}" y="${y - 6}" text-anchor="end" font-size="10" fill="var(--kf-alerta)" font-weight="700">Preço desejado: ${formatMoney(precoDesejado)}</text>`;
  }
  const legenda = [...porLoja.entries()].map(([lojaId, grupo]) => `<span class="kf-grafico-legenda-item"><span class="kf-grafico-legenda-cor" style="background:${cores.get(lojaId)}"></span>${escapeHtml(grupo.nome)}</span>`).join('');

  return `
    <div class="kf-grafico-legenda">${legenda}</div>
    <div class="kf-grafico-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Gráfico de histórico de preços" id="kf-grafico-svg">
        ${marcasY.join('')}${linhaDesejado}${linhas.join('')}${pontosSvg.join('')}${marcasX.join('')}
      </svg>
      <div class="kf-grafico-tooltip" id="kf-grafico-tooltip"></div>
    </div>`;
}
// O gráfico novo expõe uma faixa invisível por dia (.kf-grafico-alvo) com os
// dados no próprio elemento — então o tooltip segue o dia inteiro, e não só o
// pixel exato do ponto.
function ativarTooltipGrafico(container) {
  const wrap = container.querySelector('.kf-grafico-wrap');
  if (!wrap) return;
  const alvos = wrap.querySelectorAll('.kf-grafico-alvo');
  if (!alvos.length) return;

  let tooltip = wrap.querySelector('.kf-grafico-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'kf-grafico-tooltip';
    tooltip.hidden = true;
    wrap.appendChild(tooltip);
  }

  const mostrar = (alvo) => {
    const r = alvo.getBoundingClientRect();
    const rw = wrap.getBoundingClientRect();
    const { dia, min, max, loja } = alvo.dataset;
    const faixa = max && Number(max) - Number(min) > 0.01
      ? `<br><span style="opacity:.7">até ${formatMoney(Number(max))}</span>`
      : '';
    tooltip.innerHTML = `<strong>${formatMoney(Number(min))}</strong>${loja ? ` · ${escapeHtml(loja)}` : ''}${faixa}<br><span style="opacity:.7">${escapeHtml(formatDiaLongo(dia))}</span>`;
    tooltip.hidden = false;
    tooltip.style.left = `${r.left - rw.left + r.width / 2}px`;
    tooltip.style.top = `${Math.max(30, r.top - rw.top + 26)}px`;
  };

  alvos.forEach(alvo => {
    alvo.addEventListener('mouseenter', () => mostrar(alvo));
    alvo.addEventListener('focus', () => mostrar(alvo));
    alvo.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    alvo.addEventListener('blur', () => { tooltip.hidden = true; });
  });
  wrap.addEventListener('mouseleave', () => { tooltip.hidden = true; });
}

function formatDiaLongo(iso) {
  if (!iso) return '';
  const [ano, mes, dia] = String(iso).split('-');
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${dia} de ${meses[Number(mes) - 1] || mes} de ${ano}`;
}
/**
 * Ficha do produto: foto grande à esquerda, identidade e preços à direita — o
 * mesmo desenho do cartão, com espaço para o que não cabe nele. O gráfico e a
 * comparação entre lojas vêm abaixo, em largura cheia.
 *
 * `voltarPara` guarda o grupo de onde a pessoa veio: entrando por uma família,
 * fechar tem que devolver para a família, não para a grade inteira.
 */
async function abrirModalProduto(id) {
  const produto = (state.produtos || []).find(p => p.id === id);
  if (!produto) return;
  const voltarPara = ui.grupoAberto;

  const ofertas = [...(produto.ofertas || [])].filter(o => o.preco != null)
    .sort((a, b) => (a.precoEfetivo ?? a.preco) - (b.precoEfetivo ?? b.preco));
  const melhor = ofertas[0] || null;
  const comDesconto = ofertas.find(o => o.precoComDesconto) || null;
  const noMinimo = produto.resumo?.distanciaDoMinimo != null && produto.resumo.distanciaDoMinimo <= 0;
  const valor = melhor ? (melhor.precoEfetivo ?? melhor.preco) : produto.resumo?.menorAtual;

  abrirModal({
    titulo: produto.nome,
    tamanho: 'xl',
    voltarPara,
    corpoHtml: `
      <div class="kf-ficha">
        <div class="kf-ficha-figura">
          ${produto.imagem
            ? `<img src="${escapeHtml(produto.imagem)}" alt="" loading="lazy">`
            : '<div class="kf-ficha-sem-foto" aria-hidden="true"></div>'}
        </div>
        <div class="kf-ficha-info">
          <div class="kf-produto-tags">
            ${produto.marca ? `<span class="kf-chip kf-chip--marca">${escapeHtml(produto.marca)}</span>` : ''}
            ${(produto.specs || []).slice(0, 6).map(sp => `<span class="kf-chip">${escapeHtml(sp)}</span>`).join('')}
          </div>
          <div class="kf-preco-grande ${noMinimo || melhor?.precoComDesconto ? 'kf-preco--minimo' : ''}">${formatMoney(valor)}</div>
          <div class="kf-produto-legenda">
            ${escapeHtml(melhor?.lojaNome || 'sem oferta')}
            ${melhor?.precoComDesconto ? ` · <span class="kf-primaria">${escapeHtml(rotuloDesconto(comDesconto))}</span>` : ''}
          </div>
          ${melhor?.precoComDesconto
            ? `<div class="kf-preco-riscado" title="Preço anunciado, sem o desconto">${formatMoney(melhor.preco)} anunciado</div>`
            : ''}
          ${condicoesDeCompra(melhor)}
          ${noMinimo
            ? '<div class="kf-produto-selo"><span class="kf-selo-minimo">menor preço já visto</span></div>'
            : (produto.resumo?.menorHistorico != null
                ? `<div class="kf-produto-legenda">menor já visto ${formatMoney(produto.resumo.menorHistorico)}</div>`
                : '')}
          ${produto.resumo?.avaliacao
            ? `<div class="kf-avaliacao kf-avaliacao-${produto.resumo.avaliacao.classificacao}" title="Comparado com ${produto.resumo.avaliacao.leituras} leituras deste produto">${escapeHtml(produto.resumo.avaliacao.texto)}</div>`
            : ''}
          ${melhor?.url
            ? `<div class="kf-ficha-acao"><a class="kf-btn kf-btn-primaria" href="${escapeHtml(melhor.urlSaida || melhor.url)}" target="_blank" rel="noopener noreferrer">Abrir na ${escapeHtml(melhor.lojaNome)}</a></div>`
            : ''}
        </div>
      </div>

      <h3 class="kf-ficha-secao">Onde comprar</h3>
      ${comparacaoDeLojas(produto)}

      <h3 class="kf-ficha-secao">Preço por dia</h3>
      <div id="kf-historico-corpo"><p class="kf-texto-suave">Carregando histórico…</p></div>`,
    // Colar link de loja é ação de manutenção, não de navegação: fica aqui
    // dentro, longe da grade.
    rodapeHtml: `<button type="button" class="kf-btn kf-btn-fantasma kf-btn-pequeno" data-action="produtos.link" data-id="${produto.id}"
      title="Achou este produto em outra loja que o app não enxerga? Cole o link do anúncio.">Adicionar link de loja</button>`
  });

  try {
    // O gráfico é do MENOR preço por dia — é a pergunta que interessa
    // ("quando valeu a pena comprar?"), e não uma linha por loja.
    const resposta = await apiFetch(`/produtos/${id}/serie?dias=90`);
    const serie = resposta.serie || [];
    const corpoEl = document.getElementById('kf-historico-corpo');
    if (!corpoEl) return;
    if (serie.length < 2) {
      corpoEl.innerHTML = '<div class="kf-vazio"><strong>Sem histórico ainda</strong>O gráfico aparece depois de alguns dias de leitura.</div>';
      return;
    }
    const menor = serie.reduce((a, b) => (b.min < a.min ? b : a));
    corpoEl.innerHTML = `
      <div class="kf-modal-numeros">
        <div><span class="kf-modal-numero kf-primaria">${formatMoney(menor.min)}</span><span class="kf-produto-legenda">menor já visto · ${escapeHtml(menor.dia.split('-').reverse().slice(0, 2).join('/'))}</span></div>
        <div><span class="kf-modal-numero">${serie.length}</span><span class="kf-produto-legenda">${serie.length === 1 ? 'dia acompanhado' : 'dias acompanhados'}</span></div>
      </div>
      ${produto.resumo?.menorHistorico != null
        ? faixaDePreco(produto.resumo.menorAtual, produto.resumo.menorHistorico, Math.max(...(produto.serie || [produto.resumo.menorAtual])))
        : ''}
      ${graficoPrecoDiario(serie, { precoDesejado: produto.precoDesejado })}`;
    ativarTooltipGrafico(corpoEl);
  } catch (e) {
    const corpoEl = document.getElementById('kf-historico-corpo');
    if (corpoEl) corpoEl.innerHTML = `<div class="kf-erro-rede">Não consegui carregar o histórico: ${escapeHtml(e.message)}</div>`;
  }
}

// ----------------------------------------------------------------------------
// TELA: Oportunidades
// ----------------------------------------------------------------------------
function renderOportunidades() {
  const tipos = ['minimo_historico', 'queda', 'melhor_entre_lojas', 'abaixo_do_objetivo'];
  let lista = [...(state.oportunidades || [])].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  if (ui.oportunidadesFiltroTipo !== 'todas') lista = lista.filter(o => o.tipo === ui.oportunidadesFiltroTipo);
  const naoLidas = (state.oportunidades || []).filter(o => !o.lida).length;
  return `
  <div class="kf-tela-cabecalho">
    <div><h1 class="kf-tela-titulo">Oportunidades</h1><p class="kf-tela-subtitulo">Tudo que encontramos de interessante, em ordem cronológica.</p></div>
    ${naoLidas ? `<button type="button" class="kf-btn kf-btn-secundaria" data-action="oportunidades.lidas.todas">Marcar todas como lidas</button>` : ''}
  </div>
  <div class="kf-filtros">
    <select class="kf-select" data-action="oportunidades.filtro" style="max-width:220px;">
      <option value="todas" ${ui.oportunidadesFiltroTipo === 'todas' ? 'selected' : ''}>Todos os tipos</option>
      ${tipos.map(t => `<option value="${t}" ${ui.oportunidadesFiltroTipo === t ? 'selected' : ''}>${rotuloTipoOportunidade(t)}</option>`).join('')}
    </select>
  </div>
  ${lista.length ? `<div class="kf-timeline">${lista.map(timelineItem).join('')}</div>` : `<div class="kf-vazio"><strong>Nenhuma oportunidade por aqui</strong>Assim que encontrarmos alguma, ela aparece nesta linha do tempo.</div>`}
  `;
}
async function marcarOportunidadeLida(id) {
  try {
    await api.marcarOportunidadeLida(id);
    state.oportunidades = state.oportunidades.map(o => (o.id === id ? { ...o, lida: true } : o));
  } catch (e) { mostrarToast(e.message, 'erro'); }
  render();
}
async function marcarTodasOportunidadesLidas() {
  try {
    await api.marcarTodasLidas();
    state.oportunidades = state.oportunidades.map(o => ({ ...o, lida: true }));
    mostrarToast('Todas as oportunidades foram marcadas como lidas.', 'sucesso');
  } catch (e) { mostrarToast(e.message, 'erro'); }
  render();
}

// ----------------------------------------------------------------------------
// TELA: Ajustes
// ----------------------------------------------------------------------------
function renderAjustes() {
  const cfg = state.config || {};
  const horarios = cfg.horarios || ['08:30', '20:30'];
  return `
  <div class="kf-tela-cabecalho"><div><h1 class="kf-tela-titulo">Ajustes</h1><p class="kf-tela-subtitulo">Como e quando o KiwiFinder procura por você. Os padrões funcionam bem — mexa só se algo estiver incomodando.</p></div></div>
  <form class="kf-card" data-action-submit="ajustes.salvar">
    <div class="kf-ajustes-linha">
      <div class="kf-ajustes-linha-texto"><strong>Agendador automático</strong><span>Roda as buscas sozinho, nos dois horários definidos abaixo.</span></div>
      <span class="kf-switch"><input type="checkbox" name="agendadorAtivo" ${cfg.agendadorAtivo ? 'checked' : ''}><span class="kf-switch-trilho"></span></span>
    </div>
    <div class="kf-ajustes-grade kf-mt-16">
      <label class="kf-campo"><span class="kf-campo-rotulo">Primeiro horário</span><input type="time" name="horario1" class="kf-input" value="${horarios[0] || '08:30'}"></label>
      <label class="kf-campo"><span class="kf-campo-rotulo">Segundo horário</span><input type="time" name="horario2" class="kf-input" value="${horarios[1] || '20:30'}"></label>
      <label class="kf-campo"><span class="kf-campo-rotulo">Máximo de produtos por busca</span><input type="number" min="1" name="tetoPorConsulta" class="kf-input" value="${cfg.tetoPorConsulta ?? 20}"><span class="kf-campo-ajuda">Evita que uma busca aberta encha a tela.</span></label>
      <label class="kf-campo"><span class="kf-campo-rotulo">Rigor ao reconhecer o produto</span><input type="number" min="0" max="100" name="limiarAceite" class="kf-input" value="${cfg.limiarAceite ?? 70}"><span class="kf-campo-ajuda">0 a 100. Mais alto traz menos resultado e mais certeza.</span></label>
      <label class="kf-campo"><span class="kf-campo-rotulo">Queda mínima para avisar</span><input type="number" min="0" max="100" name="quedaRelevante" class="kf-input" value="${cfg.quedaRelevante ?? 5}"><span class="kf-campo-ajuda">Em %. Abaixo disso, a variação passa em silêncio.</span></label>
      <label class="kf-campo"><span class="kf-campo-rotulo">Páginas lidas por busca</span><input type="number" min="1" max="5" name="paginasPorBusca" class="kf-input" value="${cfg.paginasPorBusca ?? 1}"><span class="kf-campo-ajuda">Mais páginas, mais cobertura e mais tempo.</span></label>
      <label class="kf-campo"><span class="kf-campo-rotulo">Tema</span>
        <select class="kf-select" data-action="ajustes.tema">
          <option value="claro" ${ui.tema === 'claro' ? 'selected' : ''}>Claro</option>
          <option value="escuro" ${ui.tema === 'escuro' ? 'selected' : ''}>Escuro</option>
          <option value="auto" ${ui.tema === 'auto' ? 'selected' : ''}>Automático (sistema)</option>
        </select>
      </label>
    </div>
    <div class="kf-ajustes-linha kf-mt-16">
      <div class="kf-ajustes-linha-texto"><strong>Navegador de verdade para lojas que bloqueiam</strong><span>Algumas lojas recusam requisição comum e só respondem a um navegador. Quando isso acontece, o KiwiFinder abre o Chrome que já existe na sua máquina, com perfil próprio, e lê a página por lá. É mais lento (uns 20s por consulta).</span></div>
      <span class="kf-switch"><input type="checkbox" name="usarNavegador" ${cfg.usarNavegador !== false ? 'checked' : ''}><span class="kf-switch-trilho"></span></span>
    </div>
    <div class="kf-ajustes-linha">
      <div class="kf-ajustes-linha-texto"><strong>Mostrar a janela do navegador</strong><span>Desligado, a janela abre fora da tela e não atrapalha. Ligue só se quiser ver o que ele está fazendo.</span></div>
      <span class="kf-switch"><input type="checkbox" name="navegadorVisivel" ${cfg.navegadorVisivel ? 'checked' : ''}><span class="kf-switch-trilho"></span></span>
    </div>
    <div class="kf-ajustes-linha">
      <div class="kf-ajustes-linha-texto"><strong>Completar a ficha dos produtos novos</strong><span>Abre a página do anúncio uma vez, atrás de EAN/GTIN e ficha técnica. Deixa a identidade do produto à prova de mudança de título.</span></div>
      <span class="kf-switch"><input type="checkbox" name="enriquecerProdutos" ${cfg.enriquecerProdutos !== false ? 'checked' : ''}><span class="kf-switch-trilho"></span></span>
    </div>
    <div class="kf-ajustes-linha">
      <div class="kf-ajustes-linha-texto"><strong>Avisar no computador quando achar oportunidade</strong><span>Notificação do navegador, mesmo com a aba em segundo plano.</span></div>
      <button type="button" class="kf-btn kf-btn-secundaria kf-btn-pequeno" data-action="ajustes.notificacoes">${notificacoesLigadas() ? 'Ativadas' : 'Ativar avisos'}</button>
    </div>
    <div class="kf-mt-16 kf-cartao-acoes">
      <button type="submit" class="kf-btn kf-btn-primaria">Salvar ajustes</button>
      <a class="kf-btn kf-btn-secundaria" href="/api/exportar/historico.csv" download>Baixar histórico em CSV</a>
    </div>
  </form>
  `;
}

function notificacoesLigadas() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}
async function salvarAjustes(form) {
  const dados = new FormData(form);
  const campos = {
    agendadorAtivo: form.querySelector('[name="agendadorAtivo"]').checked,
    horarios: [dados.get('horario1') || '08:30', dados.get('horario2') || '20:30'],
    tetoPorConsulta: Number(dados.get('tetoPorConsulta')),
    limiarAceite: Number(dados.get('limiarAceite')),
    quedaRelevante: Number(dados.get('quedaRelevante')),
    paginasPorBusca: Number(dados.get('paginasPorBusca')) || 1,
    usarNavegador: form.querySelector('[name="usarNavegador"]').checked,
    navegadorVisivel: form.querySelector('[name="navegadorVisivel"]').checked,
    enriquecerProdutos: form.querySelector('[name="enriquecerProdutos"]').checked,
  };
  try {
    const { config } = await api.salvarConfig(campos);
    state.config = config;
    mostrarToast('Ajustes salvos.', 'sucesso');
  } catch (e) { mostrarToast(e.message, 'erro'); }
  render();
}

// ----------------------------------------------------------------------------
// Ação global: rodar tudo agora (Painel)
// ----------------------------------------------------------------------------
async function rodarTudo() {
  ui.rodadaEmAndamento = true;
  ui.rodadaProgresso = null;
  render();
  try {
    await api.rodarTudo();
  } catch (e) {
    mostrarToast(e.message, 'erro');
    ui.rodadaEmAndamento = false;
    ui.rodadaProgresso = null;
    render();
    return;
  }
  // A conclusão real chega via SSE ("atualizado"). Como salvaguarda, encerramos
  // o estado de "atualizando" após um tempo mesmo sem confirmação, para o botão
  // nunca ficar travado caso a conexão em tempo real falhe.
  clearTimeout(rodadaSalvaguardaTimer);
  rodadaSalvaguardaTimer = setTimeout(() => {
    if (ui.rodadaEmAndamento) { ui.rodadaEmAndamento = false; ui.rodadaProgresso = null; render(); }
  }, 65000);
}

// ----------------------------------------------------------------------------
// Delegação de eventos (click, change, input, submit)
// ----------------------------------------------------------------------------
function handleClick(e) {
  const temaBtn = e.target.closest('.kf-tema-btn');
  if (temaBtn) { setTema(temaBtn.dataset.tema); return; }

  // Clique fora fecha o menu da conta.
  if (!e.target.closest('.kf-conta')) alternarContaMenu(true);

  // Link de verdade (ir para a loja) manda mais que o clique do cartão em
  // volta dele: sem isto, clicar em "Abrir na Amazon" também abria o modal.
  const link = e.target.closest('a[href]');
  if (link && !link.dataset.action) return;

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const acao = el.dataset.action;
  const id = el.dataset.id;
  switch (acao) {
    case 'sidebar.alternar': alternarSidebar(); return;
    case 'conta.alternar': alternarContaMenu(); return;
    case 'conta.fechar': alternarContaMenu(true); return;
    case 'app.tentarNovamente': recarregarTudo(); break;
    case 'painel.atualizar': rodarTudo(); break;
    case 'lojas.testar': iniciarDiagnostico(document.getElementById('kf-loja-entrada')?.value); break;
    case 'lojas.biblioteca.testar': iniciarDiagnostico(el.dataset.host); break;
    case 'lojas.cadastrar': cadastrarLoja(); break;
    case 'lojas.descartar': descartarDiagnostico(); break;
    case 'lojas.retestar': retestarLoja(id); break;
    case 'lojas.diagnostico': abrirModalDiagnostico(id); break;
    case 'lojas.seletores': abrirModalSeletores(id); break;
    case 'lojas.escopo': abrirModalEscopo(id); break;
    case 'escopo.salvar': salvarEscopo(id); break;
    case 'seletores.testar': testarSeletores(id); break;
    case 'seletores.salvar': salvarSeletores(id); break;
    case 'seletores.limpar': salvarSeletores(id, true); break;
    case 'lojas.excluir': excluirLojaConfirmar(id); break;
    case 'consultas.rodar': rodarConsulta(id); break;
    case 'consultas.excluir': excluirConsultaConfirmar(id); break;
    case 'produtos.abrir': abrirModalProduto(id); break;
    case 'produtos.arquivar.toggle': toggleArquivarProduto(id); break;
    case 'produtos.link': adicionarLinkDeLoja(id); break;
    case 'produtos.grupo': abrirModalGrupo(id); break;
    case 'modal.voltar': abrirModalGrupo(id); break;
    case 'oportunidades.lida': marcarOportunidadeLida(id); break;
    case 'oportunidades.lidas.todas': marcarTodasOportunidadesLidas(); break;
    case 'modal.fechar': fecharModal(); break;
    case 'modal.overlay': if (e.target.classList.contains('kf-modal-overlay')) fecharModal(); break;
    case 'confirmar.sim': if (confirmarCallback) { const cb = confirmarCallback; confirmarCallback = null; fecharModal(); cb(); } break;
  }
}
function handleChange(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const acao = el.dataset.action;
  const id = el.dataset.id;
  switch (acao) {
    case 'lojas.toggle': toggleLoja(id, el.checked); break;
    case 'consultas.toggle': toggleConsulta(id, el.checked); break;
    case 'consultas.preco.salvar': salvarPrecoConsulta(id, el.value); break;
    case 'produtos.filtro': ui.produtosFiltroConsulta = el.value; render(); break;
    case 'produtos.ordenar': ui.produtosOrdenar = el.value; render(); break;
    case 'produtos.mostrarArquivados': ui.produtosMostrarArquivados = el.checked; render(); break;
    case 'oportunidades.filtro': ui.oportunidadesFiltroTipo = el.value; render(); break;
    case 'ajustes.tema': setTema(el.value); break;
    case 'ajustes.notificacoes': pedirPermissaoDeAviso(); break;
  }
}
const debouncedRenderProdutos = debounce(() => renderPreservandoFoco(), 250);
function handleInput(e) {
  const el = e.target.closest('[data-action-input]');
  if (!el) return;
  const acao = el.dataset.actionInput;
  if (acao === 'consultas.digitar') {
    ui.consultaRascunho.texto = el.value;
    if (!el.value.trim()) {
      ui.consultaRascunho.interpretacao = null;
      ui.consultaRascunho.aceita = null;
      ui.consultaRascunho.motivo = null;
      return;
    }
    debouncedInterpretar(el.value);
  } else if (acao === 'consultas.preco.digitar') {
    ui.consultaRascunho.precoDesejado = el.value;
  } else if (acao === 'produtos.busca') {
    ui.produtosBusca = el.value;
    debouncedRenderProdutos();
  }
}
function handleSubmit(e) {
  const form = e.target.closest('[data-action-submit]');
  if (!form) return;
  e.preventDefault();
  const acao = form.dataset.actionSubmit;
  if (acao === 'consultas.criar') criarConsulta();
  else if (acao === 'ajustes.salvar') salvarAjustes(form);
}

// ----------------------------------------------------------------------------
// Inicialização
// ----------------------------------------------------------------------------
async function init() {
  aplicarTema();
  aplicarSidebar();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') alternarContaMenu(true); });
  // Bloco com role="button" (cartão de grupo, minicurva) precisa responder a
  // Enter e espaço como um botão de verdade — o clique sozinho deixa quem
  // navega por teclado sem acesso.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const alvo = e.target.closest?.('[role="button"][data-action]');
    if (!alvo) return;
    e.preventDefault();
    alvo.click();
  });
  document.addEventListener('click', handleClick);
  document.addEventListener('change', handleChange);
  document.addEventListener('input', handleInput);
  document.addEventListener('submit', handleSubmit);
  localStorage.setItem('kiwifinder.tema', ui.tema);
  window.addEventListener('hashchange', render);

  conectarSSE();
  await carregarEstado();
  ui.carregandoInicial = false;
  if (!location.hash) location.hash = '#/painel';
  render();
}
init();
