// Tela inicial: abrir/soltar arquivos, criar novos documentos e biblioteca de recentes.
import { db } from './db.js';
import { h, esc, uid, formatDate, formatSize, download, ext } from './util.js';
import { icon } from './icons.js';
import { KINDS, ACCEPT, detectKind, UNSUPPORTED } from './formats.js';
import { toast, menu, dialog, confirmDialog } from './ui.js';
import { go, toggleTheme, getTheme } from './nav.js';

const ABC_TEMPLATE = `X:1
T:Minha melodia
C:Seu nome
M:4/4
L:1/8
Q:1/4=100
K:C
"C"E2 G2 c2 G2 | "F"A2 c2 "G"B2 G2 | "Am"A2 E2 "F"F2 A2 | "G"G4 z4 |
"C"c2 B2 A2 G2 | "F"F2 A2 "G"G2 D2 | "C"E2 D2 C2 E2 | "G"D2 "C"C6 |]
`;

const DOC_TEMPLATE = `<h1>Documento sem título</h1><p>Comece a escrever aqui… Use a barra acima para <strong>negrito</strong>, <em>itálico</em>, listas e <mark style="background-color:#ffe14d">marca-texto</mark>.</p><p></p>`;

export async function importFiles(files) {
  const out = [];
  for (const file of files) {
    const kind = await detectKind(file);
    if (!kind) {
      toast(UNSUPPORTED[ext(file.name)] || `Formato não suportado: ${file.name}`, { type: 'error', timeout: 5000 });
      continue;
    }
    const now = Date.now();
    const rec = { id: uid(), name: file.name, kind, size: file.size, mime: file.type, createdAt: now, openedAt: now, thumb: null };
    await db.putBlob(rec.id, file);
    await db.putFile(rec);
    out.push(rec);
  }
  return out;
}

export async function createNew(kind) {
  const now = Date.now();
  const id = uid();
  const names = { docx: 'Documento sem título.docx', abc: 'Nova partitura.abc', notebook: 'Caderno.notebook' };
  const rec = { id, name: names[kind], kind, size: 0, createdAt: now, openedAt: now, thumb: null, created: true };
  const state = {};
  if (kind === 'docx') state.html = DOC_TEMPLATE;
  if (kind === 'abc') state.text = ABC_TEMPLATE;
  if (kind === 'notebook') state.notebook = { pages: 2, pattern: 'lined' };
  await db.putFile(rec);
  await db.putState(id, state);
  go(`/doc/${id}`);
}

function pickFiles(multiple = true) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = ACCEPT;
  inp.multiple = multiple;
  inp.onchange = async () => {
    const recs = await importFiles([...inp.files]);
    if (recs.length === 1) go(`/doc/${recs[0].id}`);
    else if (recs.length) {
      toast(`${recs.length} arquivos adicionados`);
      go('/');
    }
  };
  inp.click();
}

let filter = 'all';
let query = '';

