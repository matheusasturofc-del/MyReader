// Motor de anotações: caneta, marca-texto, borracha, texto e formas.
// Cada "página" (PDF, imagem, partitura, folha do caderno...) recebe uma AnnotationLayer
// com 3 canvas: marca-texto (mix-blend multiply = efeito real de marca-texto),
// tinta (caneta/texto/formas) e um canvas "ao vivo" que recebe os toques.
// As coordenadas são guardadas em unidades relativas: largura da página = 1000.

import { clamp } from './util.js';

export const UNIT = 1000;

export const PALETTES = {
  pen: ['#1b1b1f', '#3b5bdb', '#e03131', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'],
  highlighter: ['#ffe14d', '#a5f37a', '#7fdcff', '#ff9ecb', '#ffb86b', '#c9a7ff'],
};

const DEFAULTS = {
  pen: { color: '#1b1b1f', size: 3 },
  highlighter: { color: '#ffe14d', size: 18, mode: 'auto' },
  text: { color: '#1b1b1f', size: 18 },
  shape: { color: '#e03131', size: 3, kind: 'rect' },
  eraser: { size: 14 },
};

export const DRAW_TOOLS = new Set(['pen', 'highlighter', 'eraser', 'text', 'shape', 'image']);

/** Margem extra em volta da página, em unidades (largura da página = 1000). */
export const NO_MARGIN = { l: 0, t: 0, r: 0, b: 0 };

// ---------------------------------------------------------------- imagens importadas
const imgCache = new Map(); // src -> HTMLImageElement
const imgWaiters = new Set();
export function onImagesLoaded(fn) {
  imgWaiters.add(fn);
  return () => imgWaiters.delete(fn);
}
export function getImage(src) {
  let img = imgCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => imgWaiters.forEach((f) => f());
    img.src = src;
    imgCache.set(src, img);
  }
  return img;
}
/** Garante que as imagens das anotações estão carregadas (antes de exportar). */
export async function ensureImages(pages) {
  const all = Object.values(pages || {}).flat().filter((s) => s?.t === 'img');
  await Promise.all(all.map((s) => getImage(s.src).decode().catch(() => {})));
}

/** Estado global da ferramenta atual (compartilhado entre páginas). */
export class ToolState extends EventTarget {
  constructor() {
    super();
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('mr-tools') || '{}');
    } catch {}
    this.tool = 'read';
    this.settings = structuredClone(DEFAULTS);
    for (const k of Object.keys(this.settings)) Object.assign(this.settings[k], saved[k] || {});
    // 'auto' = gruda no texto quando passa por cima dele; 'free' = sempre à mão livre.
    if (this.settings.highlighter.mode !== 'free') this.settings.highlighter.mode = 'auto';
  }
  set(tool) {
    this.tool = tool;
    this.dispatchEvent(new Event('change'));
  }
  update(tool, patch) {
    Object.assign(this.settings[tool], patch);
    try {
      localStorage.setItem('mr-tools', JSON.stringify(this.settings));
    } catch {}
    this.dispatchEvent(new Event('change'));
  }
  get s() {
    return this.settings[this.tool] || {};
  }
}

/** Desfazer/refazer para as anotações. */
export class History extends EventTarget {
  constructor() {
    super();
    this.undoStack = [];
    this.redoStack = [];
  }
  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }
  undo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    e.undo();
    this.redoStack.push(e);
    this.emit();
    return true;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    e.redo();
    this.undoStack.push(e);
    this.emit();
    return true;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  emit() {
    this.dispatchEvent(new Event('change'));
  }
}

// ---------------------------------------------------------------- desenho

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function smoothPath(ctx, pts, k) {
  const n = pts.length / 3;
  ctx.beginPath();
  ctx.moveTo(pts[0] * k, pts[1] * k);
  if (n === 1) {
    ctx.lineTo(pts[0] * k + 0.01, pts[1] * k);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 3] * k,
      y = pts[i * 3 + 1] * k;
    const nx = pts[(i + 1) * 3] * k,
      ny = pts[(i + 1) * 3 + 1] * k;
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  ctx.lineTo(pts[(n - 1) * 3] * k, pts[(n - 1) * 3 + 1] * k);
}

