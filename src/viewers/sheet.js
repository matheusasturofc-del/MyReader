// Planilhas (XLSX, XLS, ODS, CSV, TSV) com SheetJS: abas, edição de células,
// marca-texto em células e exportação para Excel/CSV.
import * as XLSX from 'xlsx';
import { h, esc, download, baseName, ext } from '../util.js';
import { icon } from '../icons.js';
import { PALETTES } from '../annotations.js';

const MAX_ROWS = 3000;
const MAX_COLS = 120;

export default class SheetViewer {
  annotatable = false;
  minZoom = 0.4;
  maxZoom = 3;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
    ctx.state.cellColors ||= {};
  }

  async mount() {
    const { ctx } = this;
    if (ctx.state.sheets) {
      this.wb = XLSX.utils.book_new();
      for (const name of ctx.state.sheets.names) XLSX.utils.book_append_sheet(this.wb, XLSX.utils.aoa_to_sheet(ctx.state.sheets.data[name] || [[]]), name);
    } else {
      const e = ext(ctx.rec.name);
      if (e === 'csv' || e === 'tsv') this.wb = XLSX.read(await ctx.blob.text(), { type: 'string', raw: false, FS: e === 'tsv' ? '\t' : undefined });
      else this.wb = XLSX.read(await ctx.blob.arrayBuffer(), { type: 'array', cellDates: true });
    }
    this.el = h(`
      <div class="sheet-wrap">
        <div class="sheet-scroll"><table class="sheet"></table></div>
        <div class="sheet-tabs"></div>
      </div>`);
    ctx.content.classList.add('fill-content');
    ctx.content.appendChild(this.el);
    this.table = this.el.querySelector('table');
    this.active = ctx.state.activeSheet && this.wb.SheetNames.includes(ctx.state.activeSheet) ? ctx.state.activeSheet : this.wb.SheetNames[0];
    this.buildTabs();
    this.buildBar();
    this.renderSheet();
    this.applyZoom();
  }

  buildTabs() {
    const tabs = this.el.querySelector('.sheet-tabs');
    tabs.innerHTML = this.wb.SheetNames.map((n) => `<button class="sheet-tab ${n === this.active ? 'on' : ''}" data-n="${esc(n)}">${esc(n)}</button>`).join('');
    tabs.onclick = (e) => {
      const b = e.target.closest('.sheet-tab');
      if (!b) return;
      this.active = b.dataset.n;
      this.ctx.state.activeSheet = this.active;
      this.ctx.saveState();
      this.buildTabs();
      this.renderSheet();
    };
  }

  buildBar() {
    const bar = h(`
      <div class="fmtbar sheet-bar">
        <span class="cell-ref">A1</span>
        <input class="cell-input" aria-label="Conteúdo da célula" placeholder="Selecione uma célula">
        <span class="fmt-sep"></span>
        <span class="bar-label">${icon('highlighter', 16)}</span>
        ${[...PALETTES.highlighter, 'transparent'].map((c) => `<button class="swatch sm ${c === 'transparent' ? 'none' : ''}" data-c="${c}" style="--c:${c}" title="${c === 'transparent' ? 'Sem cor' : 'Marcar célula'}"></button>`).join('')}
      </div>`);
    this.ctx.sub.appendChild(bar);
    this.bar = bar;
    this.refEl = bar.querySelector('.cell-ref');
    this.input = bar.querySelector('.cell-input');
    bar.addEventListener('pointerdown', (e) => e.target.closest('button') && e.preventDefault());
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (b) this.colorSelection(b.dataset.c);
    });
    this.input.addEventListener('input', () => {
      if (!this.sel) return;
      const td = this.cellEl(this.sel.r1, this.sel.c1);
      if (td) td.textContent = this.input.value;
    });
    this.input.addEventListener('change', () => this.sel && this.commitCell(this.sel.r1, this.sel.c1, this.input.value));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.input.blur();
        this.select(this.sel.r1 + 1, this.sel.c1);
      }
    });
  }

  get ws() {
    return this.wb.Sheets[this.active];
  }

  renderSheet() {
    const ws = this.ws;
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 20, c: 8 } };
    const rows = Math.min(Math.max(range.e.r + 1, 30), MAX_ROWS);
    const cols = Math.min(Math.max(range.e.c + 1, 10), MAX_COLS);
    this.dims = { rows, cols };
    const colors = this.ctx.state.cellColors[this.active] || {};
    const merges = ws['!merges'] || [];
    const hidden = new Set();
    const spans = {};
    for (const m of merges) {
      spans[`${m.s.r},${m.s.c}`] = { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 };
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) hidden.add(`${r},${c}`);
    }
    let html = '<thead><tr><th class="corner"></th>';
    for (let c = 0; c < cols; c++) html += `<th>${XLSX.utils.encode_col(c)}</th>`;
    html += '</tr></thead><tbody>';
    for (let r = 0; r < rows; r++) {
      html += `<tr><th>${r + 1}</th>`;
      for (let c = 0; c < cols; c++) {
        if (hidden.has(`${r},${c}`)) continue;
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        const v = cell ? (cell.w ?? (cell.v instanceof Date ? cell.v.toLocaleDateString('pt-BR') : cell.v ?? '')) : '';
        const sp = spans[`${r},${c}`];
        const num = cell && cell.t === 'n';
        html += `<td data-r="${r}" data-c="${c}"${sp ? ` rowspan="${sp.rs}" colspan="${sp.cs}"` : ''} class="${num ? 'num' : ''}"${colors[addr] ? ` style="background:${colors[addr]}"` : ''}>${esc(v)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    this.table.innerHTML = html;
    if (range.e.r + 1 > MAX_ROWS) this.ctx.toast(`Mostrando as primeiras ${MAX_ROWS} linhas.`);
    this.bindTable();
    this.select(0, 0);
  }

  cellEl(r, c) {
    return this.table.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  }

  bindTable() {
    let dragging = false;
    this.table.onpointerdown = (e) => {
      const td = e.target.closest('td');
      if (!td || td.isContentEditable) return;
      dragging = true;
      this.select(+td.dataset.r, +td.dataset.c, e.shiftKey);
    };
    this.table.onpointerover = (e) => {
      if (!dragging) return;
      const td = e.target.closest('td');
      if (td) this.extend(+td.dataset.r, +td.dataset.c);
    };
    window.addEventListener('pointerup', (this.onUp = () => (dragging = false)));
    this.table.ondblclick = (e) => {
      const td = e.target.closest('td');
      if (td) this.edit(td);
    };
    this.table.onkeydown = (e) => this.onCellKey(e);
  }

  select(r, c, extend = false) {
    if (extend && this.sel) return this.extend(r, c);
    r = Math.max(0, Math.min(this.dims.rows - 1, r));
    c = Math.max(0, Math.min(this.dims.cols - 1, c));
    this.sel = { r0: r, c0: c, r1: r, c1: c };
    this.paintSel();
    const td = this.cellEl(r, c);
    td?.setAttribute('tabindex', '0');
    td?.focus({ preventScroll: false });
    const addr = XLSX.utils.encode_cell({ r, c });
    this.refEl.textContent = addr;
    const cell = this.ws[addr];
    this.input.value = cell ? (cell.f ? `=${cell.f}` : (cell.w ?? cell.v ?? '')) : '';
  }

  extend(r, c) {
    this.sel.r1 = r;
    this.sel.c1 = c;
    this.paintSel();
    const a = XLSX.utils.encode_cell({ r: this.sel.r0, c: this.sel.c0 });
    const b = XLSX.utils.encode_cell({ r, c });
    this.refEl.textContent = a === b ? a : `${a}:${b}`;
  }

  paintSel() {
    this.table.querySelectorAll('.sel, .sel-anchor').forEach((t) => t.classList.remove('sel', 'sel-anchor'));
    const { r0, c0, r1, c1 } = this.sel;
    for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) this.cellEl(r, c)?.classList.add('sel');
    this.cellEl(r0, c0)?.classList.add('sel-anchor');
  }

  edit(td) {
    td.contentEditable = 'true';
    td.focus();
    const range = document.createRange();
    range.selectNodeContents(td);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const done = () => {
      td.contentEditable = 'false';
      td.removeEventListener('blur', done);
      this.commitCell(+td.dataset.r, +td.dataset.c, td.textContent);
    };
    td.addEventListener('blur', done);
  }

  onCellKey(e) {
    const td = e.target.closest('td');
    if (!td || !this.sel) return;
    const r = +td.dataset.r,
      c = +td.dataset.c;
    if (td.isContentEditable) {
      if (e.key === 'Enter') {
        e.preventDefault();
        td.blur();
        this.select(r + 1, c);
      }
      if (e.key === 'Escape') td.blur();
      return;
    }
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      if (e.shiftKey && e.key.startsWith('Arrow')) this.extend(this.sel.r1 + dr, this.sel.c1 + dc);
      else this.select(r + dr, c + dc);
    } else if (e.key === 'F2') this.edit(td);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      td.textContent = '';
      this.commitCell(r, c, '');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      td.textContent = '';
      this.edit(td);
    }
  }

  commitCell(r, c, raw) {
    const addr = XLSX.utils.encode_cell({ r, c });
    const v = String(raw).trim();
    const old = this.ws[addr];
    const oldVal = old ? String(old.w ?? old.v ?? '') : '';
    if (v === oldVal) return;
    if (v === '') delete this.ws[addr];
    else {
      const n = Number(v.replace(/\./g, '').replace(',', '.'));
      const isNum = /^-?[\d.]+(,\d+)?$|^-?\d+(\.\d+)?$/.test(v) && !Number.isNaN(n);
      const num = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : n;
      this.ws[addr] = isNum ? { t: 'n', v: num, w: v } : { t: 's', v, w: v };
    }
    const range = this.ws['!ref'] ? XLSX.utils.decode_range(this.ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    range.e.r = Math.max(range.e.r, r);
    range.e.c = Math.max(range.e.c, c);
    this.ws['!ref'] = XLSX.utils.encode_range(range);
    const td = this.cellEl(r, c);
    if (td) td.classList.toggle('num', this.ws[addr]?.t === 'n');
    this.persist();
  }

  persist() {
    const data = {};
    for (const n of this.wb.SheetNames) data[n] = XLSX.utils.sheet_to_json(this.wb.Sheets[n], { header: 1, raw: true, defval: null });
    this.ctx.state.sheets = { names: this.wb.SheetNames, data };
    this.ctx.saveState();
  }

  colorSelection(color) {
    if (!this.sel) return;
    const map = (this.ctx.state.cellColors[this.active] ||= {});
    const { r0, c0, r1, c1 } = this.sel;
    for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (color === 'transparent') delete map[addr];
        else map[addr] = color;
        const td = this.cellEl(r, c);
        if (td) td.style.background = color === 'transparent' ? '' : color;
      }
    this.ctx.saveState();
  }

  applyZoom() {
    this.table.style.zoom = this.zoom;
  }
  setZoom(z) {
    this.zoom = z;
    this.ctx.state.zoom = z;
    this.ctx.saveState();
    this.applyZoom();
  }

  exports() {
    const name = baseName(this.ctx.rec.name);
    return [
      { label: 'Planilha Excel', icon: 'sheet', hint: '.xlsx', run: () => XLSX.writeFile(this.wb, `${name}.xlsx`) },
      {
        label: `Aba "${this.active}" em CSV`,
        icon: 'file-text',
        hint: '.csv',
        run: () => download(new Blob(['﻿' + XLSX.utils.sheet_to_csv(this.ws)], { type: 'text/csv;charset=utf-8' }), `${name} - ${this.active}.csv`),
      },
      { label: 'OpenDocument', icon: 'sheet', hint: '.ods', run: () => XLSX.writeFile(this.wb, `${name}.ods`, { bookType: 'ods' }) },
      ...(this.ctx.blob ? ['-', { label: 'Arquivo original', icon: 'download', run: () => download(this.ctx.blob, this.ctx.rec.name) }] : []),
    ];
  }

  destroy() {
    window.removeEventListener('pointerup', this.onUp);
  }
}