export async function renderLibrary(app) {
  document.title = 'MyReader';
  app.innerHTML = '';
  const theme = getTheme();
  const root = h(`
    <div class="lib">
      <header class="lib-top">
        <div class="brand">
          <img src="./icon.svg" alt="" width="34" height="34">
          <span>My<b>Reader</b></span>
        </div>
        <div class="lib-search">
          ${icon('search', 18)}
          <input type="search" placeholder="Buscar na biblioteca" aria-label="Buscar na biblioteca" value="${esc(query)}">
        </div>
        <button class="icon-btn" data-act="theme" title="Alternar tema" aria-label="Alternar tema">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>
      </header>

      <section class="hero">
        <div class="hero-text">
          <span class="eyebrow">${icon('sparkles', 15)} Leitor universal</span>
          <h1>Leia, escreva e <span class="hl-word">destaque</span> tudo.</h1>
          <p>PDF, Word, PowerPoint, partituras, EPUB, planilhas, imagens e textos — com caneta, marca-texto, notas e edição. Tudo fica salvo no seu aparelho, até offline.</p>
          <div class="hero-actions">
            <button class="btn btn-primary btn-lg" data-act="open">${icon('folder', 19)} Abrir arquivo</button>
            <button class="btn btn-ghost btn-lg" data-act="new-doc">${icon('file-plus', 19)} Novo documento</button>
          </div>
        </div>
        <button class="dropzone" data-act="open" aria-label="Soltar ou escolher arquivos">
          <div class="dz-stack">
            <div class="dz-card c1"><span style="--k:${KINDS.pdf.color}">PDF</span></div>
            <div class="dz-card c2"><span style="--k:${KINDS.musicxml.color}">${icon('music', 22)}</span></div>
            <div class="dz-card c3"><span style="--k:${KINDS.docx.color}">DOCX</span></div>
          </div>
          <strong>Solte seus arquivos aqui</strong>
          <small>ou toque para escolher</small>
          <div class="formats">
            ${['PDF', 'DOCX', 'PPTX', 'MusicXML', 'MXL', 'ABC', 'EPUB', 'XLSX', 'CSV', 'MD', 'TXT', 'HTML', 'PNG', 'JPG', 'SVG'].map((f) => `<i>${f}</i>`).join('')}
          </div>
        </button>
      </section>

      <section class="create">
        <button class="create-card" data-act="new-doc" style="--k:${KINDS.docx.color}">
          <span class="cc-ic">${icon('file-plus', 22)}</span>
          <span><strong>Documento</strong><small>Escreva e formate, salve em .docx</small></span>
        </button>
        <button class="create-card" data-act="new-notebook" style="--k:${KINDS.notebook.color}">
          <span class="cc-ic">${icon('notebook', 22)}</span>
          <span><strong>Caderno</strong><small>Folhas pautadas para escrever à mão</small></span>
        </button>
        <button class="create-card" data-act="new-abc" style="--k:${KINDS.abc.color}">
          <span class="cc-ic">${icon('file-music', 22)}</span>
          <span><strong>Partitura</strong><small>Componha em ABC e ouça tocando</small></span>
        </button>
      </section>

      <section class="recent">
        <div class="section-head">
          <h2>Biblioteca</h2>
          <div class="chips" role="tablist"></div>
        </div>
        <div class="grid"></div>
      </section>
      <footer class="lib-foot">Seus arquivos nunca saem do aparelho · MyReader</footer>
    </div>`);
  app.appendChild(root);

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') pickFiles();
    if (act === 'theme') {
      toggleTheme();
      renderLibrary(app);
    }
    if (act === 'new-doc') createNew('docx');
    if (act === 'new-abc') createNew('abc');
    if (act === 'new-notebook') createNew('notebook');
  });

  const files = (await db.listFiles()).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  const grid = root.querySelector('.grid');
  const chips = root.querySelector('.chips');
  const search = root.querySelector('.lib-search input');

  const kindsPresent = [...new Set(files.map((f) => f.kind))];
  const chipKinds = ['all', ...kindsPresent];
  if (!chipKinds.includes(filter)) filter = 'all';
  const renderChips = () => {
    chips.innerHTML = chipKinds
      .map((k) => `<button class="chip ${k === filter ? 'on' : ''}" data-k="${k}">${k === 'all' ? 'Todos' : KINDS[k]?.label || k}</button>`)
      .join('');
  };
  chips.addEventListener('click', (e) => {
    const k = e.target.closest('.chip')?.dataset.k;
    if (!k) return;
    filter = k;
    renderChips();
    renderGrid();
  });
  search.addEventListener('input', () => {
    query = search.value;
    renderGrid();
  });

  function renderGrid() {
    const q = query.trim().toLowerCase();
    const list = files.filter((f) => (filter === 'all' || f.kind === filter) && (!q || f.name.toLowerCase().includes(q)));
    if (!files.length) {
      grid.innerHTML = `
        <div class="empty">
          <div class="empty-art">${icon('library', 34)}</div>
          <strong>Sua biblioteca está vazia</strong>
          <p>Abra um PDF, documento do Word, partitura ou qualquer arquivo para começar.</p>
        </div>`;
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<div class="empty small"><p>Nada encontrado.</p></div>`;
      return;
    }
    grid.innerHTML = '';
    for (const f of list) grid.appendChild(card(f));
  }

  function card(f) {
    const k = KINDS[f.kind] || KINDS.text;
    const el = h(`
      <article class="card" style="--k:${k.color}" tabindex="0" aria-label="Abrir ${esc(f.name)}">
        <div class="card-thumb">
          ${
            f.thumb
              ? `<img src="${f.thumb}" alt="" loading="lazy">`
              : f.snippet
                ? `<div class="card-snippet">${esc(f.snippet)}</div>`
                : `<div class="card-icon">${icon(k.icon, 34)}</div>`
          }
          <span class="badge">${esc(k.label)}</span>
        </div>
        <div class="card-info">
          <div class="card-name" title="${esc(f.name)}">${esc(f.name.replace(/\.notebook$/, ''))}</div>
          <div class="card-meta">${[formatDate(f.openedAt), formatSize(f.size)].filter(Boolean).join(' · ')}</div>
        </div>
        <button class="icon-btn card-more" aria-label="Opções">${icon('more', 18)}</button>
      </article>`);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.card-more')) return;
      go(`/doc/${f.id}`);
    });
    el.addEventListener('keydown', (e) => e.key === 'Enter' && go(`/doc/${f.id}`));
    el.querySelector('.card-more').addEventListener('click', (e) => {
      e.stopPropagation();
      menu(e.currentTarget, [
        { label: 'Abrir', icon: 'book', run: () => go(`/doc/${f.id}`) },
        {
          label: 'Renomear',
          icon: 'pencil',
          run: async () => {
            const name = await dialog({
              title: 'Renomear',
              input: { value: f.name },
              buttons: [
                { label: 'Cancelar', value: false },
                { label: 'Salvar', value: true, primary: true },
              ],
            });
            if (name && name.trim()) {
              await db.updateFile(f.id, { name: name.trim() });
              renderLibrary(app);
            }
          },
        },
        !f.created && {
          label: 'Baixar original',
          icon: 'download',
          run: async () => {
            const b = await db.getBlob(f.id);
            if (b) download(b, f.name);
          },
        },
        '-',
        {
          label: 'Remover da biblioteca',
          icon: 'trash',
          danger: true,
          run: async () => {
            if (await confirmDialog('Remover arquivo?', `<p><b>${esc(f.name)}</b> e todas as suas anotações serão apagados deste aparelho.</p>`, 'Remover', true)) {
              await db.deleteFile(f.id);
              renderLibrary(app);
            }
          },
        },
      ].filter(Boolean));
    });
    return el;
  }

  renderChips();
  renderGrid();
}
