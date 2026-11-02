// Componentes de interface reutilizáveis: toast, menus, diálogos e menu de seleção.
import { h, esc } from './util.js';
import { icon } from './icons.js';

let toastWrap;
export function toast(msg, { type = 'info', timeout = 2800 } = {}) {
  if (!toastWrap) {
    toastWrap = h('<div class="toasts" role="status" aria-live="polite"></div>');
    document.body.appendChild(toastWrap);
  }
  const t = h(`<div class="toast toast-${type}">${esc(msg)}</div>`);
  toastWrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, timeout);
}

let openPop = null;
export function closePopover() {
  openPop?.close();
}

/**
 * Abre um popover ancorado num elemento. content: Element.
 * placement: 'bottom' | 'top' (auto-inverte se não couber).
 */
export function popover(anchor, content, { placement = 'bottom', align = 'center', className = '' } = {}) {
  closePopover();
  const pop = h(`<div class="popover ${className}" role="dialog"></div>`);
  pop.appendChild(content);
  document.body.appendChild(pop);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth,
      ph = pop.offsetHeight;
    let top = placement === 'top' ? r.top - ph - 10 : r.bottom + 10;
    if (placement === 'top' && top < 8) top = r.bottom + 10;
    if (placement === 'bottom' && top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 10);
    let left = align === 'start' ? r.left : align === 'end' ? r.right - pw : r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(innerWidth - pw - 8, left));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  };
  place();
  requestAnimationFrame(() => pop.classList.add('show'));
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
  });
  window.addEventListener('resize', place);
  function close() {
    if (openPop !== api) return;
    openPop = null;
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    pop.classList.remove('show');
    setTimeout(() => pop.remove(), 150);
  }
  const api = { el: pop, close, place };
  openPop = api;
  return api;
}

/** Menu simples: items = [{label, icon, run, danger, hint}] ou '-' (separador). */
export function menu(anchor, items, opts = {}) {
  const list = h('<div class="menu" role="menu"></div>');
  for (const it of items) {
    if (it === '-') {
      list.appendChild(h('<div class="menu-sep"></div>'));
      continue;
    }
    if (it.header) {
      list.appendChild(h(`<div class="menu-header">${esc(it.header)}</div>`));
      continue;
    }
    const b = h(
      `<button class="menu-item ${it.danger ? 'danger' : ''}" role="menuitem">${it.icon ? icon(it.icon, 18) : ''}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`,
    );
    b.addEventListener('click', () => {
      p.close();
      it.run?.();
    });
    list.appendChild(b);
  }
  const p = popover(anchor, list, { align: 'end', ...opts });
  return p;
}

/** Diálogo modal. Retorna Promise com o valor do botão clicado. */
export function dialog({ title, body = '', buttons = [{ label: 'OK', value: true, primary: true }], input }) {
  return new Promise((resolve) => {
    const wrap = h(`
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <h3>${esc(title)}</h3>
          ${body ? `<div class="modal-body">${body}</div>` : ''}
          ${input ? `<input class="field" type="text" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}">` : ''}
          <div class="modal-actions"></div>
        </div>
      </div>`);
    const actions = wrap.querySelector('.modal-actions');
    const field = wrap.querySelector('input');
    const done = (v) => {
      wrap.classList.remove('show');
      setTimeout(() => wrap.remove(), 180);
      resolve(v);
    };
    for (const b of buttons) {
      const btn = h(`<button class="btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}">${esc(b.label)}</button>`);
      btn.onclick = () => done(field && b.value === true ? field.value : b.value);
      actions.appendChild(btn);
    }
    wrap.addEventListener('pointerdown', (e) => e.target === wrap && done(undefined));
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(undefined);
      if (e.key === 'Enter' && field) done(field.value);
    });
    document.body.appendChild(wrap);
    requestAnimationFrame(() => {
      wrap.classList.add('show');
      (field || actions.querySelector('.btn-primary'))?.focus();
      field?.select();
    });
  });
}

export const confirmDialog = (title, body, okLabel = 'Confirmar', danger = false) =>
  dialog({
    title,
    body,
    buttons: [
      { label: 'Cancelar', value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
  });

/**
 * Menu flutuante que aparece sobre uma seleção de texto:
 * cores de marca-texto + copiar.
 */
let selMenu;
export function showSelectionMenu(rect, { colors, onHighlight, onCopy, extra = [] }) {
  hideSelectionMenu();
  selMenu = h('<div class="sel-menu" role="toolbar"></div>');
  for (const c of colors) {
    const b = h(`<button class="sel-swatch" style="--c:${c}" title="Marcar texto" aria-label="Marcar com ${c}"></button>`);
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      onHighlight(c);
      hideSelectionMenu();
    });
    selMenu.appendChild(b);
  }
  const mk = (ic, label, fn) => {
    const b = h(`<button class="sel-btn" title="${label}" aria-label="${label}">${icon(ic, 17)}</button>`);
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      fn();
      hideSelectionMenu();
    });
    selMenu.appendChild(b);
  };
  selMenu.appendChild(h('<span class="sel-divider"></span>'));
  if (onCopy) mk('copy', 'Copiar', onCopy);
  for (const e of extra) mk(e.icon, e.label, e.run);
  document.body.appendChild(selMenu);
  const w = selMenu.offsetWidth;
  let top = rect.top - selMenu.offsetHeight - 10;
  if (top < 60) top = rect.bottom + 10;
  selMenu.style.top = `${top}px`;
  selMenu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
  requestAnimationFrame(() => selMenu?.classList.add('show'));
}
export function hideSelectionMenu() {
  selMenu?.remove();
  selMenu = null;
}

/** Overlay de carregamento dentro de um container. */
export function loading(container, text = 'Abrindo…') {
  const el = h(`<div class="loading"><div class="spinner"></div><span>${esc(text)}</span></div>`);
  container.appendChild(el);
  return {
    set: (t) => (el.querySelector('span').textContent = t),
    done: () => el.remove(),
  };
}
