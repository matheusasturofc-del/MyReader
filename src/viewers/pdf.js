// Leitor de PDF (pdf.js) com camada de texto selecionável, anotações por página,
// marca-texto sobre o texto, busca, miniaturas e exportação com anotações.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import './pdf-textlayer.css';
import { h, esc, download, baseName, clamp, debounce, canvasToBlob } from '../util.js';
import { icon } from '../icons.js';
import { rangeToRects, renderShapesToCanvases, PALETTES } from '../annotations.js';
import { showSelectionMenu, hideSelectionMenu, dialog, toast } from '../ui.js';
import { exportAnnotatedPdf } from '../export/pdf-export.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default class PdfViewer {
  annotatable = true;
  textHighlight = true;
  minZoom = 0.3;
  maxZoom = 6;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
    this.pages = []; // { el, canvas, tl, n, renderedScale, task, dims }
    this.textCache = new Map();
  }

  async mount() {
    const { ctx } = this;
    const buf = await ctx.blob.arrayBuffer();
    this.bytes = new Uint8Array(buf.slice(0)); // cópia para exportar (pdf.js transfere o buffer)
    const task = pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false });
    task.onPassword = async (update, reason) => {
      const pw = await dialog({
        title: reason === 2 ? 'Senha incorreta' : 'PDF protegido',
        body: '<p>Digite a senha para abrir este documento.</p>',
        input: { placeholder: 'Senha' },
        buttons: [
          { label: 'Cancelar', value: false },
          { label: 'Abrir', value: true, primary: true },
        ],
      });
      if (typeof pw === 'string') update(pw);
      else task.destroy();
    };
    this.loadingTask = task;
    this.pdf = await task.promise;
    this.n = this.pdf.numPages;
    const p1 = await this.pdf.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    this.base = { w: vp.width, h: vp.height };

    this.wrap = h('<div class="pdf-pages"></div>');
    for (let n = 1; n <= this.n; n++) {
      const el = h(`<div class="page-host pdf-page" data-n="${n}"><canvas class="pdf-canvas"></canvas><div class="textLayer"></div><span class="page-num">${n}</span></div>`);
      this.wrap.appendChild(el);
      this.pages.push({ n, el, canvas: el.firstChild, tl: el.children[1], dims: n === 1 ? this.base : null });
    }
    ctx.content.appendChild(this.wrap);
    this.layout();

    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { root: ctx.stage, rootMargin: '1200px 0px' });
    this.pages.forEach((p) => this.io.observe(p.el));

    this.buildSlot();
    this.trackCurrentPage();
    this.bindSelection();

    // restaura posição
    const startPage = clamp(ctx.state.page || 1, 1, this.n);
    if (startPage > 1) requestAnimationFrame(() => this.goTo(startPage, false));

    if (!ctx.rec.thumb) this.makeThumb(p1);
  }

  // ---------------------------------------------------------------- layout & render
  get fitScale() {
    const avail = this.ctx.stage.clientWidth - (innerWidth < 720 ? 16 : 64);
    return clamp(avail, 200, 1000) / this.base.w;
  }
  get scale() {
    return this.fitScale * this.zoom;
  }
  layout() {
    const s = this.scale;
    for (const p of this.pages) {
      const d = p.dims || this.base;
      p.el.style.width = `${Math.floor(d.w * s)}px`;
      p.el.style.height = `${Math.floor(d.h * s)}px`;
      p.el.style.setProperty('--scale-factor', s);
      p.el.style.setProperty('--total-scale-factor', s);
    }
  }
  setZoom(z) {
    this.zoom = z;
    this.layout();
    this.ctx.state.zoom = z;
    this.ctx.saveState();
    this.rerenderVisible();
  }
  onResize() {
    this.layout();
    this.rerenderVisible();
  }
  rerenderVisible = debounce(() => {
    for (const p of this.pages) if (p.visible) this.render(p);
  }, 120);

  onIntersect(entries) {
    for (const e of entries) {
      const p = this.pages[+e.target.dataset.n - 1];
      p.visible = e.isIntersecting;
      if (e.isIntersecting) this.render(p);
      else this.release(p);
    }
  }

  async render(p) {
    const scale = this.scale;
    if (p.renderedScale === scale || p.rendering === scale) return;
    p.rendering = scale;
    try {
      const page = (p.page ||= await this.pdf.getPage(p.n));
      if (!p.dims) {
        const v = page.getViewport({ scale: 1 });
        p.dims = { w: v.width, h: v.height };
        if (Math.abs(p.dims.w - this.base.w) > 1 || Math.abs(p.dims.h - this.base.h) > 1) this.layout();
      }
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Limita o tamanho do canvas para não estourar memória em zoom alto.
      const maxPx = 16e6;
      const r = Math.min(dpr, Math.sqrt(maxPx / (vp.width * vp.height)));
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.width = Math.floor(vp.width * r);
      canvas.height = Math.floor(vp.height * r);
      p.task?.cancel();
      p.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: r !== 1 ? [r, 0, 0, r, 0, 0] : null });
      await p.task.promise;
      if (p.rendering !== scale) return;
      p.canvas.replaceWith(canvas);
      p.canvas = canvas;
      // camada de texto
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      p.tl.replaceWith(tl);
      p.tl = tl;
      const textLayer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
      await textLayer.render();
      p.renderedScale = scale;
      this.ctx.ann.attach(p.el, `p${p.n}`);
      if (this.searchQuery) this.markSearch(p);
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn(err);
    } finally {
      if (p.rendering === scale) p.rendering = null;
    }
  }

  release(p) {
    if (!p.renderedScale && !p.rendering) return;
    p.task?.cancel();
    p.rendering = null;
    p.renderedScale = null;
    p.canvas.width = 0;
    p.canvas.height = 0;
    p.tl.innerHTML = '';
    this.ctx.ann.detach(`p${p.n}`);
    p.page?.cleanup();
    p.page = null;
  }

  // ---------------------------------------------------------------- navegação
  buildSlot() {
    const { ctx } = this;
    this.slotEl = h(`
      <div class="pdf-nav">
        <button class="icon-btn sm" data-a="side" title="Miniaturas" aria-label="Miniaturas">${icon('sidebar', 18)}</button>
        <div class="page-box"><input type="text" inputmode="numeric" value="1" aria-label="Página"><span>/ ${this.n}</span></div>
        <button class="icon-btn sm" data-a="search" title="Buscar (Ctrl+F)" aria-label="Buscar">${icon('search', 18)}</button>
      </div>`);
    ctx.slot.appendChild(this.slotEl);
    this.pageInput = this.slotEl.querySelector('input');
    this.pageInput.addEventListener('change', () => this.goTo(clamp(parseInt(this.pageInput.value) || 1, 1, this.n)));
    this.pageInput.addEventListener('focus', () => this.pageInput.select());
    this.slotEl.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'side') this.toggleSide();
      if (a === 'search') this.search();
    });
  }

  trackCurrentPage() {
    const update = debounce(() => {
      const st = this.ctx.stage;
      const mid = st.scrollTop + st.clientHeight * 0.35;
      let cur = 1;
      for (const p of this.pages) {
        if (p.el.offsetTop <= mid) cur = p.n;
        else break;
      }
      if (cur !== this.current) {
        this.current = cur;
        if (document.activeElement !== this.pageInput) this.pageInput.value = cur;
        this.ctx.state.page = cur;
        this.ctx.saveState();
        this.sideEl?.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('on', +t.dataset.n === cur));
      }
    }, 80);
    this.ctx.stage.addEventListener('scroll', update, { passive: true });
    this.onScroll = update;
  }

  goTo(n, smooth = true) {
    const p = this.pages[n - 1];
    if (!p) return;
    this.ctx.stage.scrollTo({ top: p.el.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
  }

  onKey(e) {
    if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !e.shiftKey)) {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.goTo(Math.min(this.n, (this.current || 1) + 1));
      }
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.goTo(Math.max(1, (this.current || 1) - 1));
    }
  }

  toggleSide() {
    const side = this.ctx.side;
    if (!this.sideEl) {
      this.sideEl = h('<div class="thumbs"></div>');
      side.appendChild(this.sideEl);
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const t = e.target;
            io.unobserve(t);
            this.renderThumb(+t.dataset.n, t.querySelector('canvas'));
          }
        },
        { root: side, rootMargin: '300px' },
      );
      for (let n = 1; n <= this.n; n++) {
        const d = this.pages[n - 1].dims || this.base;
        const t = h(`<button class="thumb ${n === this.current ? 'on' : ''}" data-n="${n}"><canvas style="aspect-ratio:${d.w}/${d.h}"></canvas><span>${n}</span></button>`);
        t.onclick = () => {
          this.goTo(n);
          if (innerWidth < 720) this.toggleSide();
        };
        this.sideEl.appendChild(t);
        io.observe(t);
      }
      this.thumbIO = io;
    }
    side.hidden = !side.hidden;
    this.ctx.root.classList.toggle('side-open', !side.hidden);
    setTimeout(() => this.onResize(), 260);
  }

  async renderThumb(n, canvas) {
    const page = await this.pdf.getPage(n);
    const v = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 220 / v.width });
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const shapes = this.ctx.ann.pages[`p${n}`];
    if (shapes?.length) {
      const { hl, ink } = renderShapesToCanvases(shapes, vp.width, vp.height);
      const x = canvas.getContext('2d');
      x.globalCompositeOperation = 'multiply';
      x.drawImage(hl, 0, 0);
      x.globalCompositeOperation = 'source-over';
      x.drawImage(ink, 0, 0);
    }
  }

  async makeThumb(page) {
    try {
      const v = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 360 / v.width });
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      this.ctx.setThumb(c.toDataURL('image/jpeg', 0.75));
    } catch {}
  }

  // ---------------------------------------------------------------- seleção → marca-texto
  bindSelection() {
    const stage = this.ctx.stage;
    const onDown = (e) => {
      hideSelectionMenu();
      const tl = e.target.closest?.('.textLayer');
      if (tl) tl.classList.add('selecting');
    };
    const onUp = () => {
      stage.querySelectorAll('.textLayer.selecting').forEach((t) => t.classList.remove('selecting'));
      setTimeout(() => this.handleSelection(), 10);
    };
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointerup', onUp);
    this.selHandlers = { onDown, onUp };
  }

  handleSelection() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) return;
    const touched = this.pages.filter((p) => p.renderedScale && range.intersectsNode(p.tl));
    if (!touched.length) return;
    const apply = (color) => {
      for (const p of touched) {
        const rects = rangeToRects(range, p.el);
        if (rects.length) this.ctx.ann.add(`p${p.n}`, { t: 'hlrect', c: color, rects });
      }
      sel.removeAllRanges();
    };
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] || range.getBoundingClientRect();
    const first = rects[0] || last;
    showSelectionMenu(
      { left: first.left, top: first.top, width: Math.max(10, last.right - first.left), bottom: last.bottom },
      {
        colors: PALETTES.highlighter.slice(0, 5),
        onHighlight: apply,
        onCopy: () => navigator.clipboard?.writeText(text).then(() => toast('Texto copiado')),
      },
    );
  }

  // ---------------------------------------------------------------- busca
  search() {
    const sub = this.ctx.sub;
    if (this.searchBar) {
      this.searchBar.querySelector('input').focus();
      return;
    }
    this.searchBar = h(`
      <div class="searchbar">
        ${icon('search', 18)}
        <input type="search" placeholder="Buscar no documento…" aria-label="Buscar no documento">
        <span class="sb-count"></span>
        <button class="icon-btn sm" data-a="prev" aria-label="Anterior">${icon('chevron-up', 18)}</button>
        <button class="icon-btn sm" data-a="next" aria-label="Próximo">${icon('chevron-down', 18)}</button>
        <button class="icon-btn sm" data-a="close" aria-label="Fechar busca">${icon('x', 18)}</button>
      </div>`);
    sub.appendChild(this.searchBar);
    const input = this.searchBar.querySelector('input');
    const count = this.searchBar.querySelector('.sb-count');
    let hits = [];
    let idx = -1;
    const run = debounce(async () => {
      const q = norm(input.value.trim());
      this.searchQuery = q;
      this.pages.forEach((p) => this.markSearch(p));
      hits = [];
      idx = -1;
      if (q.length < 2) {
        count.textContent = '';
        return;
      }
      count.textContent = '…';
      for (let n = 1; n <= this.n; n++) {
        const txt = await this.pageText(n);
        if (this.searchQuery !== q) return;
        let i = txt.indexOf(q);
        while (i !== -1) {
          hits.push(n);
          i = txt.indexOf(q, i + q.length);
        }
      }
      count.textContent = hits.length ? `${hits.length} resultado${hits.length > 1 ? 's' : ''}` : 'Nada encontrado';
      if (hits.length) step(1);
    }, 250);
    const step = (d) => {
      if (!hits.length) return;
      idx = (idx + d + hits.length) % hits.length;
      count.textContent = `${idx + 1} de ${hits.length}`;
      this.goTo(hits[idx]);
    };
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') close();
    });
    const close = () => {
      this.searchBar.remove();
      this.searchBar = null;
      this.searchQuery = '';
      this.pages.forEach((p) => this.markSearch(p));
    };
    this.searchBar.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'prev') step(-1);
      if (a === 'next') step(1);
      if (a === 'close') close();
    });
    input.focus();
  }

  async pageText(n) {
    if (!this.textCache.has(n)) {
      const page = await this.pdf.getPage(n);
      const tc = await page.getTextContent();
      this.textCache.set(n, norm(tc.items.map((i) => i.str + (i.hasEOL ? ' ' : '')).join('')));
    }
    return this.textCache.get(n);
  }

  markSearch(p) {
    const q = this.searchQuery;
    p.tl.querySelectorAll('.search-hit').forEach((s) => s.classList.remove('search-hit'));
    if (!q || q.length < 2) return;
    const words = q.split(/\s+/).filter((w) => w.length > 1);
    p.tl.querySelectorAll('span').forEach((s) => {
      const t = norm(s.textContent);
      if (t.includes(q) || (words.length > 1 && words.some((w) => t.includes(w)))) s.classList.add('search-hit');
    });
  }

  // ---------------------------------------------------------------- exportação
  exports() {
    const name = baseName(this.ctx.rec.name);
    return [
      {
        label: 'PDF com anotações',
        icon: 'file-down',
        hint: '.pdf',
        run: async () => {
          const blob = await exportAnnotatedPdf({ bytes: this.bytes, pdfjsDoc: this.pdf, annotations: this.ctx.ann.pages });
          download(blob, `${name} (anotado).pdf`);
        },
      },
      {
        label: 'Página atual como imagem',
        icon: 'image',
        hint: '.png',
        run: async () => {
          const n = this.current || 1;
          const page = await this.pdf.getPage(n);
          const vp = page.getViewport({ scale: 2.5 });
          const c = document.createElement('canvas');
          c.width = vp.width;
          c.height = vp.height;
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          const shapes = this.ctx.ann.pages[`p${n}`] || [];
          const { hl, ink } = renderShapesToCanvases(shapes, c.width, c.height);
          const x = c.getContext('2d');
          x.globalCompositeOperation = 'multiply';
          x.drawImage(hl, 0, 0);
          x.globalCompositeOperation = 'source-over';
          x.drawImage(ink, 0, 0);
          download(await canvasToBlob(c), `${name} - página ${n}.png`);
        },
      },
      { label: 'PDF original', icon: 'download', hint: '.pdf', run: () => download(this.ctx.blob, this.ctx.rec.name) },
    ];
  }

  destroy() {
    this.io?.disconnect();
    this.thumbIO?.disconnect();
    this.ctx.stage.removeEventListener('scroll', this.onScroll);
    if (this.selHandlers) {
      this.ctx.stage.removeEventListener('pointerdown', this.selHandlers.onDown);
      this.ctx.stage.removeEventListener('pointerup', this.selHandlers.onUp);
    }
    this.loadingTask?.destroy();
  }
}

export { esc };
