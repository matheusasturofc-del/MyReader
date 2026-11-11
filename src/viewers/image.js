// Imagens (PNG, JPG, WebP, GIF, SVG...) com anotações e exportação.
import { h, download, baseName, canvasToBlob, loadImage } from '../util.js';
import { compositeAnnotations, pagesToPdf } from '../export/pdf-export.js';
import { ensureImages } from '../annotations.js';

export default class ImageViewer {
  annotatable = true;
  minZoom = 0.2;
  maxZoom = 8;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
  }

  async mount() {
    const { ctx } = this;
    this.url = URL.createObjectURL(ctx.blob);
    this.img = await loadImage(this.url);
    this.host = h('<div class="page-host image-page"></div>');
    this.img.className = 'image-el';
    this.img.alt = ctx.rec.name;
    this.img.draggable = false;
    this.host.appendChild(this.img);
    ctx.content.classList.add('center-content');
    ctx.content.appendChild(this.host);
    this.layout();
    ctx.ann.attach(this.host, 'img');
    if (!ctx.rec.thumb) this.makeThumb();
  }

  get natural() {
    return { w: this.img.naturalWidth || 800, h: this.img.naturalHeight || 600 };
  }

  layout() {
    const st = this.ctx.stage;
    const availW = st.clientWidth - (innerWidth < 720 ? 16 : 64);
    const availH = st.clientHeight - 140;
    const { w, h: hh } = this.natural;
    // "100%" = cabe na tela (largura e altura), sem ampliar imagens pequenas demais.
    const m = this.ctx.ann.margin;
    const fx = 1 + (m.l + m.r) / 1000; // a margem também precisa caber
    const fit = Math.min(availW / (w * fx), Math.max(availH, 360) / hh, Math.max(1, 600 / w));
    const W = Math.round(w * fit * this.zoom);
    const H = Math.round((W * hh) / w);
    const k = W / 1000;
    this.host.style.width = `${Math.round(W + (m.l + m.r) * k)}px`;
    this.host.style.height = `${Math.round(H + (m.t + m.b) * k)}px`;
    Object.assign(this.img.style, { position: 'absolute', left: `${m.l * k}px`, top: `${m.t * k}px`, width: `${W}px`, height: `${H}px` });
    this.host.classList.toggle('has-margin', m.l + m.r + m.t + m.b > 0);
  }

  setMargin() {
    this.layout();
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

  makeThumb() {
    const { w, h: hh } = this.natural;
    const c = document.createElement('canvas');
    const k = Math.min(1, 360 / w);
    c.width = w * k;
    c.height = hh * k;
    c.getContext('2d').drawImage(this.img, 0, 0, c.width, c.height);
    try {
      this.ctx.setThumb(c.toDataURL('image/jpeg', 0.75));
    } catch {}
  }

  async composite(maxSide = 4000) {
    let { w, h: hh } = this.natural;
    const k = Math.min(1, maxSide / Math.max(w, hh));
    w = Math.round(w * k);
    hh = Math.round(hh * k);
    const m = this.ctx.ann.margin;
    const u = w / 1000;
    const c = document.createElement('canvas');
    c.width = Math.round(w + (m.l + m.r) * u);
    c.height = Math.round(hh + (m.t + m.b) * u);
    const x = c.getContext('2d');
    if (m.l + m.r + m.t + m.b > 0) {
      x.fillStyle = '#fff';
      x.fillRect(0, 0, c.width, c.height);
    }
    x.drawImage(this.img, m.l * u, m.t * u, w, hh);
    await ensureImages(this.ctx.ann.pages);
    compositeAnnotations(x, this.ctx.ann.pages.img, c.width, c.height, m);
    return c;
  }

  exports() {
    const name = baseName(this.ctx.rec.name);
    return [
      { label: 'Imagem com anotações', icon: 'image', hint: '.png', run: async () => download(await canvasToBlob(await this.composite()), `${name} (anotado).png`) },
      {
        label: 'PDF com anotações',
        icon: 'file-down',
        hint: '.pdf',
        run: async () => {
          const c = await this.composite(3000);
          const W = 595;
          download(await pagesToPdf([{ width: W, height: (W * c.height) / c.width, draw: (x, pw, ph) => x.drawImage(c, 0, 0, pw, ph) }], c.width / W), `${name}.pdf`);
        },
      },
      { label: 'Imagem original', icon: 'download', run: () => download(this.ctx.blob, this.ctx.rec.name) },
    ];
  }

  destroy() {
    URL.revokeObjectURL(this.url);
  }
}
