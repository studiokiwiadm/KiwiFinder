// ============================================================================
// KIWIFINDER — graficos.js
// Módulo de funções PURAS: recebem dados e devolvem string de SVG/HTML.
// Sem DOM, sem fetch, sem framework, sem estado. Só usam variáveis CSS do
// tema (--kf-*) para cor, então funcionam em claro/escuro sem alteração.
// ============================================================================

// ---------------------------------------------------------------- utilidades

// Escapa qualquer texto vindo dos dados antes de entrar no SVG/HTML — vale
// tanto para conteúdo de texto quanto para valores de atributo.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Arredonda coordenadas para 2 casas — deixa o markup do SVG mais enxuto sem
// perder precisão visual.
function n2(v) {
  return Math.round(v * 100) / 100;
}

// Preço completo em pt-BR, com centavos — usado nos rótulos de destaque
// (menor preço da série, barras de comparação), onde a precisão importa.
function formatarMoedaCompleta(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

// Tira o ",0" de compactações redondas (ex.: "2,0 mil" → "2 mil").
function formatarCompacto(n) {
  const s = n.toFixed(1);
  return (s.endsWith('.0') ? s.slice(0, -2) : s).replace('.', ',');
}

/**
 * "R$ 2,3 mil" / "R$ 240" / "R$ 1,2 mi" — formato compacto pt-BR, sem centavos.
 * Usado nos eixos, onde espaço é curto e precisão exata não importa.
 */
export function formatarMoedaCurta(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const sinal = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sinal}R$ ${formatarCompacto(abs / 1_000_000)} mi`;
  if (abs >= 1000) return `${sinal}R$ ${formatarCompacto(abs / 1000)} mil`;
  return `${sinal}R$ ${Math.round(abs).toLocaleString('pt-BR')}`;
}

/**
 * "12/ago" a partir de um ISO "AAAA-MM-DD" (ou datetime completo — só os
 * primeiros 10 caracteres importam). Mês abreviado em português, minúsculo.
 */
export function formatarDiaCurto(iso) {
  if (!iso) return '';
  const partes = String(iso).slice(0, 10).split('-');
  if (partes.length !== 3) return '';
  const [, mesStr, diaStr] = partes;
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const mesIdx = Number(mesStr) - 1;
  if (!Number.isInteger(mesIdx) || mesIdx < 0 || mesIdx > 11) return '';
  return `${diaStr}/${meses[mesIdx]}`;
}

// Converte uma sequência de pontos {x,y} em segmentos de bezier cúbica que
// reproduzem uma curva Catmull-Rom uniforme passando por todos eles — é o
// jeito padrão de desenhar uma linha suave (sem serrilhado) através de N
// pontos em SVG, que só entende bezier nativamente. Cada segmento liga
// pontos[i] a pontos[i+1]; os pontos vizinhos (clampados nas pontas) dão o
// tom da tangente.
function segmentosCatmullRom(pontos) {
  const n = pontos.length;
  const segmentos = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pontos[Math.max(i - 1, 0)];
    const p1 = pontos[i];
    const p2 = pontos[i + 1];
    const p3 = pontos[Math.min(i + 2, n - 1)];
    segmentos.push({
      x0: p1.x, y0: p1.y,
      cp1x: p1.x + (p2.x - p0.x) / 6, cp1y: p1.y + (p2.y - p0.y) / 6,
      cp2x: p2.x - (p3.x - p1.x) / 6, cp2y: p2.y - (p3.y - p1.y) / 6,
      x1: p2.x, y1: p2.y,
    });
  }
  return segmentos;
}
function pathSuaveAvancando(pontos, segmentos) {
  return `M ${n2(pontos[0].x)},${n2(pontos[0].y)} ` +
    segmentos.map(s => `C ${n2(s.cp1x)},${n2(s.cp1y)} ${n2(s.cp2x)},${n2(s.cp2y)} ${n2(s.x1)},${n2(s.y1)}`).join(' ');
}
// Mesmos segmentos, percorridos do fim para o começo — usado para fechar o
// contorno da faixa min/max sem recalcular uma curva nova.
function pathSuaveVoltando(segmentos) {
  return [...segmentos].reverse()
    .map(s => `C ${n2(s.cp2x)},${n2(s.cp2y)} ${n2(s.cp1x)},${n2(s.cp1y)} ${n2(s.x0)},${n2(s.y0)}`).join(' ');
}

// ------------------------------------------------------- gráfico principal

/**
 * Curva do preço mínimo diário, no estilo Apple: pouca grade, tipografia
 * discreta nos eixos, uma cor de destaque só. Devolve uma <div class="kf-grafico-wrap">
 * contendo o SVG (ou um <div class="kf-vazio"> quando não há dados suficientes).
 *
 * Funciona tanto com 2 dias de histórico quanto com 90: em séries curtas
 * (4 dias ou menos) cada ponto ganha um rótulo de valor, e o marcador de
 * cada dia fica visível — não só o menor preço e o mais recente.
 *
 * @param {Array<{dia:string, min:number, max:number, lojaMin:string, leituras:number, estimado:boolean}>} serie
 * @param {{precoDesejado?:number|null, altura?:number, mostrarFaixa?:boolean, titulo?:string|null}} opcoes
 */
export function graficoPrecoDiario(serie, opcoes = {}) {
  const { precoDesejado = null, altura = 260, mostrarFaixa = true, titulo = null } = opcoes;

  if (!Array.isArray(serie) || serie.length < 2) {
    return '<div class="kf-vazio">Ainda não há dias suficientes para desenhar a curva. Volte depois da próxima rodada.</div>';
  }

  const W = 900, H = altura;
  const L = 58, R = 76, T = 34, B = 28; // margens: espaço para eixo Y (L), rótulo "seu objetivo" (R), rótulo do menor preço (T) e datas (B)
  const areaW = W - L - R, areaH = H - T - B;
  const n = serie.length;
  const band = areaW / n;
  const xAt = i => L + band * (i + 0.5);

  // Domínio do eixo Y: sempre com folga (nunca gruda no valor real) e nunca
  // ancorado em zero — senão a variação do preço, que é o que importa aqui,
  // fica achatada num canto do gráfico.
  let valoresDominio = serie.map(d => d.min);
  if (mostrarFaixa) valoresDominio = valoresDominio.concat(serie.map(d => d.max));
  if (precoDesejado != null && !Number.isNaN(precoDesejado)) valoresDominio = valoresDominio.concat([precoDesejado]);
  const valMin = Math.min(...valoresDominio);
  const valMax = Math.max(...valoresDominio);
  const amplitude = valMax - valMin;
  const folga = amplitude > 0 ? amplitude * 0.08 : (valMax > 0 ? valMax * 0.08 : 10);
  let yMin = valMin - folga;
  const yMax = valMax + folga;
  if (yMin <= 0) yMin = valMin > 0 ? valMin * 0.5 : 0.01;
  const escalaY = v => T + areaH - ((v - yMin) / (yMax - yMin)) * areaH;

  const pontosMin = serie.map((d, i) => ({ x: xAt(i), y: escalaY(d.min) }));
  const pontosMax = serie.map((d, i) => ({ x: xAt(i), y: escalaY(d.max) }));
  const segMin = segmentosCatmullRom(pontosMin);
  const segMax = segmentosCatmullRom(pontosMax);

  // Grade horizontal (no máximo 4 linhas, incluindo os limites do domínio).
  let gradeSvg = '', rotulosYSvg = '';
  for (let i = 0; i <= 3; i++) {
    const valor = yMin + (yMax - yMin) * (i / 3);
    const y = n2(escalaY(valor));
    gradeSvg += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="var(--kf-fio)" stroke-width="1"/>`;
    rotulosYSvg += `<text x="${L - 10}" y="${n2(y + 3.5)}" text-anchor="end" font-size="11" fill="var(--kf-texto-tenue)">${escapeHtml(formatarMoedaCurta(valor))}</text>`;
  }

  // Faixa de referência histórica — o menor e o maior preço já vistos em toda
  // a série, como uma tarja horizontal bem sutil no fundo do gráfico. Dá
  // noção de onde o preço de hoje está dentro do que já se viu, mesmo quando
  // só há 2 ou 3 dias de dados (quando a curva sozinha não diz muita coisa).
  const histMin = Math.min(...serie.map(d => d.min));
  const histMax = Math.max(...serie.map(d => (Number.isFinite(d.max) ? d.max : d.min)));
  let faixaHistoricaSvg = '';
  if (histMax > histMin) {
    const yTopo = n2(escalaY(histMax));
    const yBase = n2(escalaY(histMin));
    const yRotulo = n2(Math.max(yTopo + 12, T + 12));
    faixaHistoricaSvg = `<rect x="${L}" y="${yTopo}" width="${n2(areaW)}" height="${n2(yBase - yTopo)}" fill="var(--kf-texto-suave)" fill-opacity="0.05"/>` +
      `<text x="${L + 6}" y="${yRotulo}" font-size="10" fill="var(--kf-texto-suave)">faixa histórica</text>`;
  }

  // Faixa entre lojas (min↔max do dia) — só quando faz sentido mostrar.
  let faixaSvg = '';
  if (mostrarFaixa && serie.some(d => d.max > d.min)) {
    const dArea = `${pathSuaveAvancando(pontosMin, segMin)} L ${n2(pontosMax[n - 1].x)},${n2(pontosMax[n - 1].y)} ${pathSuaveVoltando(segMax)} Z`;
    faixaSvg = `<path d="${dArea}" fill="var(--kf-primaria)" fill-opacity="0.10" stroke="none"/>`;
  }

  // Linha tracejada do preço desejado, com rótulo à direita.
  let linhaDesejadoSvg = '';
  if (precoDesejado != null && !Number.isNaN(precoDesejado)) {
    const y = n2(escalaY(precoDesejado));
    linhaDesejadoSvg = `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="var(--kf-texto-tenue)" stroke-width="1.25" stroke-dasharray="4,4"/>` +
      `<text x="${W - R + 8}" y="${n2(y + 3.5)}" font-size="11" fill="var(--kf-texto-tenue)">seu objetivo</text>`;
  }

  // Linha vertical pontilhada e discreta marcando "hoje" (o último dia).
  const ultX = n2(xAt(n - 1));
  const linhaHojeSvg = `<line x1="${ultX}" y1="${n2(T)}" x2="${ultX}" y2="${n2(T + areaH)}" stroke="var(--kf-texto-suave)" stroke-width="1" stroke-dasharray="3,4" stroke-opacity="0.55"/>`;

  // Linha do mínimo diário, em segmentos — cada um tracejado quando toca um
  // dia sem leitura nova (estimado), para deixar isso visualmente óbvio.
  const linhaSvg = segMin.map((s, i) => {
    const tracejado = !!(serie[i].estimado || serie[i + 1].estimado);
    const d = `M ${n2(s.x0)},${n2(s.y0)} C ${n2(s.cp1x)},${n2(s.cp1y)} ${n2(s.cp2x)},${n2(s.cp2y)} ${n2(s.x1)},${n2(s.y1)}`;
    return `<path d="${d}" fill="none" stroke="var(--kf-primaria)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${tracejado ? ' stroke-dasharray="6,5"' : ''}/>`;
  }).join('');

  // Índice do menor preço de toda a série — usado tanto no marcador quanto
  // no rótulo de destaque.
  let idxMenor = 0;
  for (let i = 1; i < n; i++) if (serie[i].min < serie[idxMenor].min) idxMenor = i;

  // Marcador circular em CADA dia (não só no menor preço e no último) — em
  // séries de 2 a 4 pontos a linha sozinha some no vazio do gráfico; os
  // pontos precisam ficar evidentes. O menor preço ganha a cor de "queda"
  // (boa notícia pro comprador) e o último dia ganha um anel de contraste.
  const marcadoresSvg = serie.map((d, i) => {
    const x = n2(xAt(i));
    const y = n2(escalaY(d.min));
    const ehMenor = i === idxMenor;
    const ehUltimo = i === n - 1;
    const raio = ehUltimo ? 4.5 : (ehMenor ? 4 : 3);
    const cor = ehMenor ? 'var(--kf-queda)' : 'var(--kf-primaria)';
    const anel = ehUltimo ? ' stroke="var(--kf-superficie)" stroke-width="2.5"' : '';
    return `<circle cx="${x}" cy="${y}" r="${raio}" fill="${cor}"${anel}/>`;
  }).join('');

  // Rótulo de valor acima do ponto. Com 4 dias ou menos, todo ponto ganha um
  // rótulo (a curva por si só não carrega informação suficiente); com mais
  // dias, só o menor preço se destaca, como antes.
  const rotuloAcimaDoPonto = (d, i, destaque) => {
    const x = n2(xAt(i));
    const y = escalaY(d.min);
    const yTexto = n2(y - 12 < T + 10 ? y + 18 : y - 12);
    const cor = destaque ? 'var(--kf-queda)' : 'var(--kf-texto-suave)';
    const peso = destaque ? '600' : '500';
    return `<text x="${x}" y="${yTexto}" text-anchor="middle" font-size="12" font-weight="${peso}" fill="${cor}">${escapeHtml(formatarMoedaCompleta(d.min))}</text>`;
  };
  const rotulosPontosSvg = n <= 4
    ? serie.map((d, i) => rotuloAcimaDoPonto(d, i, i === idxMenor)).join('')
    : rotuloAcimaDoPonto(serie[idxMenor], idxMenor, true);

  // Datas no eixo X. Com até 7 dias, mostra todos (sem isso, dias distintos
  // podem sumir ou o rótulo repetir); com mais dias, distribui no máximo 6
  // e nunca repete o mesmo texto em rótulos vizinhos.
  const qtdRotulos = n <= 7 ? n : Math.min(6, n);
  const indicesX = new Set();
  for (let k = 0; k < qtdRotulos; k++) {
    indicesX.add(qtdRotulos === 1 ? 0 : Math.round((k * (n - 1)) / (qtdRotulos - 1)));
  }
  let ultimoRotuloTexto = null;
  const rotulosXSvg = [...indicesX].sort((a, b) => a - b).map(i => {
    const texto = formatarDiaCurto(serie[i].dia);
    if (texto && texto === ultimoRotuloTexto) return '';
    ultimoRotuloTexto = texto;
    return `<text x="${n2(xAt(i))}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--kf-texto-tenue)">${escapeHtml(texto)}</text>`;
  }).join('');

  // Alvos de hover — um por dia, invisíveis, cobrindo toda a altura, para o
  // tooltip que o app.js implementa.
  const alvosSvg = serie.map((d, i) => {
    const x = n2(L + band * i);
    return `<rect class="kf-grafico-alvo" x="${x}" y="0" width="${n2(band)}" height="${H}" fill="transparent" data-dia="${escapeHtml(d.dia)}" data-min="${escapeHtml(d.min)}" data-max="${escapeHtml(d.max)}" data-loja="${escapeHtml(d.lojaMin ?? '')}"/>`;
  }).join('');

  const tituloHtml = titulo
    ? `<div class="kf-grafico-titulo" style="font-size:0.92rem;font-weight:600;letter-spacing:-0.01em;color:var(--kf-texto);margin-bottom:10px;">${escapeHtml(titulo)}</div>`
    : '';

  // Descrição textual da variação, para leitores de tela — vai dentro de um
  // <title> no próprio SVG.
  const tituloAcessivel = `Preço mínimo por dia, de ${formatarMoedaCompleta(serie[0].min)} em ${formatarDiaCurto(serie[0].dia)} a ${formatarMoedaCompleta(serie[n - 1].min)} hoje.`;

  return `<div class="kf-grafico-wrap">${tituloHtml}<svg viewBox="0 0 ${W} ${H}" class="kf-grafico-svg" preserveAspectRatio="none" role="img">` +
    `<title>${escapeHtml(tituloAcessivel)}</title>` +
    `${gradeSvg}${rotulosYSvg}${faixaHistoricaSvg}${faixaSvg}${linhaDesejadoSvg}${linhaHojeSvg}${linhaSvg}${marcadoresSvg}${rotulosPontosSvg}${rotulosXSvg}${alvosSvg}` +
    `</svg></div>`;
}

