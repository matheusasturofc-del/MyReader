// Tela de leitura: barra superior, barra de ferramentas (dock), zoom, gestos e
// carregamento do visualizador certo para cada tipo de arquivo.
import { db } from './db.js';
import { h, esc, debounce, clamp } from './util.js';
import { icon } from './icons.js';
import { KINDS } from './formats.js';
import { ToolState, History, AnnotationManager, PALETTES } from './annotations.js';
import { toast, popover, menu, dialog, confirmDialog, closePopover, hideSelectionMenu, loading } from './ui.js';
import { go, toggleTheme, getTheme } from './nav.js';

const VIEWERS = {
  pdf: () => import('./viewers/pdf.js'),
  docx: () => import('./viewers/doc.js'),
  markdown: () => import('./viewers/doc.js'),
  html: () => import('./viewers/doc.js'),
  text: () => import('./viewers/doc.js'),
  musicxml: () => import('./viewers/musicxml.js'),
  abc: () => import('./viewers/abc.js'),
  epub: () => import('./viewers/epub.js'),
  sheet: () => import('./viewers/sheet.js'),
  pptx: () => import('./viewers/pptx.js'),
  image: () => import('./viewers/image.js'),
  notebook: () => import('./viewers/notebook.js'),
};

const TOOLS = [
  { id: 'read', icon: 'pointer', label: 'Ler / selecionar', key: 'v' },
  { id: 'pen', icon: 'pen', label: 'Caneta', key: 'p' },
  { id: 'highlighter', icon: 'highlighter', label: 'Marca-texto', key: 'h' },
  { id: 'eraser', icon: 'eraser', label: 'Borracha', key: 'e' },
  { id: 'text', icon: 'type', label: 'Texto', key: 't' },
  { id: 'shape', icon: 'shapes', label: 'Formas', key: 'r' },
];

const SHAPE_ICONS = { rect: 'square', ellipse: 'circle', line: 'minus', arrow: 'arrow' };

let current = null;

export async function closeReader() {
  if (!current) return;
  const c = current;
  current = null;
  try {
    await c.flush();
  } catch (e) {
    console.error(e);
  }
  c.destroy();
}