function drawPen(ctx, s, k) {
  const pts = s.pts;
  const n = pts.length / 3;
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (!s.pr || n < 3) {
    ctx.lineWidth = s.w * k;
    smoothPath(ctx, pts, k);
    ctx.stroke();
    return;
  }
  // Traço com pressão: segmentos curvos com largura variável.
  let px = pts[0] * k,
    py = pts[1] * k;
  for (let i = 1; i < n; i++) {
    const x = pts[i * 3] * k,
      y = pts[i * 3 + 1] * k;
    const p = pts[i * 3 + 2];
    const last = i === n - 1;
    const ex = last ? x : (x + pts[(i + 1) * 3] * k) / 2;
    const ey = last ? y : (y + pts[(i + 1) * 3 + 1] * k) / 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(x, y, ex, ey);
    ctx.lineWidth = Math.max(0.6, s.w * k * (0.35 + p * 1.3));
    ctx.stroke();
    px = ex;
    py = ey;
  }
}

function drawHighlighter(ctx, s, k) {
  ctx.strokeStyle = s.c;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = s.w * k;
  smoothPath(ctx, s.pts, k);
  ctx.stroke();
}

function drawHlRects(ctx, s, k) {
  ctx.fillStyle = s.c;
  for (const [x, y, w, hh] of s.rects) {
    const r = Math.min(3 * k, (hh * k) / 4);
    ctx.beginPath();
    ctx.roundRect(x * k, y * k, w * k, hh * k, r);
    ctx.fill();
  }
}

function drawShape(ctx, s, k) {
  ctx.strokeStyle = s.c;
  ctx.lineWidth = s.w * k;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const x1 = s.x1 * k,
    y1 = s.y1 * k,
    x2 = s.x2 * k,
    y2 = s.y2 * k;
  ctx.beginPath();
  if (s.kind === 'rect') {
    ctx.roundRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), 4 * k);
  } else if (s.kind === 'ellipse') {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (s.kind === 'arrow') {
      const a = Math.atan2(y2 - y1, x2 - x1);
      const L = Math.max(12 * k, s.w * k * 4);
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45));
    }
  }
  ctx.stroke();
}

export const TEXT_FONT = '"Inter Variable", Inter, system-ui, sans-serif';

function drawImageShape(ctx, s, k) {
  const img = getImage(s.src);
  if (!img.complete || !img.naturalWidth) return;
  ctx.drawImage(img, s.x * k, s.y * k, s.w * k, s.h * k);
}

function drawText(ctx, s, k) {
  ctx.fillStyle = s.c;
  ctx.font = `500 ${s.s * k}px ${TEXT_FONT}`;
  ctx.textBaseline = 'top';
  const lines = s.text.split('\n');
  lines.forEach((ln, i) => ctx.fillText(ln, s.x * k, s.y * k + i * s.s * 1.3 * k));
}

/** Desenha um conjunto de formas. layer: 'hl' (marca-texto) ou 'ink'. */
export function drawShapes(ctx, shapes, k, layer) {
  for (const s of shapes) {
    const isHl = s.t === 'hl' || s.t === 'hlrect';
    if ((layer === 'hl') !== isHl) continue;
    ctx.save();
    if (s.t === 'pen') drawPen(ctx, s, k);
    else if (s.t === 'hl') drawHighlighter(ctx, s, k);
    else if (s.t === 'hlrect') drawHlRects(ctx, s, k);
    else if (s.t === 'shape') drawShape(ctx, s, k);
    else if (s.t === 'text') drawText(ctx, s, k);
    else if (s.t === 'img') drawImageShape(ctx, s, k);
    ctx.restore();
  }
}

/**
 * Renderiza as anotações de uma página em canvases de tamanho arbitrário (exportação).
 * Retorna { hl, ink } — o 'hl' deve ser composto com "multiply".
 */
export function renderShapesToCanvases(shapes, width, height, m = NO_MARGIN) {
  const k = width / (UNIT + m.l + m.r);
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = Math.round(width);
    c.height = Math.round(height);
    return c;
  };
  const hl = mk(),
    ink = mk();
  for (const [c, layer] of [
    [hl, 'hl'],
    [ink, 'ink'],
  ]) {
    const x = c.getContext('2d');
    x.translate(m.l * k, m.t * k);
    drawShapes(x, shapes, k, layer);
  }
  return { hl, ink };
}

