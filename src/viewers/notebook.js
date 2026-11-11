// Caderno digital: folhas pautadas/quadriculadas/pontilhadas para escrever à mão
// com caneta ou dedo. Exporta como PDF.
import { h, download, baseName } from '../util.js';
import { icon } from '../icons.js';
import { pagesToPdf, compositeAnnotations } from '../export/pdf-export.js';
import { confirmDialog, popover } from '../ui.js';

// Tamanhos de folha do caderno (cm, retrato)
const SIZES = [
  ['a4', 'A4', 21, 29.7],
  ['letter', 'Carta', 21.59, 27.94],
  ['a5', 'A5', 14.8, 21],
  ['legal', 'Ofício', 21.59, 35.56],
  ['square', 'Quadrado', 21, 21],
  ['wide', 'Tela 16:9', 29.7, 16.7],
];
const PATTERNS = [
  ['lined', 'Pautado'],
  ['grid', 'Quadriculado'],
  ['dots', 'Pontilhado'],
  ['staff', 'Pauta musical'],
  ['blank', 'Liso'],
];

/** Desenha o fundo da folha. w,h em pixels. */
export function drawPattern(x, w, hh, pattern) {
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, hh);
  const u = w / 1000;
  if (pattern === 'lined') {
    const gap = 32 * u;
    x.strokeStyle = '#c9d6ea';
    x.lineWidth = Math.max(1, 1.2 * u);
    for (let y = 110 * u; y < hh - 30 * u; y += gap) {
      x.beginPath();
      x.moveTo(0, y);
      x.lineTo(w, y);
      x.stroke();
    }
    x.strokeStyle = '#f2a8a8';
    x.lineWidth = Math.max(1, 1.6 * u);
    x.beginPath();
    x.moveTo(90 * u, 0);
    x.lineTo(90 * u, hh);
    x.stroke();
  } else if (pattern === 'grid') {
    const gap = 25 * u;
    x.strokeStyle = '#dfe6f1';
    x.lineWidth = Math.max(1, 1 * u);
    for (let y = gap; y < hh; y += gap) {
      x.beginPath();
      x.moveTo(0, y);
      x.lineTo(w, y);
      x.stroke();
    }
    for (let xx = gap; xx < w; xx += gap) {
      x.beginPath();
      x.moveTo(xx, 0);
      x.lineTo(xx, hh);
      x.stroke();
    }
  } else if (pattern === 'dots') {
    const gap = 25 * u;
    x.fillStyle = '#b9c3d3';
    for (let y = gap; y < hh; y += gap) for (let xx = gap; xx < w; xx += gap) {
      x.beginPath();
      x.arc(xx, y, Math.max(0.8, 1.5 * u), 0, Math.PI * 2);
      x.fill();
    }
  } else if (pattern === 'staff') {
    const line = 11 * u;
    const block = 4 * line + 70 * u;
    x.strokeStyle = '#9aa3b2';
    x.lineWidth = Math.max(1, 1.1 * u);
    for (let top = 90 * u; top + 4 * line < hh - 40 * u; top += block) {
      for (let i = 0; i < 5; i++) {
        const y = top + i * line;
        x.beginPath();
        x.moveTo(60 * u, y);
        x.lineTo(w - 60 * u, y);
        x.stroke();
      }
    }
  }
}

