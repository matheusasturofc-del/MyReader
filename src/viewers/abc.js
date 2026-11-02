// Partituras em notação ABC (abcjs): editor de código ao vivo, reprodução com
// instrumentos reais, transposição, exportação para MIDI/PDF e anotações à mão.
import abcjs from 'abcjs';
import 'abcjs/abcjs-audio.css';
import { h, download, baseName, debounce, loadImage } from '../util.js';
import { icon } from '../icons.js';
import { pagesToPdf, compositeAnnotations } from '../export/pdf-export.js';
import { toast } from '../ui.js';

export default class AbcViewer {
  annotatable = true;
  minZoom = 0.5;
  maxZoom = 3;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
    this.transpose = ctx.state.transpose || 0;
  }

  async mount() {
    const { ctx } = this;
    this.text = ctx.state.text ?? (await ctx.blob.text());
    this.editorOpen = ctx.state.abcEditor ?? !!ctx.rec.created;

    this.wrap = h(`
      <div class="abc-wrap">
        <section class="abc-editor" ${this.editorOpen ? '' : 'hidden'}>
          <div class="abc-editor-head">${icon('code', 16)} Código ABC <a href="https://abcnotation.com/learn" target="_blank" rel="noopener">como escrever?</a></div>
          <textarea spellcheck="false" aria-label="Código da partitura em ABC"></textarea>
          <div class="abc-warn"></div>
        </section>
        <section class="abc-view">
          <div class="page-host abc-page"><div class="abc-paper"></div></div>
          <div class="abc-audio"></div>
        </section>
      </div>`);
    ctx.content.appendChild(this.wrap);
    this.ta = this.wrap.querySelector('textarea');
    this.ta.value = this.text;
    this.paper = this.wrap.querySelector('.abc-paper');
    this.host = this.wrap.querySelector('.abc-page');
    this.warn = this.wrap.querySelector('.abc-warn');
    this.applyZoom();
    this.renderScore();
    ctx.ann.attach(this.host, 'abc');

    const onEdit = debounce(() => {
      this.text = this.ta.value;
      ctx.state.text = this.text;
      ctx.saveState();
      this.renderScore();
    }, 350);
    this.ta.addEventListener('input', onEdit);
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });
    this.buildSlot();
  }

  renderScore() {
    const res = abcjs.renderAbc(this.paper, this.text, {
      responsive: 'resize',
      add_classes: true,
      visualTranspose: this.transpose,
      paddingtop: 10,
      paddingbottom: 20,
      paddingleft: 10,
      paddingright: 10,
      foregroundColor: '#1b1b1f',
      clickListener: () => {},
    });
    this.visual = res[0];
    const warnings = this.visual?.warnings || [];
    this.warn.innerHTML = warnings.length ? `${icon('info', 14)} ${warnings.slice(0, 3).join('<br>')}` : '';
    this.warn.hidden = !warnings.length;
    if (this.synth) this.loadSynth();
  }

  applyZoom() {
    this.host.style.width = `${Math.min(900, this.ctx.stage.clientWidth - (innerWidth < 720 ? 16 : 64)) * this.zoom}px`;
  }
  setZoom(z) {
    this.zoom = z;
    this.ctx.state.zoom = z;
    this.ctx.saveState();
    this.applyZoom();
  }
  onResize() {
    this.applyZoom();
  }

  buildSlot() {
    this.slotEl = h(`
      <div class="play-ctrl">
        <button class="btn btn-soft btn-sm" data-a="edit" title="Mostrar/ocultar código">${icon('code', 17)}<span class="hide-sm">Editar</span></button>
        <div class="transpose" title="Transpor">
          <button class="icon-btn sm" data-a="down" aria-label="Transpor meio tom abaixo">${icon('minus', 16)}</button>
          <span class="tval">${this.tLabel()}</span>
          <button class="icon-btn sm" data-a="up" aria-label="Transpor meio tom acima">${icon('plus', 16)}</button>
        </div>
        <button class="btn btn-soft btn-sm" data-a="audio">${icon('play', 17)}<span>Tocar</span></button>
      </div>`);
    this.ctx.slot.appendChild(this.slotEl);
    this.slotEl.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'edit') {
        const ed = this.wrap.querySelector('.abc-editor');
        ed.hidden = !ed.hidden;
        this.ctx.state.abcEditor = !ed.hidden;
        this.ctx.saveState();
        this.applyZoom();
      }
      if (a === 'up' || a === 'down') {
        this.transpose += a === 'up' ? 1 : -1;
        this.ctx.state.transpose = this.transpose;
        this.ctx.saveState();
        this.slotEl.querySelector('.tval').textContent = this.tLabel();
        this.renderScore();
      }
      if (a === 'audio') this.toggleAudio();
    });
  }

  tLabel() {
    return this.transpose === 0 ? 'Tom original' : `${this.transpose > 0 ? '+' : ''}${this.transpose} st`;
  }

  async toggleAudio() {
    const box = this.wrap.querySelector('.abc-audio');
    if (this.synth) {
      box.classList.toggle('show');
      return;
    }
    if (!abcjs.synth.supportsAudio()) return toast('Este navegador não suporta áudio.', { type: 'error' });
    box.classList.add('show');
    const highlight = {
      onEvent: (ev) => {
        this.paper.querySelectorAll('.abcjs-note-playing').forEach((e) => e.classList.remove('abcjs-note-playing'));
        (ev.elements || []).flat().forEach((e) => e.classList?.add('abcjs-note-playing'));
      },
      onFinished: () => this.paper.querySelectorAll('.abcjs-note-playing').forEach((e) => e.classList.remove('abcjs-note-playing')),
    };
    this.synth = new abcjs.synth.SynthController();
    this.synth.load(box, highlight, { displayLoop: true, displayRestart: true, displayPlay: true, displayProgress: true, displayWarp: true });
    await this.loadSynth();
    toast('Toque ▶ para ouvir (carrega o instrumento na primeira vez).');
  }

  async loadSynth() {
    try {
      await this.synth.setTune(this.visual, false, { midiTranspose: this.transpose, chordsOff: false });
    } catch (e) {
      console.warn(e);
    }
  }

  async pageImage() {
    const svg = this.paper.querySelector('svg');
    const clone = svg.cloneNode(true);
    const r = svg.getBoundingClientRect();
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', r.width);
    clone.setAttribute('height', r.height);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    const img = await loadImage(url);
    URL.revokeObjectURL(url);
    return img;
  }

  exports() {
    const name = baseName(this.ctx.rec.name);
    return [
      {
        label: 'PDF com anotações',
        icon: 'file-down',
        hint: '.pdf',
        run: async () => {
          const img = await this.pageImage();
          const hr = this.host.getBoundingClientRect();
          const pr = this.paper.getBoundingClientRect();
          const W = 595;
          const H = Math.max(842, (W * hr.height) / hr.width);
          download(
            await pagesToPdf(
              [
                {
                  width: W,
                  height: H,
                  draw: (x, pw, ph) => {
                    const k = pw / hr.width;
                    x.drawImage(img, (pr.left - hr.left) * k, (pr.top - hr.top) * k, pr.width * k, pr.height * k);
                    compositeAnnotations(x, this.ctx.ann.pages.abc, pw, hr.height * k);
                  },
                },
              ],
              3,
            ),
            `${name}.pdf`,
          );
        },
      },
      {
        label: 'MIDI (para tocar em outros apps)',
        icon: 'music',
        hint: '.mid',
        run: () => {
          const midi = abcjs.synth.getMidiFile(this.text, { midiOutputType: 'binary', midiTranspose: this.transpose });
          const data = Array.isArray(midi) ? midi[0] : midi;
          download(new Blob([data], { type: 'audio/midi' }), `${name}.mid`);
        },
      },
      { label: 'Código ABC', icon: 'code', hint: '.abc', run: () => download(new Blob([this.text], { type: 'text/vnd.abc' }), `${name}.abc`) },
    ];
  }

  destroy() {
    try {
      this.synth?.pause();
    } catch {}
  }
}