// ---------------------------------------------------------------- hit test

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hit(s, x, y, r) {
  if (s.t === 'pen' || s.t === 'hl') {
    const p = s.pts;
    const rr = r + s.w / 2;
    if (p.length === 3) return Math.hypot(x - p[0], y - p[1]) < rr;
    for (let i = 3; i < p.length; i += 3) {
      if (distToSeg(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) < rr) return true;
    }
    return false;
  }
  if (s.t === 'hlrect') return s.rects.some(([rx, ry, w, hh]) => x > rx - r && x < rx + w + r && y > ry - r && y < ry + hh + r);
  if (s.t === 'img') return x > s.x - r && x < s.x + s.w + r && y > s.y - r && y < s.y + s.h + r;
  if (s.t === 'text') return x > s.x - r && x < s.x + (s.bw || 50) + r && y > s.y - r && y < s.y + (s.bh || s.s) + r;
  if (s.t === 'shape') {
    const { x1, y1, x2, y2 } = s;
    const rr = r + s.w / 2;
    if (s.kind === 'line' || s.kind === 'arrow') return distToSeg(x, y, x1, y1, x2, y2) < rr;
    if (s.kind === 'ellipse') {
      const cx = (x1 + x2) / 2,
        cy = (y1 + y2) / 2,
        rx = Math.abs(x2 - x1) / 2 || 1,
        ry = Math.abs(y2 - y1) / 2 || 1;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return Math.abs(d - 1) * Math.min(rx, ry) < rr;
    }
    const minx = Math.min(x1, x2),
      maxx = Math.max(x1, x2),
      miny = Math.min(y1, y2),
      maxy = Math.max(y1, y2);
    return (
      distToSeg(x, y, minx, miny, maxx, miny) < rr ||
      distToSeg(x, y, maxx, miny, maxx, maxy) < rr ||
      distToSeg(x, y, maxx, maxy, minx, maxy) < rr ||
      distToSeg(x, y, minx, maxy, minx, miny) < rr
    );
  }
  return false;
}

// ---------------------------------------------------------------- gerenciador

/**
 * Coordena todas as camadas de um documento: ferramenta, histórico, persistência,
 * e gestos de dois dedos (rolar/zoom) enquanto se desenha no celular/tablet.
 */
