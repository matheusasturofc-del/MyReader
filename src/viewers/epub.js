// Livros EPUB (epub.js): leitura paginada ou contínua, sumário, tamanho da letra,
// temas (claro/sépia/noturno) e marca-texto com exportação dos destaques.
import ePub from 'epubjs';
import { h, esc, download, baseName } from '../util.js';
import { icon } from '../icons.js';
import { PALETTES } from '../annotations.js';
import { showSelectionMenu, hideSelectionMenu, toast, confirmDialog } from '../ui.js';

const THEMES = {
  white: { body: { color: '#1b1b1f', background: '#ffffff' } },
  sepia: { body: { color: '#4a3b28', background: '#f6ecd9' } },
  night: { body: { color: '#d9d9de', background: '#16171c' }, a: { color: '#9db4ff' } },
};

export default class EpubViewer {
  annotatable = false;
  minZoom = 0.6;
  maxZoom = 2.5;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
    ctx.state.epubHl ||= [];
    this.flow = ctx.state.flow || 'paginated';
  }

  async mount() {
    const { ctx } = this;
    this.el = h(`
      <div class="epub-wrap">
        <button class="epub-nav prev" aria-label="Página anterior">${icon('chevron-left', 26)}</button>
        <div class="epub-book page-host"><div class="epub-view"></div></div>
        <button class="epub-nav next" aria-label="Próxima página">${icon('chevron-right', 26)}</button>
        <div class="epub-progress"><div class="bar"><i></i></div><span></span></div>
      </div>`);
    ctx.content.classList.add('fill-content');
    ctx.content.appendChild(this.el);
    this.book = ePub(await ctx.blob.arrayBuffer());
    await this.book.ready;
    this.createRendition();
    await this.rendition.display(ctx.state.cfi || undefined);

    this.el.querySelector('.prev').onclick = () => this.rendition.prev();
    this.el.querySelector('.next').onclick = () => this.rendition.next();

    this.buildSlot();
    this.book.loaded.navigation.then((nav) => (this.toc = nav.toc));
    this.book.locations.generate(1200).then(() => this.updateProgress());

    // acompanha a cor do papel escolhida no menu
    this.mo = new MutationObserver(() => this.applyTheme());
    this.mo.observe(ctx.stage, { attributes: true, attributeFilter: ['class'] });
    this.makeThumb();
  }

  createRendition() {
    const view = this.el.querySelector('.epub-view');
    view.innerHTML = '';
    this.rendition = this.book.renderTo(view, {
      width: '100%',
      height: '100%',
      flow: this.flow === 'scrolled' ? 'scrolled-doc' : 'paginated',
      spread: 'auto',
      allowScriptedContent: false,
    });
    const r = this.rendition;
    Object.entries(THEMES).forEach(([k, v]) => r.themes.register(k, v));
    r.themes.default({ '::selection': { background: 'rgba(109,93,252,.28)' }, body: { 'font-family': 'Georgia, "Times New Roman", serif', 'line-height': '1.6' } });
    this.applyTheme();
    r.themes.fontSize(`${Math.round(this.zoom * 100)}%`);
    r.on('relocated', (loc) => {
      this.loc = loc;
      this.ctx.state.cfi = loc.start.cfi;
      this.ctx.saveState();
      this.updateProgress();
      hideSelectionMenu();
    });
    r.on('selected', (cfiRange, contents) => this.onSelected(cfiRange, contents));
    r.on('keyup', (e) => this.onKey(e));
    r.hooks.content.register((contents) => {
      // gesto de deslizar para virar página
      const d = contents.document;
      let sx = null;
      d.addEventListener('touchstart', (e) => (sx = e.touches.length === 1 ? e.touches[0].clientX : null), { passive: true });
      d.addEventListener('touchend', (e) => {
        if (sx == null || this.flow === 'scrolled') return;
        const dx = e.changedTouches[0].clientX - sx;
        if (Math.abs(dx) > 60 && d.getSelection()?.isCollapsed) dx < 0 ? r.next() : r.prev();
      });
    });
    for (const hl of this.ctx.state.epubHl) this.drawHl(hl);
  }

  applyTheme() {
    const paper = this.ctx.state.paper || 'white';
    this.rendition?.themes.select(paper);
    this.el.dataset.paper = paper;
  }

  drawHl(hl) {
    try {
      this.rendition.annotations.highlight(hl.cfi, { id: hl.cfi }, () => this.removeHl(hl), 'mr-epub-hl', {
        fill: hl.color,
        'fill-opacity': '0.5',
        'mix-blend-mode': 'multiply',
      });
    } catch (e) {
      console.warn(e);
    }
  }

  async removeHl(hl) {
    if (!(await confirmDialog('Remover destaque?', `<blockquote>${esc(hl.text.slice(0, 200))}</blockquote>`, 'Remover', true))) return;
    this.rendition.annotations.remove(hl.cfi, 'highlight');
    this.ctx.state.epubHl = this.ctx.state.epubHl.filter((x) => x !== hl);
    this.ctx.saveState();
  }

  onSelected(cfiRange, contents) {
    const range = contents.range(cfiRange);
    const text = range.toString().trim();
    if (!text) return;
    const fr = contents.document.defaultView.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
    const rr = range.getBoundingClientRect();
    const rect = { left: fr.left + rr.left, top: fr.top + rr.top, width: rr.width, bottom: fr.top + rr.bottom };
    showSelectionMenu(rect, {
      colors: PALETTES.highlighter.slice(0, 5),
      onHighlight: (color) => {
        const hl = { cfi: cfiRange, color, text, at: Date.now(), chapter: this.chapterLabel() };
        this.ctx.state.epubHl.push(hl);
        this.ctx.saveState();
        this.drawHl(hl);
        contents.window.getSelection()?.removeAllRanges();
      },
      onCopy: () => navigator.clipboard?.writeText(text).then(() => toast('Texto copiado')),
    });
  }

  chapterLabel() {
    const href = this.loc?.start?.href;
    const find = (items) => {
      for (const it of items || []) {
        if (href && it.href && href.includes(it.href.split('#')[0])) return it.label.trim();
        const sub = find(it.subitems);
        if (sub) return sub;
      }
    };
    return find(this.toc) || '';
  }

  updateProgress() {
    const bar = this.el.querySelector('.epub-progress i');
    const lbl = this.el.querySelector('.epub-progress span');
    const cfi = this.loc?.start?.cfi;
    if (!cfi) return;
    let pct = null;
    try {
      if (this.book.locations.length()) pct = this.book.locations.percentageFromCfi(cfi);
    } catch {}
    if (pct != null) {
      bar.style.width = `${(pct * 100).toFixed(1)}%`;
      lbl.textContent = `${Math.round(pct * 100)}%${this.chapterLabel() ? ` · ${this.chapterLabel()}` : ''}`;
    } else lbl.textContent = this.chapterLabel();
  }

  buildSlot() {
    const s = h(`
      <div class="pdf-nav">
        <button class="icon-btn sm" data-a="toc" title="Sumário" aria-label="Sumário">${icon('sidebar', 18)}</button>
        <button class="icon-btn sm" data-a="hls" title="Meus destaques" aria-label="Meus destaques">${icon('highlighter', 18)}</button>
      </div>`);
    this.ctx.slot.appendChild(s);
    s.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'toc') this.toggleSide('toc');
      if (a === 'hls') this.toggleSide('hls');
    });
  }

  toggleSide(which) {
    const side = this.ctx.side;
    if (!side.hidden && this.sideMode === which) {
      side.hidden = true;
      this.ctx.root.classList.remove('side-open');
      return;
    }
    this.sideMode = which;
    side.innerHTML = '';
    if (which === 'toc') {
      const list = h('<nav class="toc"><h4>Sumário</h4></nav>');
      const add = (items, depth) => {
        for (const it of items || []) {
          const b = h(`<button style="padding-left:${12 + depth * 14}px">${esc(it.label.trim())}</button>`);
          b.onclick = () => {
            this.rendition.display(it.href);
            if (innerWidth < 720) this.toggleSide('toc');
          };
          list.appendChild(b);
          add(it.subitems, depth + 1);
        }
      };
      add(this.toc, 0);
      if (!this.toc?.length) list.appendChild(h('<p class="muted">Este livro não tem sumário.</p>'));
      side.appendChild(list);
    } else {
      const list = h('<nav class="toc"><h4>Meus destaques</h4></nav>');
      const hls = this.ctx.state.epubHl;
      if (!hls.length) list.appendChild(h('<p class="muted">Selecione um trecho do livro e escolha uma cor para destacar.</p>'));
      for (const hl of hls) {
        const b = h(`<button class="hl-item" style="--c:${hl.color}"><span>${esc(hl.text.slice(0, 180))}</span>${hl.chapter ? `<small>${esc(hl.chapter)}</small>` : ''}</button>`);
        b.onclick = () => this.rendition.display(hl.cfi);
        list.appendChild(b);
      }
      side.appendChild(list);
    }
    side.hidden = false;
    this.ctx.root.classList.add('side-open');
  }

  setZoom(z) {
    this.zoom = z;
    this.ctx.state.zoom = z;
    this.ctx.saveState();
    this.rendition.themes.fontSize(`${Math.round(z * 100)}%`);
  }

  onKey(e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') this.rendition.next();
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.rendition.prev();
  }

  onResize() {
    try {
      this.rendition.resize();
    } catch {}
  }

  moreItems() {
    return [
      '-',
      {
        label: this.flow === 'scrolled' ? 'Modo livro (páginas)' : 'Rolagem contínua',
        icon: this.flow === 'scrolled' ? 'book' : 'columns',
        run: async () => {
          this.flow = this.flow === 'scrolled' ? 'paginated' : 'scrolled';
          this.ctx.state.flow = this.flow;
          this.ctx.saveState();
          const cfi = this.ctx.state.cfi;
          this.rendition.destroy();
          this.el.classList.toggle('scrolled', this.flow === 'scrolled');
          this.createRendition();
          await this.rendition.display(cfi || undefined);
        },
      },
    ];
  }

  async makeThumb() {
    if (this.ctx.rec.thumb) return;
    try {
      const url = await this.book.coverUrl();
      if (!url) return;
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      const k = 360 / img.naturalWidth;
      c.width = 360;
      c.height = img.naturalHeight * k;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      this.ctx.setThumb(c.toDataURL('image/jpeg', 0.8));
    } catch {}
  }

  exports() {
    const name = baseName(this.ctx.rec.name);
    return [
      {
        label: 'Exportar destaques',
        icon: 'highlighter',
        hint: '.md',
        run: () => {
          const hls = this.ctx.state.epubHl;
          if (!hls.length) return toast('Você ainda não destacou nenhum trecho.');
          const md = `# Destaques — ${name}\n\n` + hls.map((x) => `> ${x.text.replace(/\n+/g, ' ')}\n${x.chapter ? `\n— *${x.chapter}*\n` : ''}`).join('\n');
          download(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${name} - destaques.md`);
        },
      },
      { label: 'Livro EPUB original', icon: 'download', run: () => download(this.ctx.blob, this.ctx.rec.name) },
    ];
  }

  destroy() {
    this.mo?.disconnect();
    try {
      this.rendition?.destroy();
      this.book?.destroy();
    } catch {}
  }
}