// -------------------------------------------------------------- sparkline

/**
 * SVG minúsculo — só a linha suave e um ponto no fim, sem eixo nem texto.
 * Resume os últimos dias dentro do cartão: a pergunta "está caindo ou subindo?"
 * é respondida de relance, sem abrir o gráfico grande.
 * @param {Array<number|null>} valores
 * @param {{largura?:number, altura?:number, cor?:string, comArea?:boolean}} opcoes
 */
export function sparkline(valores, opcoes = {}) {
  const { largura = 120, altura = 34, cor = 'var(--kf-primaria)', comArea = false } = opcoes;
  if (!Array.isArray(valores)) return '';

  const validos = [];
  valores.forEach((v, i) => { if (typeof v === 'number' && !Number.isNaN(v)) validos.push({ i, v }); });
  if (validos.length < 2) return '';

  const idxMax = valores.length - 1;
  const vMin = Math.min(...validos.map(p => p.v));
  const vMax = Math.max(...validos.map(p => p.v));
  const amplitude = vMax - vMin;
  const folga = amplitude > 0 ? amplitude * 0.12 : (vMax > 0 ? vMax * 0.12 : 1);
  const yMin = vMin - folga, yMax = vMax + folga;
  const respiro = 3; // respiro vertical pro traço não colar na borda do cartão
  const escalaX = i => (idxMax === 0 ? largura / 2 : (i / idxMax) * largura);
  const escalaY = v => respiro + (altura - respiro * 2) - ((v - yMin) / (yMax - yMin)) * (altura - respiro * 2);

  const pontos = validos.map(p => ({ x: escalaX(p.i), y: escalaY(p.v) }));
  const segmentos = segmentosCatmullRom(pontos);
  const d = pathSuaveAvancando(pontos, segmentos);
  const ultimo = pontos[pontos.length - 1];
  const ultimoValor = validos[validos.length - 1].v;
  const corSegura = escapeHtml(cor);
  // Ponto final fica verde ("queda", boa notícia) quando o último valor é o
  // menor de toda a série; senão, mantém a cor neutra recebida em opcoes.
  const corPontoFinal = ultimoValor <= vMin ? 'var(--kf-queda)' : corSegura;

  let areaSvg = '';
  if (comArea) {
    const baseline = n2(altura - respiro);
    const primeiro = pontos[0];
    const dArea = `${d} L ${n2(ultimo.x)},${baseline} L ${n2(primeiro.x)},${baseline} Z`;
    areaSvg = `<path d="${dArea}" fill="${corSegura}" fill-opacity="0.14" stroke="none"/>`;
  }

  return `<svg viewBox="0 0 ${largura} ${altura}" width="100%" height="${altura}" class="kf-sparkline" preserveAspectRatio="none" aria-hidden="true">` +
    `${areaSvg}` +
    `<path d="${d}" fill="none" stroke="${corSegura}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="${n2(ultimo.x)}" cy="${n2(ultimo.y)}" r="2.4" fill="${corPontoFinal}"/>` +
    `</svg>`;
}

