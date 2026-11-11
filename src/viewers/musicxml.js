// Partituras MusicXML (.musicxml / .xml / .mxl) com OpenSheetMusicDisplay.
// Cada página da partitura recebe uma camada de anotações (dedilhado, respirações,
// marcações do professor...). Tem reprodução simples com cursor acompanhando as notas.
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { h, download, baseName, bufferToBinaryString, loadImage } from '../util.js';
import { icon } from '../icons.js';
import { pagesToPdf, compositeAnnotations } from '../export/pdf-export.js';
import { toast } from '../ui.js';

export default class MusicXmlViewer {
  annotatable = true;
  minZoom = 0.4;
  maxZoom = 3;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
    this.tempoFactor = 1;
  }

  async mount() {
    const { ctx } = this;
    const buf = await ctx.blob.arrayBuffer();
    const bytes = new Uint8Array(buf.slice(0, 4));
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const content = isZip ? bufferToBinaryString(buf) : new TextDecoder().decode(buf);

    this.wrap = h('<div class="score-wrap"><div class="score"></div></div>');
    this.el = this.wrap.firstChild;
    ctx.content.appendChild(this.wrap);
    this.applyWidth();

    this.osmd = new OpenSheetMusicDisplay(this.el, {
      autoResize: false,
      backend: 'svg',
      drawTitle: true,
      drawComposer: true,
      drawPartNames: true,
      pageFormat: 'A4_P',
      pageBackgroundColor: '#FFFFFF',
      followCursor: true,
      cursorsOptions: [{ type: 0, color: '#6d5dfc', alpha: 0.45, follow: true }],
    });
    await this.osmd.load(content);
    this.render();
    this.buildSlot();
  }

  applyWidth() {
    const avail = this.ctx.stage.clientWidth - (innerWidth < 720 ? 16 : 64);
    const m = this.ctx.ann.margin;
    this.el.style.width = `${(Math.min(avail, 900) * this.zoom) / (1 + (m.l + m.r) / 1000)}px`;
  }

  render() {
    this.applyWidth();
    this.osmd.zoom = this.zoom * Math.min(1, (this.ctx.stage.clientWidth - 16) / 900) * 1.0;
    this.osmd.render();
    this.attachLayers();
  }

  attachLayers() {
    const { ann } = this.ctx;
    [...ann.layers.keys()].forEach((k) => ann.detach(k));
    const svgs = [...this.el.querySelectorAll('svg')];
    const m = ann.margin;
    this.pageEls = svgs.map((svg, i) => {
      const host = svg.parentElement;
      host.classList.add('page-host', 'score-page');
      const k = (svg.width.baseVal.value || svg.clientWidth) / 1000;
      host.style.padding = `${m.t * k}px ${m.r * k}px ${m.b * k}px ${m.l * k}px`;
      ann.attach(host, `s${i + 1}`);
      return host;
    });
  }

  setMargin() {
    this.render();
  }

  setZoom(z) {
    this.zoom = z;
    this.ctx.state.zoom = z;
    this.ctx.saveState();
    clearTimeout(this.zt);
    this.applyWidth();
    return new Promise((res) => {
      this.zt = setTimeout(() => {
        this.render();
        res();
      }, 60);
    });
  }

  onResize() {
    this.render();
  }

  // ---------------------------------------------------------------- reprodução
  buildSlot() {
    this.slotEl = h(`
      <div class="play-ctrl">
        <button class="btn btn-soft btn-sm" data-a="play">${icon('play', 17)}<span>Tocar</span></button>
        <label class="tempo" title="Velocidade">${icon('rotate', 15)}<select aria-label="Velocidade">
          <option value="0.5">50%</option><option value="0.75">75%</option><option value="1" selected>100%</option><option value="1.25">125%</option><option value="1.5">150%</option>
        </select></label>
      </div>`);
    this.ctx.slot.appendChild(this.slotEl);
    this.slotEl.querySelector('[data-a="play"]').onclick = () => (this.playing ? this.stop() : this.play());
    this.slotEl.querySelector('select').onchange = (e) => (this.tempoFactor = +e.target.value);
  }

  collectEvents() {
    const c = this.osmd.cursor;
    c.reset();
    const steps = [];
    const it = c.Iterator;
    while (!it.EndReached) {
      const t = it.currentTimeStamp.RealValue;
      const notes = [];
      for (const ve of it.CurrentVoiceEntries || []) {
        for (const n of ve.Notes || []) {
          if (n.isRest?.() || !n.Pitch) continue;
          if (n.NoteTie && n.NoteTie.StartNote !== n) continue; // nota ligada: só a primeira soa
          const len = n.NoteTie ? n.NoteTie.Notes.reduce((a, x) => a + x.Length.RealValue, 0) : n.Length.RealValue;
          notes.push({ f: n.Pitch.Frequency, d: len });
        }
      }
      steps.push({ t, notes });
      c.next();
    }
    c.reset();
    return steps;
  }

  async play() {
    try {
      const steps = this.collectEvents();
      if (!steps.length) return toast('Nenhuma nota para tocar.');
      const bpm = this.osmd.Sheet?.DefaultStartTempoInBpm || this.osmd.Sheet?.userStartTempoInBPM || 100;
      const secPerWhole = (240 / bpm) / this.tempoFactor;
      const ac = (this.ac ||= new (window.AudioContext || window.webkitAudioContext)());
      await ac.resume();
      const master = ac.createGain();
      master.gain.value = 0.22;
      master.connect(ac.destination);
      this.master = master;
      const t0 = ac.currentTime + 0.15;
      for (const s of steps) {
        for (const n of s.notes) this.tone(ac, master, n.f, t0 + s.t * secPerWhole, Math.max(0.08, n.d * secPerWhole));
      }
      this.playing = true;
      this.setPlayBtn(true);
      const c = this.osmd.cursor;
      c.show();
      c.reset();
      let i = 0;
      const tick = () => {
        if (!this.playing) return;
        const now = ac.currentTime - t0;
        while (i < steps.length - 1 && steps[i + 1].t * secPerWhole <= now) {
          c.next();
          i++;
        }
        if (i >= steps.length - 1 && now > steps[steps.length - 1].t * secPerWhole + 1) return this.stop();
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    } catch (e) {
      console.error(e);
      toast('Não foi possível tocar esta partitura.', { type: 'error' });
    }
  }

  tone(ac, out, f, start, dur) {
    const o = ac.createOscillator();
    const o2 = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'triangle';
    o2.type = 'sine';
    o.frequency.value = f;
    o2.frequency.value = f * 2;
    const g2 = ac.createGain();
    g2.gain.value = 0.25;
    o.connect(g);
    o2.connect(g2).connect(g);
    g.connect(out);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.9, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.35, start + Math.min(0.25, dur * 0.6));
    g.gain.setValueAtTime(0.35, start + dur * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0008, start + dur + 0.12);
    o.start(start);
    o2.start(start);
    o.stop(start + dur + 0.15);
    o2.stop(start + dur + 0.15);
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.master) {
      try {
        this.master.gain.setTargetAtTime(0, this.ac.currentTime, 0.02);
        const m = this.master;
        setTimeout(() => m.disconnect(), 200);
      } catch {}
      this.master = null;
    }
    this.osmd.cursor?.hide();
    this.setPlayBtn(false);
  }

  setPlayBtn(on) {
    const b = this.slotEl?.querySelector('[data-a="play"]');
    if (b) b.innerHTML = `${icon(on ? 'pause' : 'play', 17)}<span>${on ? 'Parar' : 'Tocar'}</span>`;
  }

  // ---------------------------------------------------------------- exportação
  async pageImages() {
    const out = [];
    for (const [i, host] of this.pageEls.entries()) {
      const svg = host.querySelector('svg');
      const clone = svg.cloneNode(true);
      const w = svg.width.baseVal.value || svg.clientWidth;
      const hh = svg.height.baseVal.value || svg.clientHeight;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', w);
      clone.setAttribute('height', hh);
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
      const img = await loadImage(url);
      URL.revokeObjectURL(url);
      out.push({ img, w, h: hh, key: `s${i + 1}` });
    }
    return out;
  }

  exports() {
    const name = baseName(this.ctx.rec.name);
    return [
      {
        label: 'PDF com anotações',
        icon: 'file-down',
        hint: '.pdf',
        run: async () => {
          const imgs = await this.pageImages();
          const m = this.ctx.ann.margin;
          const fx = 1 + (m.l + m.r) / 1000;
          const pages = imgs.map(({ img, w, h: hh, key }) => ({
            width: 595,
            height: (595 * (hh + ((m.t + m.b) * w) / 1000)) / (w * fx),
            draw: (x, pw, ph) => {
              const u = pw / fx / 1000; // px por unidade
              x.drawImage(img, m.l * u, m.t * u, 1000 * u, (1000 * u * hh) / w);
              compositeAnnotations(x, this.ctx.ann.pages[key], pw, ph, m);
            },
          }));
          download(await pagesToPdf(pages, 3), `${name}.pdf`);
        },
      },
      { label: 'Arquivo MusicXML original', icon: 'download', run: () => download(this.ctx.blob, this.ctx.rec.name) },
    ];
  }

  destroy() {
    this.stop();
    this.ac?.close();
    clearTimeout(this.zt);
  }
}
