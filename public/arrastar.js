/*
 * arrastar.js — arrastar-e-soltar para reordenar cartões numa GRADE (várias
 * colunas), com a mesma sensação do kanban do Guipa Manager: clone inclinado
 * seguindo o cursor, o cartão original vira um "buraco" translúcido, e os
 * vizinhos deslizam suavemente (FLIP) até a nova posição enquanto o arrasto
 * acontece. Sem drag-and-drop nativo do HTML — ele tira um retrato do
 * elemento no dragstart e ignora transformações depois, então não dá para
 * inclinar o cartão em voo.
 *
 * API:
 *   import { tornarArrastavel } from './arrastar.js';
 *   const desligar = tornarArrastavel(container, {
 *     seletorItem: '.kf-produto-cartao',
 *     atributoId: 'data-id',
 *     seletorPega: null,               // ou algo como '.kf-cartao-alca'
 *     aoReordenar: (ids) => { ... },   // chamado 1x ao soltar, se mudou
 *     ignorar: 'button, a, input, select, .kf-grafico-alvo'
 *   });
 *   // ... antes de re-renderizar o container:
 *   desligar();
 *
 * CLASSES CSS QUE ESTE MÓDULO ESPERA (definir no style.css — este arquivo
 * não escreve nada de estilo além do indispensável para clone/transform):
 *   .kf-arrastando        — no <body> enquanto um arrasto está em curso.
 *                            Use para desligar seleção de texto, por ex.:
 *                            body.kf-arrastando { user-select: none; }
 *   .kf-arrastar-clone    — o cartão-fantasma que segue o cursor. Espera-se
 *                            que já herde a aparência do cartão original
 *                            (o clone é cópia do DOM); esta classe é onde
 *                            entram sombra, cursor, etc. Este módulo aplica
 *                            via style inline apenas posição/transform/
 *                            opacity/z-index — cores e bordas ficam por
 *                            conta da classe original do cartão.
 *   .kf-arrastar-buraco   — aplicada ao cartão original enquanto seu clone
 *                            está em voo (opacidade reduzida, sem clique).
 *   .kf-arrastar-alvo     — aplicada ao cartão que ocupa a posição onde o
 *                            item seria inserido se soltasse agora (borda/
 *                            linha de destaque).
 */

// Distância mínima, em pixels, para o gesto virar arrasto (evita que um
// clique comum em botão/link dentro do cartão dispare o drag).
const LIMIAR_ARRASTO = 6;

// Duração do FLIP (deslize dos vizinhos) e da animação de "encaixe" do
// clone ao soltar, em ms — usadas tanto no JS (setTimeout) quanto embutidas
// no transition inline.
const DURACAO_FLIP = 180;
const DURACAO_ENCAIXE = 200;