// --------------------------------------------------------- barras de comparação

/**
 * Comparação de preço entre lojas. A barra é proporcional a "quanto pior"
 * cada loja é em relação à mais barata — a mais barata sempre fecha 100%.
 * @param {Array<{rotulo:string, valor:number, destaque?:boolean}>} itens
 */
export function barrasComparacao(itens, _opcoes = {}) {
  if (!Array.isArray(itens) || !itens.length) return '<div class="kf-barras"></div>';
  const validos = itens.filter(it => it && typeof it.valor === 'number' && !Number.isNaN(it.valor) && it.valor > 0);
  if (!validos.length) return '<div class="kf-barras"></div>';

  const menor = Math.min(...validos.map(it => it.valor));
  const linhas = validos.map(it => {
    const ehMelhor = it.valor === menor;
    // Proporção entre a mais barata e este item: a mais barata fecha 100%,
    // as demais ficam mais curtas na medida em que são mais caras.
    const largura = Math.max((menor / it.valor) * 100, 4); // piso de 4% pra barra não sumir
    const cor = ehMelhor ? 'var(--kf-primaria)' : 'var(--kf-fio)';
    // `detalhe` é a linha fina embaixo do nome da loja: condição de pagamento,
    // parcelamento, quando o preço foi visto. Fica junto do preço daquela loja
    // porque é ali que a decisão acontece — separar em outra lista obrigaria a
    // pessoa a cruzar loja com condição de cabeça.
    const detalhe = it.detalhe
      ? `<span class="kf-barra-detalhe"${it.titulo ? ` title="${escapeHtml(it.titulo)}"` : ''}>${escapeHtml(it.detalhe)}</span>`
      : '';
    return `<div class="kf-barra-linha${ehMelhor ? ' kf-barra--melhor' : ''}${detalhe ? ' kf-barra-linha--com-detalhe' : ''}"${it.destaque ? ' data-destaque="true"' : ''}>` +
      `<span class="kf-barra-rotulo">${escapeHtml(it.rotulo ?? '')}</span>` +
      `<span class="kf-barra-trilho"><span class="kf-barra-preenchimento${ehMelhor ? ' kf-barra--melhor' : ''}" style="width:${n2(largura)}%;background:${cor};"></span></span>` +
      `<span class="kf-barra-valor">${escapeHtml(formatarMoedaCompleta(it.valor))}</span>` +
      detalhe +
      `</div>`;
  }).join('');

  return `<div class="kf-barras">${linhas}</div>`;
}