export async function openReader(app, id) {
  const rec = await db.getFile(id);
  if (!rec) throw new Error('arquivo não encontrado');
  const [blob, state] = await Promise.all([rec.created ? null : db.getBlob(id), db.getState(id)]);
  db.updateFile(id, { openedAt: Date.now() });
  document.title = `${rec.name} · MyReader`;
  const kind = KINDS[rec.kind] || KINDS.text;

  app.innerHTML = '';
  const root = h(`
    <div class="reader" data-kind="${rec.kind}" style="--k:${kind.color}">
      <header class="r-top">
        <button class="icon-btn" data-act="back" title="Biblioteca" aria-label="Voltar para a biblioteca">${icon('back')}</button>
        <div class="r-title">
          <span class="r-kind">${icon(kind.icon, 15)}</span>
          <button class="r-name" data-act="rename" title="Renomear">${esc(rec.name.replace(/\.notebook$/, ''))}</button>
          <span class="r-status" aria-live="polite"></span>
        </div>
        <div class="r-slot"></div>
        <div class="r-zoom" hidden>
          <button class="icon-btn sm" data-act="zoom-out" title="Diminuir zoom (−)" aria-label="Diminuir zoom">${icon('zoom-out', 18)}</button>
          <button class="zoom-val" data-act="zoom-fit" title="Ajustar à largura">100%</button>
          <button class="icon-btn sm" data-act="zoom-in" title="Aumentar zoom (+)" aria-label="Aumentar zoom">${icon('zoom-in', 18)}</button>
        </div>
        <button class="icon-btn" data-act="theme" title="Tema claro/escuro" aria-label="Alternar tema">${icon(getTheme() === 'dark' ? 'sun' : 'moon')}</button>
        <button class="btn btn-primary btn-sm" data-act="export">${icon('download', 17)}<span class="hide-sm">Salvar</span></button>
        <button class="icon-btn" data-act="more" title="Mais opções" aria-label="Mais opções">${icon('more')}</button>
      </header>
      <div class="r-sub"></div>
      <div class="r-body">
        <aside class="r-side" hidden></aside>
        <main class="r-stage" tabindex="-1"><div class="stage-content"></div></main>
      </div>
      <nav class="dock" hidden aria-label="Ferramentas de anotação"></nav>
    </div>`);
  app.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const stage = $('.r-stage');
  const content = $('.stage-content');
  const statusEl = $('.r-status');

  const tools = new ToolState();
  const history = new History();
  state.annotations ||= {};
  state.paper ||= 'white';

  // ---------------------------------------------------------- persistência
  let dirty = false;
  const setStatus = (t) => (statusEl.textContent = t);
  const persist = debounce(async () => {
    try {
      await db.putState(id, state);
      dirty = false;
      setStatus('Salvo');
    } catch (e) {
      console.error(e);
      setStatus('Erro ao salvar');
    }
  }, 600);
  const saveState = () => {
    dirty = true;
    setStatus('Salvando…');
    persist();
  };

  const ann = new AnnotationManager({ tools, history, pages: state.annotations, onChange: saveState, scroller: stage });

  const ctx = {
    rec,
    blob,
    state,
    stage,
    content,
    root,
    sub: $('.r-sub'),
    side: $('.r-side'),
    slot: $('.r-slot'),
    tools,
    history,
    ann,
    saveState,
    setStatus,
    toast,
    setThumb: (thumb, extra = {}) => db.updateFile(id, { thumb, ...extra }),
    setSnippet: (snippet) => db.updateFile(id, { snippet }),
    updateZoomLabel: () => updateZoomLabel(),
  };

  stage.classList.add(`paper-${state.paper}`);

  // ---------------------------------------------------------- visualizador
  const load = loading(stage);
  let viewer;
  try {
    const mod = await VIEWERS[rec.kind]();
    viewer = new mod.default(ctx);
    await viewer.mount();
  } catch (err) {
    load.done();
    console.error(err);
    content.innerHTML = `<div class="error-box">${icon('info', 28)}<strong>Não foi possível abrir este arquivo</strong><p>${esc(err?.message || err)}</p></div>`;
    viewer = null;
  }
  load.done();

  // ---------------------------------------------------------- zoom
  const zoomBox = $('.r-zoom');
  zoomBox.hidden = !viewer?.setZoom;
  function updateZoomLabel() {
    if (viewer?.zoom) $('.zoom-val').textContent = `${Math.round(viewer.zoom * 100)}%`;
  }
  function zoomAt(z, cx, cy) {
    if (!viewer?.setZoom) return;
    z = clamp(z, viewer.minZoom || 0.25, viewer.maxZoom || 5);
    const r = stage.getBoundingClientRect();
    const ox = (cx ?? r.left + r.width / 2) - r.left;
    const oy = (cy ?? r.top + r.height / 3) - r.top;
    const fx = (stage.scrollLeft + ox) / stage.scrollWidth;
    const fy = (stage.scrollTop + oy) / stage.scrollHeight;
    const res = viewer.setZoom(z);
    const fix = () => {
      stage.scrollLeft = fx * stage.scrollWidth - ox;
      stage.scrollTop = fy * stage.scrollHeight - oy;
      updateZoomLabel();
    };
    if (res?.then) res.then(fix);
    else fix();
  }
  updateZoomLabel();

  stage.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !viewer?.setZoom) return;
      e.preventDefault();
      zoomAt(viewer.zoom * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
    },
    { passive: false },
  );

  // Gestos de dois dedos: rolar + pinça para zoom (funciona também enquanto desenha).
  let g = null;
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        ann.layers.forEach((l) => l.cancel());
        const [mx, my] = mid(e.touches);
        g = { d: dist(e.touches), mx, my, lx: mx, ly: my, ratio: 1 };
      }
    },
    { passive: true },
  );
  stage.addEventListener(
    'touchmove',
    (e) => {
      if (!g || e.touches.length !== 2) return;
      e.preventDefault();
      const [mx, my] = mid(e.touches);
      stage.scrollLeft -= mx - g.lx;
      stage.scrollTop -= my - g.ly;
      g.lx = mx;
      g.ly = my;
      if (viewer?.setZoom) {
        g.ratio = dist(e.touches) / g.d;
        if (Math.abs(g.ratio - 1) > 0.04) {
          const r = stage.getBoundingClientRect();
          content.style.transformOrigin = `${stage.scrollLeft + mx - r.left}px ${stage.scrollTop + my - r.top}px`;
          content.style.transform = `scale(${g.ratio})`;
        }
      }
    },
    { passive: false },
  );
  const endGesture = (e) => {
    if (!g || e.touches.length >= 2) return;
    const { ratio, lx, ly } = g;
    g = null;
    content.style.transform = '';
    if (viewer?.setZoom && Math.abs(ratio - 1) > 0.04) zoomAt(viewer.zoom * ratio, lx, ly);
  };
  stage.addEventListener('touchend', endGesture);
  stage.addEventListener('touchcancel', endGesture);

  // ---------------------------------------------------------- dock de ferramentas
  const dock = $('.dock');
  if (viewer?.annotatable) {
    dock.hidden = false;
    root.classList.add('has-dock');
    buildDock();
  }

  function buildDock() {
    const hasHlText = !!viewer.textHighlight;
    dock.innerHTML = `
      <div class="dock-group">
        ${TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" title="${t.label} (${t.key.toUpperCase()})" aria-label="${t.label}">${icon(t.icon, 21)}</button>`).join('')}
      </div>
      <span class="dock-sep"></span>
      <button class="tool tool-color" data-act="color" title="Cor e espessura" aria-label="Cor e espessura"><span class="color-dot"></span></button>
      <span class="dock-sep"></span>
      <div class="dock-group">
        <button class="tool" data-act="undo" title="Desfazer (Ctrl+Z)" aria-label="Desfazer">${icon('undo', 20)}</button>
        <button class="tool" data-act="redo" title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer">${icon('redo', 20)}</button>
      </div>`;
    const refresh = () => {
      dock.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tools.tool));
      const s = tools.s;
      const dot = dock.querySelector('.color-dot');
      dot.style.background = s.color || 'transparent';
      dot.classList.toggle('none', !s.color);
      dock.querySelector('[data-tool="shape"]').innerHTML = icon(SHAPE_ICONS[tools.settings.shape.kind] || 'shapes', 21);
      root.dataset.tool = tools.tool;
      root.dataset.hlmode = tools.settings.highlighter.mode;
      dock.querySelector('[data-act="undo"]').disabled = !history.canUndo;
      dock.querySelector('[data-act="redo"]').disabled = !history.canRedo;
    };
    tools.addEventListener('change', refresh);
    history.addEventListener('change', refresh);
    refresh();
    dock.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) {
        if (tools.tool === b.dataset.tool && b.dataset.tool !== 'read') openToolSettings(b);
        else {
          tools.set(b.dataset.tool);
          if (b.dataset.tool === 'shape' || (b.dataset.tool === 'highlighter' && hasHlText && !localStorage.getItem('mr-hl-tip'))) {
            openToolSettings(b);
            try {
              localStorage.setItem('mr-hl-tip', '1');
            } catch {}
          }
        }
      }
      if (b.dataset.act === 'color') openToolSettings(b);
      if (b.dataset.act === 'undo') history.undo();
      if (b.dataset.act === 'redo') history.redo();
    });
  }

  function openToolSettings(anchor) {
    const t = tools.tool;
    if (t === 'read') {
      toast('Escolha uma ferramenta: caneta, marca-texto, texto…');
      return;
    }
    const s = tools.settings[t];
    const palette = t === 'highlighter' ? PALETTES.highlighter : PALETTES.pen;
    const label = TOOLS.find((x) => x.id === t)?.label;
    const sizes = { pen: [1, 12], highlighter: [8, 40], text: [10, 60], shape: [1, 12], eraser: [4, 40] }[t];
    const panel = h(`
      <div class="tool-panel">
        <div class="tp-title">${icon(TOOLS.find((x) => x.id === t).icon, 16)} ${label}</div>
        ${
          t === 'highlighter' && viewer.textHighlight
            ? `<div class="seg" role="radiogroup">
                 <button data-mode="text" class="${s.mode === 'text' ? 'on' : ''}">${icon('type', 15)} Sobre o texto</button>
                 <button data-mode="free" class="${s.mode !== 'text' ? 'on' : ''}">${icon('highlighter', 15)} Livre</button>
               </div>
               <p class="tp-hint">${s.mode === 'text' ? 'Selecione o texto e ele será marcado automaticamente.' : 'Desenhe à mão livre. Segure Shift para linha reta.'}</p>`
            : ''
        }
        ${
          t === 'shape'
            ? `<div class="seg">${Object.entries(SHAPE_ICONS)
                .map(([k, ic]) => `<button data-shape="${k}" class="${s.kind === k ? 'on' : ''}" aria-label="${k}">${icon(ic, 17)}</button>`)
                .join('')}</div>`
            : ''
        }
        ${
          t !== 'eraser'
            ? `<div class="swatches">${palette
                .map((c) => `<button class="swatch ${c === s.color ? 'on' : ''}" data-color="${c}" style="--c:${c}" aria-label="Cor ${c}"></button>`)
                .join('')}<label class="swatch custom" title="Outra cor"><input type="color" value="${s.color}" aria-label="Escolher cor"></label></div>`
            : '<p class="tp-hint">Toque ou arraste sobre um traço para apagá-lo.</p>'
        }
        <label class="tp-size"><span>Tamanho</span><input type="range" min="${sizes[0]}" max="${sizes[1]}" step="1" value="${s.size}"><b>${s.size}</b></label>
        <div class="tp-preview"><canvas width="240" height="44"></canvas></div>
      </div>`);
    const pop = popover(anchor, panel, { placement: matchMedia('(max-width: 720px)').matches ? 'top' : root.classList.contains('dock-top') ? 'bottom' : 'top' });
    const preview = () => {
      const c = panel.querySelector('canvas');
      const x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      const st = tools.settings[t];
      x.lineCap = 'round';
      if (t === 'text') {
        x.fillStyle = st.color;
        x.font = `500 ${Math.min(36, st.size)}px "Inter Variable", sans-serif`;
        x.textBaseline = 'middle';
        x.fillText('Aa Texto', 12, 22);
        return;
      }
      x.strokeStyle = t === 'eraser' ? '#999' : st.color;
      x.globalAlpha = t === 'highlighter' ? 0.75 : 1;
      x.lineWidth = Math.min(40, st.size * (t === 'highlighter' ? 0.9 : 1.6));
      x.beginPath();
      x.moveTo(20, 28);
      x.bezierCurveTo(80, 0, 150, 44, 220, 16);
      x.stroke();
    };
    preview();
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.color) {
        tools.update(t, { color: b.dataset.color });
        panel.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
      }
      if (b.dataset.shape) {
        tools.update(t, { kind: b.dataset.shape });
        panel.querySelectorAll('[data-shape]').forEach((x) => x.classList.toggle('on', x === b));
      }
      if (b.dataset.mode) {
        tools.update(t, { mode: b.dataset.mode });
        pop.close();
        openToolSettings(anchor);
        return;
      }
      preview();
    });
    panel.querySelector('input[type=color]')?.addEventListener('input', (e) => {
      tools.update(t, { color: e.target.value });
      preview();
    });
    const range = panel.querySelector('input[type=range]');
    range.addEventListener('input', () => {
      tools.update(t, { size: +range.value });
      panel.querySelector('.tp-size b').textContent = range.value;
      preview();
    });
  }

  // ---------------------------------------------------------- barra superior
  root.querySelector('.r-top').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'back') go('/');
    if (act === 'theme') {
      toggleTheme();
      b.innerHTML = icon(getTheme() === 'dark' ? 'sun' : 'moon');
    }
    if (act === 'zoom-in') zoomAt(viewer.zoom * 1.2);
    if (act === 'zoom-out') zoomAt(viewer.zoom / 1.2);
    if (act === 'zoom-fit') zoomAt(1);
    if (act === 'rename') {
      const name = await dialog({
        title: 'Renomear',
        input: { value: rec.name.replace(/\.notebook$/, '') },
        buttons: [
          { label: 'Cancelar', value: false },
          { label: 'Salvar', value: true, primary: true },
        ],
      });
      if (name && name.trim()) {
        rec.name = name.trim() + (rec.kind === 'notebook' ? '.notebook' : '');
        await db.updateFile(id, { name: rec.name });
        b.textContent = name.trim();
        document.title = `${name.trim()} · MyReader`;
      }
    }
    if (act === 'export') {
      const items = viewer?.exports?.() || [];
      if (!items.length) return toast('Nada para exportar neste formato.');
      menu(b, [{ header: 'Salvar / exportar' }, ...items.map((it) => ({ ...it, run: () => runExport(it) }))]);
    }
    if (act === 'more') {
      const items = [
        { header: 'Cor do papel' },
        ...[
          ['white', 'Branco'],
          ['sepia', 'Sépia (descanso)'],
          ['night', 'Noturno'],
        ].map(([p, label]) => ({
          label: label + (state.paper === p ? '  ✓' : ''),
          icon: p === 'night' ? 'moon' : p === 'sepia' ? 'contrast' : 'sun',
          run: () => {
            stage.classList.remove(`paper-${state.paper}`);
            state.paper = p;
            stage.classList.add(`paper-${p}`);
            saveState();
          },
        })),
        ...(viewer?.moreItems?.() || []),
        '-',
        viewer?.annotatable && {
          label: 'Apagar todas as anotações',
          icon: 'trash',
          danger: true,
          run: async () => {
            if (await confirmDialog('Apagar anotações?', '<p>Todos os desenhos, destaques e textos deste arquivo serão removidos. Você pode desfazer com Ctrl+Z.</p>', 'Apagar', true)) ann.clearAll();
          },
        },
        { label: 'Atalhos de teclado', icon: 'info', run: showShortcuts },
      ].filter(Boolean);
      menu(b, items);
    }
  });

  async function runExport(it) {
    const l = loading(document.body, 'Preparando arquivo…');
    try {
      await it.run();
    } catch (e) {
      console.error(e);
      toast(`Erro ao exportar: ${e.message || e}`, { type: 'error', timeout: 5000 });
    } finally {
      l.done();
    }
  }

  function showShortcuts() {
    dialog({
      title: 'Atalhos de teclado',
      body: `<div class="shortcuts">
        ${TOOLS.map((t) => `<div><kbd>${t.key.toUpperCase()}</kbd><span>${t.label}</span></div>`).join('')}
        <div><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>Desfazer</span></div>
        <div><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd><span>Refazer</span></div>
        <div><kbd>+</kbd> / <kbd>−</kbd><span>Zoom</span></div>
        <div><kbd>0</kbd><span>Ajustar à largura</span></div>
        <div><kbd>Ctrl</kbd>+<kbd>F</kbd><span>Buscar (PDF)</span></div>
        <div><kbd>Esc</kbd><span>Voltar a ler</span></div>
        <div><kbd>Ctrl</kbd>+roda<span>Zoom</span></div>
        <div>2 dedos<span>Rolar e zoom no celular</span></div>
      </div>`,
    });
  }

  // ---------------------------------------------------------- teclado
  const onKey = (e) => {
    const tgt = e.target;
    const typing = tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f' && viewer?.search) {
      e.preventDefault();
      viewer.search();
      return;
    }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? history.redo() : history.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      history.redo();
      return;
    }
    if (mod || e.altKey) return;
    if (viewer?.annotatable) {
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) {
        tools.set(t.id);
        return;
      }
      if (e.key === 'Escape') {
        closePopover();
        tools.set('read');
      }
    }
    if (viewer?.setZoom) {
      if (e.key === '+' || e.key === '=') zoomAt(viewer.zoom * 1.2);
      if (e.key === '-' || e.key === '_') zoomAt(viewer.zoom / 1.2);
      if (e.key === '0') zoomAt(1);
    }
    viewer?.onKey?.(e);
  };
  document.addEventListener('keydown', onKey);

  const onResize = debounce(() => viewer?.onResize?.(), 150);
  window.addEventListener('resize', onResize);
  const onBeforeUnload = () => {
    if (dirty) persist.flush();
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  const onVis = () => document.visibilityState === 'hidden' && dirty && persist.flush();
  document.addEventListener('visibilitychange', onVis);

  setStatus(rec.created ? '' : '');
  stage.focus({ preventScroll: true });

  current = {
    async flush() {
      await viewer?.beforeClose?.();
      if (dirty) await persist.flush();
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVis);
      closePopover();
      hideSelectionMenu();
      try {
        viewer?.destroy?.();
      } catch (e) {
        console.error(e);
      }
      ann.destroy();
    },
  };
}