export default class NotebookViewer {
  annotatable = true;
  minZoom = 0.4;
  maxZoom = 4;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
    this.nb = ctx.state.notebook ||= { pages: 2, pattern: 'lined' };
  }

  async mount() {
    const { ctx } = this;
    this.wrap = h('<div class="nb-pages"></div>');
    this.addBtn = h(`<button class="nb-add">${icon('plus', 18)} Nova folha</button>`);
    this.addBtn.onclick = () => this.addPage();
    ctx.content.appendChild(this.wrap);
    ctx.content.appendChild(this.addBtn);
    this.renderPages();
    this.buildSlot();
    if (ctx.tools.tool === 'read') ctx.tools.set('pen');
  }

  /** Tamanho da folha em cm (com orientação). */
  get dims() {
    const z = SIZES.find((x) => x[0] === (this.nb.size || 'a4')) || SIZES[0];
    const [w, hh] = [z[2], z[3]];
    return this.nb.orient === 'landscape' ? { w: Math.max(w, hh), h: Math.min(w, hh) } : { w, h: hh };
  }

  get width() {
    return Math.min(900, this.ctx.stage.clientWidth - (innerWidth < 720 ? 16 : 64)) * this.zoom;
  }

  renderPages() {
    const { ann } = this.ctx;
    [...ann.layers.keys()].forEach((k) => ann.detach(k));
    this.wrap.innerHTML = '';
    this.hosts = [];
    for (let i = 1; i <= this.nb.pages; i++) {
      const host = h(`<div class="page-host nb-page"><canvas class="nb-bg"></canvas><span class="page-num">${i}</span>${this.nb.pages > 1 ? `<button class="nb-del" data-i="${i}" title="Excluir folha" aria-label="Excluir folha ${i}">${icon('trash', 15)}</button>` : ''}</div>`);
      this.wrap.appendChild(host);
      this.hosts.push(host);
    }
    this.layout();
    this.hosts.forEach((host, i) => ann.attach(host, `n${i + 1}`));
    this.wrap.querySelectorAll('.nb-del').forEach((b) => (b.onclick = () => this.deletePage(+b.dataset.i)));
  }

  layout() {
    const W = Math.round(this.width);
    const H = Math.round((W * this.dims.h) / this.dims.w);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    for (const host of this.hosts) {
      host.style.width = `${W}px`;
      host.style.height = `${H}px`;
      const c = host.querySelector('.nb-bg');
      c.width = W * dpr;
      c.height = H * dpr;
      drawPattern(c.getContext('2d'), c.width, c.height, this.nb.pattern);
    }
  }

  setZoom(z) {
    this.zoom = z;
    this.ctx.state.zoom = z;
    this.ctx.saveState();
    this.layout();
  }
  onResize() {
    this.layout();
  }

  addPage() {
    this.nb.pages++;
    this.ctx.saveState();
    this.renderPages();
    this.hosts[this.hosts.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async deletePage(i) {
    if (!(await confirmDialog('Excluir folha?', `<p>A folha ${i} e o que estiver escrito nela serão apagados.</p>`, 'Excluir', true))) return;
    const pages = this.ctx.ann.pages;
    for (let k = i; k < this.nb.pages; k++) {
      if (pages[`n${k + 1}`]) pages[`n${k}`] = pages[`n${k + 1}`];
      else delete pages[`n${k}`];
    }
    delete pages[`n${this.nb.pages}`];
    this.nb.pages--;
    this.ctx.history.undoStack = [];
    this.ctx.history.redoStack = [];
    this.ctx.history.emit();
    this.ctx.saveState();
    this.renderPages();
  }

  buildSlot() {
    const btn = h(`<button class="btn btn-soft btn-sm" title="Folha: tipo, tamanho e orientação">${icon('file-text', 17)}<span class="hide-sm">Folha</span></button>`);
    btn.onclick = () => this.sheetPop(btn);
    this.ctx.slot.appendChild(btn);
  }

  sheetPop(btn) {
    const panel = h(`
      <div class="tool-panel margin-panel">
        <div class="tp-title">${icon('file-text', 16)} Folha do caderno</div>
        <div class="tp-label">Tipo</div>
        <div class="paper-sizes" data-g="pattern">${PATTERNS.map(([v, l]) => `<button data-v="${v}"><b>${l}</b></button>`).join('')}</div>
        <div class="tp-label">Tamanho</div>
        <div class="paper-sizes" data-g="size">${SIZES.map(([v, l, w, hh]) => `<button data-v="${v}"><i style="aspect-ratio:${w}/${hh}"></i><b>${l}</b></button>`).join('')}</div>
        <div class="tp-label">Orientação</div>
        <div class="seg" data-g="orient"><button data-v="portrait">Retrato</button><button data-v="landscape">Paisagem</button></div>
      </div>`);
    popover(btn, panel, { align: 'end' });
    const cur = () => ({ pattern: this.nb.pattern, size: this.nb.size || 'a4', orient: this.nb.orient || 'portrait' });
    const sync = () => {
      const c = cur();
      panel.querySelectorAll('[data-g]').forEach((g) => g.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x.dataset.v === c[g.dataset.g])));
    };
    sync();
    panel.addEventListener('click', (e) => {
      const x = e.target.closest('[data-v]');
      if (!x) return;
      this.nb[x.closest('[data-g]').dataset.g] = x.dataset.v;
      this.ctx.saveState();
      this.layout();
      sync();
    });
  }

  exports() {
    const name = baseName(this.ctx.rec.name);
    return [
      {
        label: 'PDF do caderno',
        icon: 'file-down',
        hint: '.pdf',
        run: async () => {
          const PT = 28.3465; // pontos por cm
          const pages = Array.from({ length: this.nb.pages }, (_, i) => ({
            width: this.dims.w * PT,
            height: this.dims.h * PT,
            draw: (x, pw, ph) => {
              drawPattern(x, pw, ph, this.nb.pattern);
              compositeAnnotations(x, this.ctx.ann.pages[`n${i + 1}`], pw, ph);
            },
          }));
          download(await pagesToPdf(pages, 2.5), `${name}.pdf`);
        },
      },
    ];
  }

  destroy() {}
}