// ------------------------------------------------------------- faixa de preço

/**
 * Barra horizontal fininha (~6px de altura) mostrando onde o preço atual cai
 * entre o mínimo e o máximo já vistos para o produto. Pensada para uso
 * compacto ao lado do preço num cartão ou numa tabela.
 * @param {number} atual
 * @param {number} minimo
 * @param {number} maximo
 * @param {{largura?:string|number}} opcoes
 */
export function faixaDePreco(atual, minimo, maximo, opcoes = {}) {
  const { largura = '100%' } = opcoes;
  const larguraCss = typeof largura === 'number' ? `${largura}px` : String(largura);
  const val = Number(atual);
  const min = Number(minimo);
  const max = Number(maximo);

  // Sem faixa de verdade pra desenhar (dados inválidos ou min === max):
  // mostra o trilho vazio, sem marcador, em vez de quebrar.
  if (!Number.isFinite(val) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    const tituloTexto = Number.isFinite(val)
      ? `Preço atual de ${formatarMoedaCompleta(val)}, sem variação histórica registrada.`
      : 'Sem dados suficientes para mostrar a faixa de preço.';
    const tituloSeguro = escapeHtml(tituloTexto);
    return `<div class="kf-faixa-preco" role="img" aria-label="${tituloSeguro}" title="${tituloSeguro}" style="position:relative;width:${escapeHtml(larguraCss)};height:6px;border-radius:999px;background:var(--kf-fio);"></div>`;
  }

  const pct = n2(Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100)));
  const ehMinimo = val <= min;
  const corMarcador = ehMinimo ? 'var(--kf-queda)' : 'var(--kf-primaria)';
  const tituloTexto = ehMinimo
    ? `Preço atual ${formatarMoedaCompleta(val)} está no menor ponto da faixa histórica (${formatarMoedaCompleta(min)} a ${formatarMoedaCompleta(max)}).`
    : `Preço atual ${formatarMoedaCompleta(val)} está a ${Math.round(pct)}% do caminho entre o mínimo (${formatarMoedaCompleta(min)}) e o máximo (${formatarMoedaCompleta(max)}) já vistos.`;
  const tituloSeguro = escapeHtml(tituloTexto);

  return `<div class="kf-faixa-preco" role="img" aria-label="${tituloSeguro}" title="${tituloSeguro}" style="position:relative;width:${escapeHtml(larguraCss)};height:6px;border-radius:999px;background:var(--kf-fio);">` +
    `<span style="position:absolute;top:50%;left:${pct}%;width:10px;height:10px;margin-left:-5px;margin-top:-5px;border-radius:50%;background:${corMarcador};border:2px solid var(--kf-superficie);box-sizing:border-box;"></span>` +
    `</div>`;
}