export class AnnotationManager {
  constructor({ tools, history, pages = {}, onChange, scroller }) {
    this.tools = tools;
    this.history = history;
    this.pages = pages; // { [key]: shapes[] }
    this.onChange = onChange;
    this.layers = new Map();
    this.scroller = scroller;
    this.penSeen = false;
    this.margin = { ...NO_MARGIN };
    this._offImg = onImagesLoaded(() => this.layers.forEach((l) => l.redraw()));
    ensureImages(pages);
    this._onTool = () => this.layers.forEach((l) => l.updateMode());
    tools.addEventListener('change', this._onTool);
  }
  attach(host, key) {
    const old = this.layers.get(key);
    if (old && old.host === host) {
      old.resize();
      return old;
    }
    old?.destroy();
    const layer = new AnnotationLayer(this, host, key);
    this.layers.set(key, layer);
    return layer;
  }
  detach(key) {
    this.layers.get(key)?.destroy();
    this.layers.delete(key);
  }
  shapes(key) {
    return (this.pages[key] ||= []);
  }
  setShapes(key, shapes) {
    this.pages[key] = shapes;
    if (!shapes.length) delete this.pages[key];
    this.layers.get(key)?.redraw();
    this.onChange?.();
  }
  /** Altera as formas de uma página registrando no histórico. */
  commit(key, next) {
    const before = this.shapes(key).slice();
    this.setShapes(key, next);
    this.history.push({
      undo: () => this.setShapes(key, before.slice()),
      redo: () => this.setShapes(key, next.slice()),
    });
  }
  add(key, shape) {
    this.commit(key, [...this.shapes(key), shape]);
  }
  /**
   * Posição do cursor de texto sob um ponto da tela (dentro da página da camada).
   * strict: exige que o ponto esteja realmente em cima de uma linha de texto.
   */
  caretAt(layer, x, y, strict) {
    const live = layer.live;
    const prev = live.style.pointerEvents;
    live.style.pointerEvents = 'none';
    let node = null,
      offset = 0;
    try {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        node = p?.offsetNode;
        offset = p?.offset ?? 0;
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        node = r?.startContainer;
        offset = r?.startOffset ?? 0;
      }
    } finally {
      live.style.pointerEvents = prev;
    }
    if (!node || node.nodeType !== 3 || !layer.host.contains(node) || !node.textContent.trim()) return null;
    if (node.parentElement?.closest('.page-num, .ann-text-editor')) return null;
    if (strict) {
      const rng = document.createRange();
      rng.selectNodeContents(node);
      const ok = [...rng.getClientRects()].some((r) => y >= r.top - 4 && y <= r.bottom + 4 && x >= r.left - 16 && x <= r.right + 16);
      if (!ok) return null;
    }
    return { node, offset: Math.min(offset, node.length) };
  }
  hasAny() {
    return Object.values(this.pages).some((s) => s.length);
  }
  clearAll() {
    const snapshot = structuredClone(this.pages);
    const keys = Object.keys(snapshot);
    if (!keys.length) return;
    keys.forEach((k) => this.setShapes(k, []));
    this.history.push({
      undo: () => keys.forEach((k) => this.setShapes(k, snapshot[k].slice())),
      redo: () => keys.forEach((k) => this.setShapes(k, [])),
    });
  }
  resizeAll() {
    this.layers.forEach((l) => l.resize());
  }
  /** Escolhe uma imagem do aparelho e coloca na página (reduzida para no máx. 1600 px). */
  pickImage(layer, x, y) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const max = 1600;
        const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * sc);
        c.height = Math.round(img.naturalHeight * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const png = /png|gif|webp|svg/.test(f.type);
        const src = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
        getImage(src);
        layer.addImage(src, c.width, c.height, x, y);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    inp.click();
  }
  setMargin(m) {
    this.margin = { ...NO_MARGIN, ...m };
    this.layers.forEach((l) => {
      l.w = 0; // força recalcular
      l.resize();
    });
  }
  /** Retângulos (em unidades da página) de um trecho de texto selecionado. */
  rectsFor(key, range) {
    const l = this.layers.get(key);
    return l ? rangeToRects(range, l.host, l.geom()) : [];
  }
  destroy() {
    this._offImg?.();
    this.tools.removeEventListener('change', this._onTool);
    this.layers.forEach((l) => l.destroy());
    this.layers.clear();
  }
}

