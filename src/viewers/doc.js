// Editor de documentos: Word (.docx), Markdown, HTML e texto.
// Abre o conteúdo numa "folha" editável com barra de formatação, marca-texto de verdade
// (o destaque vira parte do texto) e exporta para .docx, PDF, HTML ou .txt.
import DOMPurify from 'dompurify';
import { h, esc, download, baseName, debounce } from '../util.js';
import { icon } from '../icons.js';
import { PALETTES } from '../annotations.js';
import { showSelectionMenu, hideSelectionMenu, toast, popover } from '../ui.js';

const SANITIZE = {
  ADD_ATTR: ['style', 'align', 'colspan', 'rowspan'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'],
  ALLOW_DATA_ATTR: false,
};

const clean = (html) => DOMPurify.sanitize(html, SANITIZE);

const CM = 37.8; // px por cm na tela (96 dpi)
// Tamanhos de folha (cm, retrato)
const PAPER_SIZES = [
  { id: 'a4', label: 'A4', w: 21, h: 29.7 },
  { id: 'letter', label: 'Carta', w: 21.59, h: 27.94 },
  { id: 'legal', label: 'Ofício', w: 21.59, h: 35.56 },
  { id: 'a5', label: 'A5', w: 14.8, h: 21 },
  { id: 'a3', label: 'A3', w: 29.7, h: 42 },
  { id: 'b5', label: 'B5', w: 17.6, h: 25 },
];

// Predefinições de margem (cm), como no Word — e a ABNT, usada em trabalhos no Brasil.
const DOC_MARGINS = [
  { label: 'Normal', hint: '2,5 cm em todos os lados', m: { t: 2.5, r: 2.5, b: 2.5, l: 2.5 } },
  { label: 'ABNT', hint: 'Sup./esq. 3 cm · inf./dir. 2 cm', m: { t: 3, r: 2, b: 2, l: 3 } },
  { label: 'Estreita', hint: '1,27 cm em todos os lados', m: { t: 1.27, r: 1.27, b: 1.27, l: 1.27 } },
  { label: 'Moderada', hint: 'Sup./inf. 2,54 · laterais 1,91', m: { t: 2.54, r: 1.91, b: 2.54, l: 1.91 } },
  { label: 'Larga', hint: 'Sup./inf. 2,54 · laterais 5,08', m: { t: 2.54, r: 5.08, b: 2.54, l: 5.08 } },
  { label: 'Sem margem', hint: '0,5 cm', m: { t: 0.5, r: 0.5, b: 0.5, l: 0.5 } },
];

const TEXT_COLORS = ['#1b1b1f', '#5c5f66', '#e03131', '#f08c00', '#2f9e44', '#1971c2', '#7048e8', '#c2255c'];

export default class DocViewer {
  annotatable = true;
  textHighlight = true;
  minZoom = 0.5;
  maxZoom = 3;

  constructor(ctx) {
    this.ctx = ctx;
    this.kind = ctx.rec.kind;
    this.zoom = ctx.state.zoom || 1;
    this.plain = this.kind === 'text';
  }

  async mount() {
    const { ctx } = this;
    let html = ctx.state.html;
    if (html == null) html = await this.convert();
    this.host = h(`<div class="page-host doc-host"><article class="paper ${this.plain ? 'paper-plain' : ''}" spellcheck="true"></article></div>`);
    this.paper = this.host.firstChild;
    if (this.plain) {
      this.paper.setAttribute('contenteditable', 'plaintext-only');
      if (this.paper.contentEditable !== 'plaintext-only') this.paper.contentEditable = 'true';
      this.paper.textContent = ctx.state.text ?? html;
    } else {
      this.paper.contentEditable = 'true';
      this.paper.innerHTML = clean(html);
    }
    ctx.content.classList.add('doc-content');
    ctx.content.appendChild(this.host);
    this.applyZoom();
    this.applySheet();
    this.ro = new ResizeObserver(() => this.updateBreaks());
    this.ro.observe(this.paper);
    ctx.ann.attach(this.host, 'doc');
    if (!this.plain) {
      // Marca-texto arrastando o dedo: vira destaque de verdade no texto (vai junto no .docx).
      ctx.ann.onTextHighlight = (layer, range, color) => {
        if (!this.paper.contains(range.commonAncestorContainer)) return false;
        this.markRange(range, color);
        return true;
      };
      ctx.ann.onEraseText = (layer, x, y) => this.unmarkAt(layer, x, y);
    }

    if (!this.plain) this.buildToolbar();
    this.bind();
    if (!ctx.rec.snippet) ctx.setSnippet(this.paper.innerText.trim().slice(0, 220));
  }

  async convert() {
    const { ctx } = this;
    const blob = ctx.blob;
    if (this.kind === 'docx') {
      const mammoth = (await import('mammoth/mammoth.browser.js')).default;
      const res = await mammoth.convertToHtml(
        { arrayBuffer: await blob.arrayBuffer() },
        {
          styleMap: ["p[style-name='Title'] => h1.doc-title:fresh", "p[style-name='Subtitle'] => h2.doc-subtitle:fresh", 'highlight => mark'],
          includeDefaultStyleMap: true,
        },
      );
      if (res.messages?.some((m) => m.type === 'error')) console.warn(res.messages);
      return res.value || '<p></p>';
    }
    const text = await blob.text();
    if (this.kind === 'markdown') {
      const { marked } = await import('marked');
      return marked.parse(text, { gfm: true, breaks: false });
    }
    if (this.kind === 'html') {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      return doc.body?.innerHTML || text;
    }
    return text;
  }

  bind() {
    const save = debounce(() => {
      if (this.plain) this.ctx.state.text = this.paper.textContent;
      else this.ctx.state.html = this.paper.innerHTML;
      this.ctx.saveState();
      this.refreshToolbar();
    }, 500);
    this.save = save;
    this.paper.addEventListener('input', () => {
      this.ctx.setStatus('Editando…');
      save();
    });
    this.paper.addEventListener('paste', (e) => {
      // cola HTML limpo
      const html = e.clipboardData?.getData('text/html');
      if (html && !this.plain) {
        e.preventDefault();
        document.execCommand('insertHTML', false, clean(html));
      }
    });
    this.onSel = () => this.refreshToolbar();
    document.addEventListener('selectionchange', this.onSel);
    this.onUp = () => setTimeout(() => this.handleSelection(), 10);
    this.paper.addEventListener('pointerup', this.onUp);
    this.paper.addEventListener('keyup', (e) => e.shiftKey && this.onUp());
    this.paper.addEventListener('pointerdown', () => hideSelectionMenu());
  }

  // ---------------------------------------------------------------- seleção / marca-texto
  handleSelection() {
    const sel = getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!this.paper.contains(range.commonAncestorContainer)) return;
    if (this.plain) return;
    const r = range.getBoundingClientRect();
    showSelectionMenu(r, {
      colors: PALETTES.highlighter.slice(0, 5),
      onHighlight: (c) => this.highlight(c),
      onCopy: () => document.execCommand('copy') && toast('Copiado'),
      extra: [
        { icon: 'bold', label: 'Negrito', run: () => this.exec('bold') },
        { icon: 'clear-format', label: 'Remover destaque', run: () => this.highlight('transparent') },
      ],
    });
  }

  /** Registra uma mudança no texto para o Desfazer/Refazer da barra de ferramentas. */
  recordEdit(before) {
    const after = this.paper.innerHTML;
    if (after === before) return;
    const set = (html) => {
      this.paper.innerHTML = html;
      this.save();
    };
    this.ctx.history.push({ undo: () => set(before), redo: () => set(after) });
    this.save();
  }

  markRange(range, color) {
    const before = this.paper.innerHTML;
    const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    for (let n = walker.currentNode.nodeType === 3 ? walker.currentNode : walker.nextNode(); n; n = walker.nextNode()) {
      if (!range.intersectsNode(n) || !n.textContent.trim()) continue;
      const s = n === range.startContainer ? range.startOffset : 0;
      const e = n === range.endContainer ? range.endOffset : n.length;
      if (e > s) parts.push([n, s, e]);
    }
    for (const [n, s, e] of parts) {
      let target = n;
      if (e < target.length) target.splitText(e);
      if (s > 0) target = target.splitText(s);
      const mark = document.createElement('mark');
      mark.style.backgroundColor = color;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }
    // junta marcas vizinhas da mesma cor
    this.paper.querySelectorAll('mark + mark').forEach((m) => {
      const prev = m.previousSibling;
      if (prev?.nodeName === 'MARK' && prev.style.backgroundColor === m.style.backgroundColor) {
        while (m.firstChild) prev.appendChild(m.firstChild);
        m.remove();
      }
    });
    this.paper.normalize();
    this.recordEdit(before);
  }

  unmarkAt(layer, x, y) {
    const live = layer.live;
    const prev = live.style.pointerEvents;
    live.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    live.style.pointerEvents = prev;
    if (!el || !this.paper.contains(el)) return;
    const m = el.closest('mark, [style*="background"]');
    if (!m || !this.paper.contains(m) || m === this.paper) return;
    const before = this.paper.innerHTML;
    if (m.nodeName === 'MARK' || (m.nodeName === 'SPAN' && m.style.length <= 1)) {
      m.replaceWith(...m.childNodes);
    } else m.style.backgroundColor = '';
    this.paper.normalize();
    this.recordEdit(before);
  }

  highlight(color) {
    if (this.plain) {
      toast('Arquivos de texto puro não guardam destaque. Use a caneta/marca-texto livre ou exporte como documento.');
      return;
    }
    this.paper.focus({ preventScroll: true });
    document.execCommand('styleWithCSS', false, true);
    if (!document.execCommand('hiliteColor', false, color)) document.execCommand('backColor', false, color);
    this.save();
  }

  exec(cmd, val = null) {
    this.paper.focus({ preventScroll: true });
    document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor');
    document.execCommand(cmd, false, val);
    this.save();
    this.refreshToolbar();
  }

  // ---------------------------------------------------------------- barra de formatação
  buildToolbar() {
    const b = (cmd, ic, label) => `<button class="fmt" data-cmd="${cmd}" title="${label}" aria-label="${label}">${icon(ic, 18)}</button>`;
    const bar = h(`
      <div class="fmtbar" role="toolbar" aria-label="Formatação">
        ${b('undo', 'undo', 'Desfazer')}${b('redo', 'redo', 'Refazer')}
        <span class="fmt-sep"></span>
        <select class="fmt-select" data-cmd="formatBlock" aria-label="Estilo do parágrafo">
          <option value="p">Texto normal</option>
          <option value="h1">Título 1</option>
          <option value="h2">Título 2</option>
          <option value="h3">Título 3</option>
          <option value="blockquote">Citação</option>
          <option value="pre">Código</option>
        </select>
        <select class="fmt-select sm" data-cmd="fontSize" aria-label="Tamanho da fonte">
          <option value="">Tam.</option>
          <option value="1">10</option><option value="2">13</option><option value="3">16</option>
          <option value="4">18</option><option value="5">24</option><option value="6">32</option><option value="7">48</option>
        </select>
        <span class="fmt-sep"></span>
        ${b('bold', 'bold', 'Negrito (Ctrl+B)')}${b('italic', 'italic', 'Itálico (Ctrl+I)')}${b('underline', 'underline', 'Sublinhado (Ctrl+U)')}${b('strikeThrough', 'strike', 'Tachado')}
        <button class="fmt fmt-color" data-pop="color" title="Cor do texto" aria-label="Cor do texto">${icon('baseline', 18)}<i style="background:#e03131"></i></button>
        <button class="fmt fmt-color" data-pop="hl" title="Marca-texto" aria-label="Marca-texto">${icon('highlighter', 18)}<i style="background:${this.ctx.tools.settings.highlighter.color}"></i></button>
        <span class="fmt-sep"></span>
        ${b('justifyLeft', 'align-left', 'Alinhar à esquerda')}${b('justifyCenter', 'align-center', 'Centralizar')}${b('justifyRight', 'align-right', 'Alinhar à direita')}${b('justifyFull', 'align-justify', 'Justificar')}
        <span class="fmt-sep"></span>
        ${b('insertUnorderedList', 'list', 'Lista')}${b('insertOrderedList', 'list-ordered', 'Lista numerada')}${b('outdent', 'outdent', 'Diminuir recuo')}${b('indent', 'indent', 'Aumentar recuo')}
        <span class="fmt-sep"></span>
        ${b('image', 'image-plus', 'Inserir imagem')}${b('removeFormat', 'clear-format', 'Limpar formatação')}
        <span class="fmt-sep"></span>
        <button class="fmt fmt-wide" data-pop="sheet" title="Folha: com/sem página, tamanho e orientação" aria-label="Folha">${icon('file-text', 18)}<span>Folha</span></button>
        <button class="fmt fmt-wide" data-pop="margins" title="Margens da folha" aria-label="Margens da folha">${icon('ruler', 18)}<span>Margens</span></button>
      </div>`);
    this.ctx.sub.appendChild(bar);
    this.bar = bar;
    this.lastColor = '#e03131';
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) e.preventDefault(); // mantém a seleção
    });
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const cmd = btn.dataset.cmd;
      if (btn.dataset.pop === 'margins') return this.marginPop(btn);
      if (btn.dataset.pop === 'sheet') return this.sheetPop(btn);
      if (btn.dataset.pop) return this.colorPop(btn, btn.dataset.pop);
      if (cmd === 'image') return this.insertImage();
      if (cmd === 'removeFormat') {
        this.exec('removeFormat');
        this.exec('hiliteColor', 'transparent');
        return;
      }
      if (cmd) this.exec(cmd);
    });
    bar.querySelectorAll('select').forEach((s) =>
      s.addEventListener('change', () => {
        const cmd = s.dataset.cmd;
        if (cmd === 'formatBlock') this.exec('formatBlock', `<${s.value}>`);
        else if (s.value) this.exec(cmd, s.value);
        if (cmd === 'fontSize') s.value = '';
      }),
    );
  }

  colorPop(btn, which) {
    const colors = which === 'hl' ? [...PALETTES.highlighter, 'transparent'] : TEXT_COLORS;
    const panel = h(`<div class="tool-panel"><div class="swatches">${colors
      .map((c) => `<button class="swatch ${c === 'transparent' ? 'none' : ''}" data-c="${c}" style="--c:${c}" title="${c === 'transparent' ? 'Sem destaque' : c}"></button>`)
      .join('')}<label class="swatch custom"><input type="color" value="#ffe14d"></label></div></div>`);
    const pop = popover(btn, panel);
    panel.addEventListener('pointerdown', (e) => e.target.closest('button') && e.preventDefault());
    const pick = (c) => {
      if (which === 'hl') {
        this.highlight(c);
        if (c !== 'transparent') this.ctx.tools.update('highlighter', { color: c });
      } else this.exec('foreColor', c);
      btn.querySelector('i').style.background = c;
      pop.close();
    };
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (b) pick(b.dataset.c);
    });
    panel.querySelector('input').addEventListener('change', (e) => pick(e.target.value));
  }

  refreshToolbar() {
    if (!this.bar) return;
    const sel = getSelection();
    if (!sel?.rangeCount || !this.paper.contains(sel.anchorNode)) return;
    for (const btn of this.bar.querySelectorAll('[data-cmd]')) {
      const cmd = btn.dataset.cmd;
      if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyFull'].includes(cmd)) {
        try {
          btn.classList.toggle('on', document.queryCommandState(cmd));
        } catch {}
      }
    }
    try {
      const block = String(document.queryCommandValue('formatBlock') || 'p').toLowerCase().replace(/[<>]/g, '');
      const s = this.bar.querySelector('[data-cmd="formatBlock"]');
      s.value = ['h1', 'h2', 'h3', 'blockquote', 'pre'].includes(block) ? block : 'p';
    } catch {}
  }

  insertImage() {
    const sel = getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        this.paper.focus();
        if (range) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand('insertHTML', false, `<img src="${r.result}" alt="" style="max-width:100%">`);
        this.save();
      };
      r.readAsDataURL(f);
    };
    inp.click();
  }

  setReadingMode(on) {
    if (on) this.paper.contentEditable = 'false';
    else if (this.plain) {
      this.paper.setAttribute('contenteditable', 'plaintext-only');
      if (this.paper.contentEditable !== 'plaintext-only') this.paper.contentEditable = 'true';
    } else this.paper.contentEditable = 'true';
  }

  // ---------------------------------------------------------------- zoom
  // ---------------------------------------------------------------- margens da folha (cm)
  get margins() {
    return this.ctx.state.docMargin || null;
  }
  applyMargins() {
    const m = this.margins;
    if (!m) {
      this.paper.style.padding = '';
      return;
    }
    // em % da largura da folha (A4 = 21 cm), assim fica proporcional no celular também
    const pct = (cm) => `${((cm / this.dims.w) * 100).toFixed(2)}%`;
    this.paper.style.padding = `${pct(m.t)} ${pct(m.r)} ${pct(m.b)} ${pct(m.l)}`;
  }
  marginPop(btn) {
    const cur = this.margins || DOC_MARGINS[0].m;
    const same = (a, b) => ['t', 'r', 'b', 'l'].every((k) => Math.abs(a[k] - b[k]) < 0.01);
    const panel = h(`
      <div class="tool-panel margin-panel">
        <div class="tp-title">${icon('ruler', 16)} Margens da folha</div>
        <div class="doc-margins">
          ${DOC_MARGINS.map(
            (p, i) => `<button data-i="${i}" class="${same(cur, p.m) ? 'on' : ''}"><b>${p.label}</b><small>${p.hint}</small></button>`,
          ).join('')}
        </div>
        <div class="tp-label">Personalizada (cm)</div>
        <div class="margin-inputs">
          ${[
            ['t', 'Superior'],
            ['b', 'Inferior'],
            ['l', 'Esquerda'],
            ['r', 'Direita'],
          ]
            .map(([k, l]) => `<label><span>${l}</span><input type="number" min="0" max="8" step="0.1" data-k="${k}" value="${cur[k]}"></label>`)
            .join('')}
        </div>
      </div>`);
    popover(btn, panel, { align: 'end' });
    const set = (m) => {
      this.ctx.state.docMargin = m;
      this.ctx.saveState();
      this.applyMargins();
      panel.querySelectorAll('[data-k]').forEach((inp) => (inp.value = m[inp.dataset.k]));
      panel.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('on', same(m, DOC_MARGINS[+b.dataset.i].m)));
    };
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) set({ ...DOC_MARGINS[+b.dataset.i].m });
    });
    panel.addEventListener('input', (e) => {
      const inp = e.target.closest('[data-k]');
      if (!inp) return;
      const v = Math.max(0, Math.min(8, parseFloat(String(inp.value).replace(',', '.')) || 0));
      set({ ...(this.margins || cur), [inp.dataset.k]: v });
    });
  }

  // ---------------------------------------------------------------- folha: com/sem página, tamanho
  get sheet() {
    return { mode: 'page', size: 'a4', orient: 'portrait', ...(this.ctx.state.docSheet || {}) };
  }
  /** Tamanho da folha em cm, já considerando a orientação. */
  get dims() {
    const sz = PAPER_SIZES.find((p) => p.id === this.sheet.size) || PAPER_SIZES[0];
    return this.sheet.orient === 'landscape' ? { w: sz.h, h: sz.w } : { w: sz.w, h: sz.h };
  }
  applySheet() {
    const paged = this.sheet.mode === 'page';
    const gutter = innerWidth < 720 ? 16 : 64;
    this.host.classList.toggle('paged', paged);
    this.host.classList.toggle('flow', !paged);
    this.host.style.width = paged ? `min(${Math.round(this.dims.w * CM)}px, calc(100vw - ${gutter}px))` : `min(980px, calc(100vw - ${gutter}px))`;
    this.applyMargins();
    this.updateBreaks();
  }
  /** Mostra onde cada página termina (a paginação exata acontece no Word/PDF exportado). */
  updateBreaks() {
    if (!this.paper) return;
    this.host.querySelectorAll('.page-break').forEach((b) => b.remove());
    if (this.sheet.mode !== 'page') {
      this.paper.style.minHeight = '';
      return;
    }
    const ratio = this.dims.h / this.dims.w;
    const cssPage = this.paper.offsetWidth * ratio; // altura de 1 página (px, sem zoom)
    if (!cssPage) return;
    this.paper.style.minHeight = '';
    const content = this.paper.offsetHeight;
    const pages = Math.max(1, Math.ceil(content / cssPage - 0.01));
    this.paper.style.minHeight = `${pages * cssPage}px`;
    const shown = this.paper.getBoundingClientRect().width * ratio; // com zoom
    for (let i = 1; i < pages; i++) {
      const b = document.createElement('div');
      b.className = 'page-break';
      b.style.top = `${this.paper.offsetTop + i * shown}px`;
      b.innerHTML = `<span>Página ${i + 1}</span>`;
      this.host.appendChild(b);
    }
    this.host.dataset.pages = pages;
  }
  sheetPop(btn) {
    const panel = h(`
      <div class="tool-panel margin-panel">
        <div class="tp-title">${icon('file-text', 16)} Folha</div>
        <div class="seg" data-g="mode">
          <button data-v="page">${icon('file-text', 15)} Com página</button>
          <button data-v="flow">${icon('align-left', 15)} Sem página</button>
        </div>
        <p class="tp-hint" data-hint></p>
        <div class="tp-label">Tamanho da folha</div>
        <div class="paper-sizes" data-g="size">
          ${PAPER_SIZES.map((p) => `<button data-v="${p.id}"><i style="aspect-ratio:${p.w}/${p.h}"></i><b>${p.label}</b><small>${String(p.w).replace('.', ',')} × ${String(p.h).replace('.', ',')} cm</small></button>`).join('')}
        </div>
        <div class="tp-label">Orientação</div>
        <div class="seg" data-g="orient">
          <button data-v="portrait">Retrato</button>
          <button data-v="landscape">Paisagem</button>
        </div>
      </div>`);
    popover(btn, panel, { align: 'end' });
    const sync = () => {
      const sh = this.sheet;
      panel.querySelectorAll('[data-g]').forEach((g) => g.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === sh[g.dataset.g])));
      panel.querySelector('[data-hint]').textContent =
        sh.mode === 'page'
          ? 'Mostra as folhas e onde cada página termina. Ao salvar em .docx/PDF, sai com esse tamanho de folha.'
          : 'Texto corrido, sem folhas — ótimo para ler e escrever no celular. O tamanho da folha vale ao salvar em .docx/PDF.';
    };
    sync();
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      const g = b.closest('[data-g]').dataset.g;
      this.ctx.state.docSheet = { ...this.sheet, [g]: b.dataset.v };
      if (g !== 'mode') this.ctx.state.docSheet.mode = 'page';
      this.ctx.saveState();
      this.applySheet();
      sync();
    });
  }

  applyZoom() {
    this.paper.style.zoom = this.zoom;
    this.updateBreaks?.();
  }
  setZoom(z) {
    this.zoom = z;
    this.applyZoom();
    this.ctx.state.zoom = z;
    this.ctx.saveState();
  }

  // ---------------------------------------------------------------- exportação
  exports() {
    const name = baseName(this.ctx.rec.name);
    const items = [];
    if (!this.plain) {
      items.push({
        label: 'Documento Word',
        icon: 'file-type',
        hint: '.docx',
        run: async () => {
          const { htmlToDocx } = await import('../export/docx-export.js');
          download(await htmlToDocx(this.paper, { title: name, margins: this.margins, page: { ...this.dims, orient: this.sheet.orient } }), `${name}.docx`);
        },
      });
    }
    if (!window.Capacitor?.isNativePlatform?.()) items.push({ label: 'PDF / Imprimir', icon: 'printer', hint: 'PDF', run: () => this.print() });
    if (!this.plain) {
      items.push({
        label: 'Página da web',
        icon: 'code',
        hint: '.html',
        run: () => download(new Blob([this.standaloneHtml(name)], { type: 'text/html' }), `${name}.html`),
      });
    }
    items.push({
      label: 'Texto simples',
      icon: 'file-text',
      hint: '.txt',
      run: () => download(new Blob([this.paper.innerText], { type: 'text/plain;charset=utf-8' }), `${name}.txt`),
    });
    if (this.ctx.blob) items.push('-', { label: 'Arquivo original', icon: 'download', run: () => download(this.ctx.blob, this.ctx.rec.name) });
    return items;
  }

  standaloneHtml(title) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.65 Georgia,'Times New Roman',serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1b1b1f}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:16px;color:#555}</style></head><body>${this.paper.innerHTML}</body></html>`;
  }

  print() {
    const shapes = this.ctx.ann.pages.doc;
    if (shapes?.length) toast('Dica: os desenhos livres não entram na impressão — só o texto e os destaques.', { timeout: 4500 });
    document.body.classList.add('print-doc');
    const frame = document.createElement('iframe');
    frame.className = 'print-frame';
    document.body.appendChild(frame);
    const d = frame.contentDocument;
    d.open();
    d.write(this.standaloneHtml(baseName(this.ctx.rec.name)).replace('</style>', `@page{size:${this.dims.w}cm ${this.dims.h}cm;margin:${this.margins ? `${this.margins.t}cm ${this.margins.r}cm ${this.margins.b}cm ${this.margins.l}cm` : '2.5cm'}}body{margin:0;max-width:none}mark,[style*="background"]{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>`));
    d.close();
    setTimeout(() => {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => {
        frame.remove();
        document.body.classList.remove('print-doc');
      }, 1000);
    }, 300);
  }

  beforeClose() {
    this.save?.flush();
  }

  onResize() {
    this.applySheet();
  }

  destroy() {
    this.ro?.disconnect();
    document.removeEventListener('selectionchange', this.onSel);
    hideSelectionMenu();
  }
}