export function tornarArrastavel(container, opcoes = {}) {
  const cfg = {
    seletorItem: opcoes.seletorItem,
    atributoId: opcoes.atributoId || 'data-id',
    seletorPega: opcoes.seletorPega || null,
    aoReordenar: typeof opcoes.aoReordenar === 'function' ? opcoes.aoReordenar : () => {},
    ignorar: opcoes.ignorar || null,
  };

  if (!container || !cfg.seletorItem) {
    // Sem container ou seletor não há o que ligar; devolve um "desligar"
    // inofensivo para o chamador poder tratar tudo de forma uniforme.
    return () => {};
  }

  const reduzMovimento = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Elemento de anúncio para leitores de tela (criado uma vez, reaproveitado
  // entre arrastos). position:absolute + clip é o padrão "sr-only".
  const liveRegion = document.createElement('div');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('role', 'status');
  liveRegion.style.position = 'absolute';
  liveRegion.style.width = '1px';
  liveRegion.style.height = '1px';
  liveRegion.style.overflow = 'hidden';
  liveRegion.style.clip = 'rect(0 0 0 0)';
  liveRegion.style.clipPath = 'inset(50%)';
  liveRegion.style.whiteSpace = 'nowrap';
  container.appendChild(liveRegion);

  function anunciar(texto) {
    liveRegion.textContent = texto;
  }

  // Estado do arrasto em curso (null quando parado). Guardar tudo num único
  // objeto facilita limpar/cancelar sem deixar sobra de listener.
  let arraste = null;

  function idDe(item) {
    return item.getAttribute(cfg.atributoId);
  }

  function itensAtuais() {
    if (!container.isConnected) return [];
    return Array.from(container.querySelectorAll(cfg.seletorItem));
  }

  // FLIP: mede a posição de cada item ANTES da mudança no DOM, aplica a
  // mudança (fn), mede DEPOIS e anima a diferença via transform — assim os
  // cartões parecem deslizar até o novo lugar em vez de "pular". Mede X e Y
  // porque numa grade a reflow acontece nas duas direções (o item pode subir
  // de linha ao mesmo tempo em que muda de coluna).
  function animarReposicionamento(fn) {
    if (reduzMovimento) { fn(); return; }
    const itens = itensAtuais();
    const antes = new Map();
    itens.forEach((it) => {
      const r = it.getBoundingClientRect();
      antes.set(it, { x: r.left, y: r.top });
    });

    fn();

    itens.forEach((it) => {
      if (!it.isConnected) return;
      const pos0 = antes.get(it);
      if (!pos0) return;
      const r = it.getBoundingClientRect();
      const dx = pos0.x - r.left;
      const dy = pos0.y - r.top;
      if (!dx && !dy) return;
      it.style.transition = 'none';
      it.style.transform = `translate(${dx}px, ${dy}px)`;
      // Força o navegador a aplicar o estado "invertido" antes de tirar a
      // transição, senão ele agrupa tudo num frame só e não anima nada.
      requestAnimationFrame(() => {
        it.style.transition = `transform ${DURACAO_FLIP}ms cubic-bezier(0.2, 0.8, 0.3, 1)`;
        it.style.transform = '';
      });
      const limpar = () => {
        it.style.transition = '';
        it.removeEventListener('transitionend', limpar);
      };
      it.addEventListener('transitionend', limpar);
    });
  }

  function posicionarClone(ev) {
    if (!arraste) return;
    arraste.clone.style.left = `${ev.clientX - arraste.dx}px`;
    arraste.clone.style.top = `${ev.clientY - arraste.dy}px`;
  }

  function limparAlvo() {
    if (arraste && arraste.elAlvo) {
      arraste.elAlvo.classList.remove('kf-arrastar-alvo');
      arraste.elAlvo = null;
    }
  }

  // Calcula, numa grade de várias colunas, qual item deve receber o
  // destaque de alvo e onde o cartão entraria se fosse solto agora.
  // Estratégia: acha o item cujo CENTRO está mais próximo do cursor
  // (distância euclidiana) e usa a posição do cursor relativa ao centro
  // desse item para decidir "antes" ou "depois" dele — comparando X quando
  // os itens estão lado a lado na mesma linha, e a combinação natural cobre
  // também a quebra de linha (se o cursor está mais para a direita/baixo do
  // centro do item mais próximo, entra depois; senão, antes).
  function itemMaisProximo(ev) {
    const itens = itensAtuais().filter((it) => it !== arraste.orig);
    if (!itens.length) return null;
    let melhor = null;
    let menorDist = Infinity;
    for (const it of itens) {
      const r = it.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = (ev.clientX - cx) ** 2 + (ev.clientY - cy) ** 2;
      if (dist < menorDist) {
        menorDist = dist;
        melhor = { el: it, cx, cy, r };
      }
    }
    return melhor;
  }

  function reposicionarBuraco(ev) {
    if (!arraste || !container.isConnected) return;
    const proximo = itemMaisProximo(ev);
    limparAlvo();
    if (!proximo) return;

    // Depois do centro (mais para a direita OU mais abaixo, o que pesar
    // mais na proporção da própria célula) entra DEPOIS do item; senão,
    // ANTES. Usar X como critério principal cobre o caso comum (grade com
    // linhas); cair para Y quando X empata cobre o item mais à direita da
    // última coluna, onde só sobra "abaixo dele" para decidir.
    const depoisX = ev.clientX > proximo.cx;
    const antesDe = depoisX ? proximo.el.nextElementSibling : proximo.el;

    if (arraste.buraco.nextElementSibling === antesDe ||
        (!antesDe && arraste.buraco === container.lastElementChild)) {
      // já está na posição certa — só atualiza o destaque visual
      proximo.el.classList.add('kf-arrastar-alvo');
      arraste.elAlvo = proximo.el;
      return;
    }

    animarReposicionamento(() => {
      if (antesDe) container.insertBefore(arraste.buraco, antesDe);
      else container.appendChild(arraste.buraco);
    });

    proximo.el.classList.add('kf-arrastar-alvo');
    arraste.elAlvo = proximo.el;
  }

  function ordemAtual() {
    return itensAtuais().map(idDe);
  }

  function animarEncaixeEFinalizar() {
    if (!arraste) return;
    const a = arraste;
    const ordemFinal = ordemAtual();
    const mudou = ordemFinal.length === a.ordemInicial.length &&
      ordemFinal.some((id, i) => id !== a.ordemInicial[i]);

    function finalizar() {
      limparAlvo();
      if (a.clone.parentNode) a.clone.parentNode.removeChild(a.clone);
      if (a.orig && a.orig.isConnected) {
        a.orig.classList.remove('kf-arrastar-buraco');
        a.orig.style.visibility = '';
      }
      document.body.classList.remove('kf-arrastando');
      arraste = null;
      if (mudou) {
        anunciar('Item movido.');
        cfg.aoReordenar(ordemFinal);
      } else {
        anunciar('Arrasto cancelado, ordem original mantida.');
      }
    }

    // Anima o clone voando até a posição final do "buraco" (que já está no
    // lugar certo do DOM) antes de trocar o buraco pelo cartão de verdade.
    if (!a.orig.isConnected || reduzMovimento) {
      finalizar();
      return;
    }
    const rf = a.buraco.getBoundingClientRect();
    a.clone.style.transition = `left ${DURACAO_ENCAIXE}ms ease, top ${DURACAO_ENCAIXE}ms ease, transform ${DURACAO_ENCAIXE}ms ease, opacity ${DURACAO_ENCAIXE}ms ease`;
    a.clone.style.left = `${rf.left}px`;
    a.clone.style.top = `${rf.top}px`;
    a.clone.style.transform = 'none';
    a.clone.style.opacity = '1';
    let feito = false;
    const acabar = () => {
      if (feito) return;
      feito = true;
      finalizar();
    };
    a.clone.addEventListener('transitionend', acabar, { once: true });
    // salvaguarda: se o transitionend não disparar (elemento sumiu, etc.)
    setTimeout(acabar, DURACAO_ENCAIXE + 60);
  }

  function cancelarArraste() {
    if (!arraste) return;
    const a = arraste;
    limparAlvo();
    // devolve o buraco (placeholder) para o lugar original antes de removê-lo
    animarReposicionamento(() => {
      if (a.buraco.parentNode) a.buraco.parentNode.removeChild(a.buraco);
    });
    if (a.clone.parentNode) a.clone.parentNode.removeChild(a.clone);
    if (a.orig && a.orig.isConnected) {
      a.orig.classList.remove('kf-arrastar-buraco');
      a.orig.style.visibility = '';
    }
    document.body.classList.remove('kf-arrastando');
    arraste = null;
    anunciar('Arrasto cancelado.');
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape' && arraste) {
      ev.preventDefault();
      cancelarArraste();
    }
  }

  // --- arrasto por ponteiro (mouse e toque) -------------------------------
  function onPointerDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const item = ev.target.closest ? ev.target.closest(cfg.seletorItem) : null;
    if (!item || !container.contains(item)) return;

    if (cfg.ignorar && ev.target.closest && ev.target.closest(cfg.ignorar)) return;
    if (cfg.seletorPega) {
      const pega = ev.target.closest ? ev.target.closest(cfg.seletorPega) : null;
      if (!pega || !item.contains(pega)) return;
    }

    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let ativo = false;
    let pointerId = ev.pointerId;
    let capturedEl = null;

    function onMove(e) {
      if (e.pointerId !== pointerId) return;
      if (!ativo) {
        if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < LIMIAR_ARRASTO) return;
        ativo = true;
        iniciarArrasto(item, x0, y0, e);
        // captura o ponteiro no próprio item para continuar recebendo
        // move/up mesmo que o cursor saia dele durante o arrasto.
        try {
          item.setPointerCapture(pointerId);
          capturedEl = item;
        } catch (err) {
          // alguns navegadores/elementos podem recusar; o arrasto segue
          // funcionando via listeners em document mesmo assim.
        }
      }
      posicionarClone(e);
      reposicionarBuraco(e);
      e.preventDefault();
    }

    function onUp(e) {
      if (e.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      if (capturedEl && capturedEl.releasePointerCapture) {
        try { capturedEl.releasePointerCapture(pointerId); } catch (err) { /* ignora */ }
      }
      if (ativo) animarEncaixeEFinalizar();
    }

    function onCancel(e) {
      if (e.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      if (capturedEl && capturedEl.releasePointerCapture) {
        try { capturedEl.releasePointerCapture(pointerId); } catch (err) { /* ignora */ }
      }
      if (ativo) cancelarArraste();
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  }

  function iniciarArrasto(item, x0, y0, ev) {
    const r = item.getBoundingClientRect();

    // Clone que voa preso ao cursor. Cópia do DOM para herdar toda a
    // aparência visual do cartão original (classes de cor, borda etc. vêm
    // do CSS do próprio app); aqui só forçamos posição/transform/opacidade.
    const clone = item.cloneNode(true);
    clone.classList.add('kf-arrastar-clone');
    clone.style.position = 'fixed';
    clone.style.left = `${r.left}px`;
    clone.style.top = `${r.top}px`;
    clone.style.width = `${r.width}px`;
    clone.style.height = `${r.height}px`;
    clone.style.margin = '0';
    clone.style.zIndex = '9999';
    clone.style.pointerEvents = 'none';
    if (!reduzMovimento) {
      clone.style.transform = 'rotate(-3deg) scale(0.97)';
      clone.style.opacity = '0.85';
      clone.style.boxShadow = '0 20px 40px -12px rgba(0, 0, 0, 0.5)';
    } else {
      clone.style.opacity = '0.9';
    }
    document.body.appendChild(clone);

    // O cartão original vira um "buraco": some visualmente (mas continua
    // ocupando espaço na grade) e some para eventos de ponteiro/foco — é
    // ele que se move pelo DOM conforme o cursor passeia pela grade, e por
    // isso é ele (não um placeholder à parte) que dita a posição final.
    item.classList.add('kf-arrastar-buraco');
    item.style.visibility = 'hidden';

    arraste = {
      orig: item,
      clone,
      buraco: item,
      dx: x0 - r.left,
      dy: y0 - r.top,
      elAlvo: null,
      ordemInicial: ordemAtual(),
    };

    document.body.classList.add('kf-arrastando');
    anunciar('Arrastando item.');
    posicionarClone(ev);
  }

  // --- arrasto por teclado -------------------------------------------------
  // Com o item focado, Ctrl+Setas troca sua posição na lista de itens e
  // já dispara aoReordenar (não há "soltar" separado no teclado).
  function onKeyDownItem(ev) {
    if (!ev.ctrlKey) return;
    const item = ev.target.closest ? ev.target.closest(cfg.seletorItem) : null;
    if (!item || !container.contains(item)) return;

    let delta = 0;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') delta = 1;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') delta = -1;
    else return;

    ev.preventDefault();
    const itens = itensAtuais();
    const i = itens.indexOf(item);
    if (i === -1) return;
    const j = i + delta;
    if (j < 0 || j >= itens.length) return;

    animarReposicionamento(() => {
      if (delta > 0) {
        container.insertBefore(item, itens[j].nextElementSibling);
      } else {
        container.insertBefore(item, itens[j]);
      }
    });
    item.focus();
    anunciar(`Item movido para a posição ${j + 1} de ${itens.length}.`);
    cfg.aoReordenar(ordemAtual());
  }

  // Garante tabindex nos itens já presentes e nos que forem inseridos depois
  // (o app re-renderiza sozinho) — usamos um MutationObserver leve para não
  // depender de o chamador lembrar de re-chamar tornarArrastavel a cada
  // render. Se o container sumir, o observer simplesmente para de achar algo
  // e não lança erro.
  function aplicarTabindex() {
    if (!container.isConnected) return;
    itensAtuais().forEach((it) => {
      if (!it.hasAttribute('tabindex')) it.setAttribute('tabindex', '0');
    });
  }
  aplicarTabindex();
  const observer = new MutationObserver(() => aplicarTabindex());
  observer.observe(container, { childList: true });

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('keydown', onKeyDownItem);
  document.addEventListener('keydown', onKeyDown);

  // Função de desligamento: remove todos os listeners e o observer, e
  // cancela um arrasto em curso (se houver) para não deixar clone/buraco
  // pendurados quando o app for re-renderizar o container.
  return function desligar() {
    if (arraste) cancelarArraste();
    observer.disconnect();
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('keydown', onKeyDownItem);
    document.removeEventListener('keydown', onKeyDown);
    if (liveRegion.parentNode) liveRegion.parentNode.removeChild(liveRegion);
  };
}