export class AnnotationLayer {
  constructor(manager, host, key) {
    this.m = manager;
    this.host = host;
    this.key = key;
    this.hl = this.mkCanvas('ann-hl');
    this.ink = this.mkCanvas('ann-ink');
    this.live = this.mkCanvas('ann-live');
    this.current = null;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.bind();
    this.resize();
    this.updateMode();
  }
  mkCanvas(cls) {
    const c = document.createElement('canvas');
    c.className = `ann-canvas ${cls}`;
    this.host.appendChild(c);
    return c;
  }
  get shapes() {
    return this.m.shapes(this.key);
  }
  get k() {
    const m = this.m.margin;
    return this.w / (UNIT + m.l + m.r);
  }
  /** Geometria: pixels por unidade e deslocamento da página dentro da margem. */
  geom() {
    const k = this.k;
    return { k, ox: this.m.margin.l * k, oy: this.m.margin.t * k };
  }
  resize() {
    const w = this.host.clientWidth,
      hh = this.host.clientHeight;
    if (!w || !hh) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (w === this.w && hh === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = hh;
    this.dpr = dpr;
    for (const c of [this.hl, this.ink, this.live]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    this.redraw();
  }
  /** Contexto já posicionado na página (desconta a margem). */
  ctx(c) {
    const x = c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, c.width, c.height);
    const { ox, oy } = this.geom();
    x.setTransform(this.dpr, 0, 0, this.dpr, ox * this.dpr, oy * this.dpr);
    return x;
  }
  redraw() {
    if (!this.w) return;
    for (const [c, layer] of [
      [this.hl, 'hl'],
      [this.ink, 'ink'],
    ]) {
      const x = this.ctx(c);
      drawShapes(x, this.shapes, this.k, layer);
    }
  }
  updateMode() {
    const t = this.m.tools;
    const active = DRAW_TOOLS.has(t.tool);
    this.live.classList.toggle('active', active);
    this.live.dataset.tool = active ? t.tool : '';
  }

  // ----------------------------------------------------------- entrada
  pos(e) {
    const r = this.live.getBoundingClientRect();
    const m = this.m.margin;
    const k = r.width / (UNIT + m.l + m.r);
    return [(e.clientX - r.left) / k - m.l, (e.clientY - r.top) / k - m.t];
  }
  bind() {
    const el = this.live;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => this.cancel());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  down(e) {
    const m = this.m;
    if (e.pointerType === 'pen') m.penSeen = true;
    // Rejeição da palma: se já usou caneta stylus, o dedo não desenha.
    if (e.pointerType === 'touch' && (m.penSeen || !e.isPrimary)) {
      this.cancel();
      return;
    }
    if (e.button > 0) return;
    e.preventDefault();
    const tool = m.tools.tool;
    const s = m.tools.settings;
    const [x, y] = this.pos(e);
    this.live.setPointerCapture(e.pointerId);
    this.pointerId = e.pointerId;
    const pr = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    if (tool === 'pen') {
      this.current = { t: 'pen', c: s.pen.color, w: s.pen.size, pts: [x, y, pr], pr: e.pointerType === 'pen' ? 1 : 0 };
    } else if (tool === 'highlighter') {
      // Marca-texto inteligente: se começou em cima de texto, marca o texto por onde o dedo passa.
      const caret = s.highlighter.mode !== 'free' ? this.m.caretAt(this, e.clientX, e.clientY, true) : null;
      if (caret) this.textHl = { start: caret, end: caret, color: s.highlighter.color };
      else {
        this.current = { t: 'hl', c: s.highlighter.color, w: s.highlighter.size, pts: [x, y, 0.5] };
        this.hlStart = [x, y];
      }
    } else if (tool === 'shape') {
      this.current = { t: 'shape', kind: s.shape.kind, c: s.shape.color, w: s.shape.size, x1: x, y1: y, x2: x, y2: y };
    } else if (tool === 'eraser') {
      this.eraseBefore = this.shapes.slice();
      this.erasing = true;
      this.eraseAt(x, y);
      this.m.onEraseText?.(this, e.clientX, e.clientY);
    } else if (tool === 'text') {
      this.textDown = [x, y];
    } else if (tool === 'image') {
      this.imageDown = [x, y];
    }
    this.drawLive();
  }
  move(e) {
    if (e.pointerId !== this.pointerId) {
      if (this.m.tools.tool === 'eraser') this.drawEraserCursor(e);
      return;
    }
    const [x, y] = this.pos(e);
    const c = this.current;
    if (this.textHl) {
      const caret = this.m.caretAt(this, e.clientX, e.clientY, false);
      if (caret) this.textHl.end = caret;
      this.drawTextHl();
      return;
    }
    if (this.erasing) {
      this.eraseAt(x, y);
      this.m.onEraseText?.(this, e.clientX, e.clientY);
      this.drawEraserCursor(e);
      return;
    }
    if (!c) return;
    if (c.t === 'pen' || c.t === 'hl') {
      const events = e.getCoalescedEvents?.() || [e];
      for (const ev of events) {
        const [cx, cy] = this.pos(ev);
        const p = c.pts;
        const lx = p[p.length - 3],
          ly = p[p.length - 2];
        if (Math.hypot(cx - lx, cy - ly) < 0.6) continue;
        if (c.t === 'hl' && e.shiftKey) {
          // Shift = linha reta horizontal
          c.pts = [this.hlStart[0], this.hlStart[1], 0.5, cx, this.hlStart[1], 0.5];
        } else p.push(+cx.toFixed(2), +cy.toFixed(2), ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5);
      }
    } else if (c.t === 'shape') {
      c.x2 = x;
      c.y2 = y;
    }
    this.drawLive();
  }
  up(e) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.erasing) {
      this.erasing = false;
      this.clearLive();
      const before = this.eraseBefore;
      const after = this.shapes.slice();
      if (before.length !== after.length) {
        this.m.history.push({
          undo: () => this.m.setShapes(this.key, before.slice()),
          redo: () => this.m.setShapes(this.key, after.slice()),
        });
        this.m.onChange?.();
      }
      return;
    }
    if (this.textDown) {
      const [x, y] = this.textDown;
      this.textDown = null;
      this.openTextEditor(x, y);
      return;
    }
    if (this.imageDown) {
      const [x, y] = this.imageDown;
      this.imageDown = null;
      if (Date.now() - (this.m.lastImageEdit || 0) < 500) return; // o toque só fechou o editor
      const existing = this.shapes.findLast?.((s) => s.t === 'img' && hit(s, x, y, 0));
      if (existing) this.editImage(existing);
      else this.m.pickImage?.(this, x, y);
      return;
    }
    if (this.textHl) {
      const th = this.textHl;
      this.textHl = null;
      this.clearLive();
      const range = makeRange(th.start, th.end);
      if (!range || range.collapsed) return;
      if (this.m.onTextHighlight?.(this, range, th.color)) return; // o visualizador cuidou (ex.: Word)
      const rects = rangeToRects(range, this.host, this.geom());
      if (rects.length) this.m.add(this.key, { t: 'hlrect', c: th.color, rects });
      return;
    }
    const c = this.current;
    this.current = null;
    this.clearLive();
    if (!c) return;
    if (c.t === 'shape' && Math.hypot(c.x2 - c.x1, c.y2 - c.y1) < 3) return;
    if (c.t === 'shape') ['x1', 'y1', 'x2', 'y2'].forEach((k) => (c[k] = +c[k].toFixed(2)));
    this.m.add(this.key, c);
  }
  cancel() {
    this.current = null;
    this.textHl = null;
    this.erasing = false;
    this.textDown = null;
    this.imageDown = null;
    this.pointerId = null;
    this.clearLive();
  }
  clearLive() {
    if (!this.w) return;
    this.ctx(this.live);
  }
  drawLive() {
    const c = this.current;
    if (!c || !this.w) return;
    const x = this.ctx(this.live);
    if (c.t === 'hl') {
      // Prévia translúcida; ao soltar entra no canvas "multiply".
      x.globalAlpha = 0.55;
      drawHighlighter(x, c, this.k);
    } else drawShapes(x, [c], this.k, 'ink');
  }
  drawTextHl() {
    if (!this.w || !this.textHl) return;
    const x = this.ctx(this.live);
    const range = makeRange(this.textHl.start, this.textHl.end);
    if (!range) return;
    const rects = rangeToRects(range, this.host, this.geom());
    x.globalAlpha = 0.5;
    drawHlRects(x, { c: this.textHl.color, rects }, this.k);
  }
  drawEraserCursor(e) {
    if (!this.w) return;
    const x = this.ctx(this.live);
    const r = this.live.getBoundingClientRect();
    const rad = (this.m.tools.settings.eraser.size * this.k) / 1;
    x.beginPath();
    const g = this.geom();
    x.arc(e.clientX - r.left - g.ox, e.clientY - r.top - g.oy, rad, 0, Math.PI * 2);
    x.fillStyle = 'rgba(120,120,140,0.15)';
    x.strokeStyle = 'rgba(80,80,100,0.6)';
    x.lineWidth = 1;
    x.fill();
    x.stroke();
  }
  eraseAt(x, y) {
    const r = this.m.tools.settings.eraser.size;
    const shapes = this.shapes;
    const keep = shapes.filter((s) => !hit(s, x, y, r));
    if (keep.length !== shapes.length) {
      this.m.pages[this.key] = keep;
      this.redraw();
    }
  }

  // ----------------------------------------------------------- imagens
  /** Adiciona uma imagem (dataURL) centrada em (x,y) e já abre para ajustar. */
  addImage(src, natW, natH, x, y) {
    const pageH = (this.h / this.k) - this.m.margin.t - this.m.margin.b;
    let w = Math.min(450, natW);
    let hh = (w * natH) / natW;
    if (hh > pageH * 0.6) {
      hh = pageH * 0.6;
      w = (hh * natW) / natH;
    }
    const shape = { t: 'img', src, x: +(x - w / 2).toFixed(1), y: +(y - hh / 2).toFixed(1), w: +w.toFixed(1), h: +hh.toFixed(1) };
    this.m.add(this.key, shape);
    this.editImage(shape);
  }

  /** Caixa para mover/redimensionar/apagar uma imagem importada. */
  editImage(shape) {
    this.host.querySelector('.img-editor')?.remove();
    const idx = this.shapes.indexOf(shape);
    if (idx < 0) return;
    const orig = { ...shape };
    const box = document.createElement('div');
    box.className = 'img-editor';
    box.innerHTML = `<img alt=""><span class="ie-handle" data-h="se"></span><div class="ie-bar"><button data-a="del" title="Apagar imagem">🗑</button><button data-a="ok" title="Pronto">✓</button></div>`;
    box.querySelector('img').src = shape.src;
    this.host.appendChild(box);
    // esconde a imagem do canvas enquanto edita
    const temp = { ...shape };
    const others = this.shapes.filter((s) => s !== shape);
    this.m.pages[this.key] = others;
    this.redraw();
    const place = () => {
      const { k, ox, oy } = this.geom();
      Object.assign(box.style, { left: `${temp.x * k + ox}px`, top: `${temp.y * k + oy}px`, width: `${temp.w * k}px`, height: `${temp.h * k}px` });
    };
    place();
    let drag = null;
    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      box.setPointerCapture(e.pointerId);
      drag = { mode: e.target.dataset.h ? 'resize' : 'move', sx: e.clientX, sy: e.clientY, start: { ...temp } };
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = this.k;
      const dx = (e.clientX - drag.sx) / k,
        dy = (e.clientY - drag.sy) / k;
      if (drag.mode === 'move') {
        temp.x = +(drag.start.x + dx).toFixed(1);
        temp.y = +(drag.start.y + dy).toFixed(1);
      } else {
        const ratio = drag.start.h / drag.start.w;
        temp.w = +Math.max(30, drag.start.w + dx).toFixed(1);
        temp.h = +(temp.w * ratio).toFixed(1);
      }
      place();
    });
    box.addEventListener('pointerup', () => (drag = null));
    const finish = (del) => {
      this.m.lastImageEdit = Date.now();
      box.remove();
      document.removeEventListener('pointerdown', outside, true);
      const before = [...others.slice(0, idx), orig, ...others.slice(idx)];
      this.m.pages[this.key] = before;
      const after = del ? others : [...others.slice(0, idx), temp, ...others.slice(idx)];
      if (JSON.stringify(after) !== JSON.stringify(before)) this.m.commit(this.key, after);
      else this.redraw();
    };
    const outside = (e) => {
      if (!box.contains(e.target)) finish(false);
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    box.querySelector('[data-a="del"]').onclick = () => finish(true);
    box.querySelector('[data-a="ok"]').onclick = () => finish(false);
  }

  // ----------------------------------------------------------- texto
  openTextEditor(x, y) {
    const existing = this.shapes.findLast?.((s) => s.t === 'text' && hit(s, x, y, 2));
    const st = this.m.tools.settings.text;
    const shape = existing ? { ...existing } : { t: 'text', c: st.color, s: st.size, x, y, text: '' };
    if (existing) {
      // esconde enquanto edita
      this.m.pages[this.key] = this.shapes.filter((s) => s !== existing);
      this.redraw();
    }
    const { k, ox, oy } = this.geom();
    const ta = document.createElement('textarea');
    ta.className = 'ann-text-editor';
    ta.value = shape.text;
    ta.placeholder = 'Escreva aqui…';
    Object.assign(ta.style, {
      left: `${shape.x * k + ox}px`,
      top: `${shape.y * k + oy}px`,
      fontSize: `${shape.s * k}px`,
      color: shape.c,
      fontFamily: TEXT_FONT,
    });
    this.host.appendChild(ta);
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.width = 'auto';
      ta.style.height = `${ta.scrollHeight + 2}px`;
      ta.style.width = `${Math.min(this.w - shape.x * k - ox, Math.max(120, ta.scrollWidth + 8))}px`;
    };
    ta.addEventListener('input', grow);
    ta.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      grow();
      ta.focus({ preventScroll: true });
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const text = ta.value.replace(/\s+$/, '');
      ta.remove();
      if (existing) this.m.pages[this.key] = [...this.shapes, existing]; // restaura p/ o histórico
      const without = this.shapes.filter((s) => s !== existing);
      if (!text) {
        if (existing) this.m.commit(this.key, without);
        else this.redraw();
        return;
      }
      shape.text = text;
      // mede caixa em unidades
      const mc = document.createElement('canvas').getContext('2d');
      mc.font = `500 ${shape.s}px ${TEXT_FONT}`;
      const lines = text.split('\n');
      shape.bw = Math.max(...lines.map((l) => mc.measureText(l).width));
      shape.bh = lines.length * shape.s * 1.3;
      this.m.commit(this.key, [...without, shape]);
    };
    ta.addEventListener('blur', finish);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) ta.blur();
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  destroy() {
    this.ro.disconnect();
    this.hl.remove();
    this.ink.remove();
    this.live.remove();
    this.host.querySelectorAll('.ann-text-editor').forEach((t) => t.blur());
  }
}

/** Estende o Range para começar e terminar em palavras inteiras (o dedo é impreciso). */
export function snapWords(r) {
  const isW = (ch) => !!ch && !/[\s.,;:!?()\[\]{}"“”'«»—–-]/.test(ch);
  const sc = r.startContainer,
    ec = r.endContainer;
  if (sc.nodeType === 3) {
    let o = r.startOffset;
    const t = sc.textContent;
    while (o < t.length && /\s/.test(t[o])) o++; // não começa em espaço
    while (o > 0 && isW(t[o - 1]) && isW(t[o])) o--;
    r.setStart(sc, Math.min(o, t.length));
  }
  if (ec.nodeType === 3) {
    let o = r.endOffset;
    const t = ec.textContent;
    while (o > 0 && /\s/.test(t[o - 1])) o--; // não termina em espaço
    while (o < t.length && isW(t[o]) && isW(t[o - 1])) o++;
    if (ec !== r.startContainer || o >= r.startOffset) r.setEnd(ec, o);
  }
  return r;
}

/** Cria um Range entre duas posições de cursor, na ordem certa. */
export function makeRange(a, b) {
  try {
    const r = document.createRange();
    let forward = true;
    if (a.node === b.node) forward = b.offset >= a.offset;
    else forward = !!(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING);
    const [s, e] = forward ? [a, b] : [b, a];
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    return snapWords(r);
  } catch {
    return null;
  }
}

/**
 * Converte uma seleção de texto (Range) em retângulos de marca-texto
 * relativos a um elemento-página. Junta pedaços da mesma linha.
 */
export function rangeToRects(range, pageEl, geom) {
  const pr = pageEl.getBoundingClientRect();
  // px -> unidades (descontando a margem, se houver)
  const k = geom ? 1 / geom.k : UNIT / pr.width;
  const ox = geom ? geom.ox : 0,
    oy = geom ? geom.oy : 0;
  const raw = [...range.getClientRects()]
    .filter((r) => r.width > 1 && r.height > 1)
    .map((r) => {
      const left = Math.max(r.left, pr.left),
        right = Math.min(r.right, pr.right);
      const top = Math.max(r.top, pr.top),
        bottom = Math.min(r.bottom, pr.bottom);
      return right > left && bottom > top ? [(left - pr.left - ox) * k, (top - pr.top - oy) * k, (right - left) * k, (bottom - top) * k] : null;
    })
    .filter(Boolean)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines = [];
  for (const r of raw) {
    const last = lines[lines.length - 1];
    const sameLine = last && Math.abs(last[1] + last[3] / 2 - (r[1] + r[3] / 2)) < Math.min(last[3], r[3]) * 0.5;
    if (sameLine && r[0] <= last[0] + last[2] + 8) {
      const x1 = Math.min(last[0], r[0]);
      const x2 = Math.max(last[0] + last[2], r[0] + r[2]);
      const y1 = Math.min(last[1], r[1]);
      const y2 = Math.max(last[1] + last[3], r[1] + r[3]);
      lines[lines.length - 1] = [x1, y1, x2 - x1, y2 - y1];
    } else lines.push(r);
  }
  return lines.map((r) => r.map((v) => +v.toFixed(2)));
}

export { hexToRgba };
