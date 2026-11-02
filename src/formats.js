import { ext } from './util.js';

export const KINDS = {
  pdf: { label: 'PDF', icon: 'file-text', color: '#ef5a4c' },
  docx: { label: 'Word', icon: 'file-type', color: '#3b7cf6' },
  markdown: { label: 'Markdown', icon: 'file-text', color: '#5b6474' },
  html: { label: 'HTML', icon: 'code', color: '#e0743b' },
  text: { label: 'Texto', icon: 'file-text', color: '#6b7280' },
  musicxml: { label: 'Partitura', icon: 'music', color: '#9b5cf6' },
  abc: { label: 'Partitura ABC', icon: 'file-music', color: '#b44ee8' },
  epub: { label: 'EPUB', icon: 'book', color: '#14a38b' },
  sheet: { label: 'Planilha', icon: 'sheet', color: '#1f9d55' },
  pptx: { label: 'PowerPoint', icon: 'presentation', color: '#d9541e' },
  image: { label: 'Imagem', icon: 'image', color: '#f59e0b' },
  notebook: { label: 'Caderno', icon: 'notebook', color: '#e8a10e' },
};

const TEXT_EXT = new Set([
  'txt', 'log', 'json', 'js', 'mjs', 'ts', 'jsx', 'tsx', 'css', 'scss', 'py', 'java', 'c', 'h', 'cpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'yml', 'yaml', 'toml', 'ini', 'sql', 'kt', 'swift', 'lua',
  'srt', 'vtt', 'tex', 'cfg', 'conf', 'env', 'lrc', 'chordpro', 'cho', 'crd',
]);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const SHEET_EXT = new Set(['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv', 'numbers']);

export const UNSUPPORTED = {
  doc: 'Arquivos .doc (Word 97-2003) não podem ser lidos no navegador. Abra no Word e salve como .docx.',
  ppt: 'Arquivos .ppt (PowerPoint 97-2003) não podem ser lidos no navegador. Abra no PowerPoint e salve como .pptx.',
  key: 'Apresentações do Keynote: exporte como .pptx ou PDF para abrir aqui.',
  odt: 'Documentos .odt ainda não são suportados. Salve como .docx ou PDF.',
  rtf: 'Arquivos .rtf ainda não são suportados. Salve como .docx ou PDF.',
  mid: 'Arquivos MIDI não contêm partitura visual. Use MusicXML (.musicxml/.mxl), ABC ou PDF.',
  midi: 'Arquivos MIDI não contêm partitura visual. Use MusicXML (.musicxml/.mxl), ABC ou PDF.',
  mscz: 'Arquivos do MuseScore (.mscz): exporte como MusicXML ou PDF no MuseScore para abrir aqui.',
};

/** Descobre o tipo de visualizador para um arquivo. */
export async function detectKind(file) {
  const e = ext(file.name);
  const t = file.type || '';
  if (e === 'pdf' || t === 'application/pdf') return 'pdf';
  if (e === 'docx' || e === 'dotx' || t.includes('wordprocessingml')) return 'docx';
  if (e === 'pptx' || e === 'ppsx' || e === 'potx' || t.includes('presentationml')) return 'pptx';
  if (e === 'epub' || t === 'application/epub+zip') return 'epub';
  if (e === 'musicxml' || e === 'mxl') return 'musicxml';
  if (e === 'abc') return 'abc';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'html' || e === 'htm' || e === 'xhtml') return 'html';
  if (SHEET_EXT.has(e) || t.includes('spreadsheet') || t === 'text/csv') return 'sheet';
  if (IMG_EXT.has(e) || t.startsWith('image/')) return 'image';
  if (e === 'xml') {
    const head = await file.slice(0, 4000).text();
    if (/<score-(partwise|timewise)/.test(head)) return 'musicxml';
    return 'text';
  }
  if (UNSUPPORTED[e]) return null;
  if (TEXT_EXT.has(e) || t.startsWith('text/')) return 'text';
  // Última tentativa: parece texto?
  const sample = new Uint8Array(await file.slice(0, 2048).arrayBuffer());
  const binary = sample.some((b) => b === 0);
  return binary ? null : 'text';
}

export const ACCEPT = [
  '.pdf', '.docx', '.dotx', '.pptx', '.ppsx', '.potx', '.epub', '.musicxml', '.mxl', '.xml', '.abc', '.md', '.markdown', '.txt',
  '.html', '.htm', '.xlsx', '.xls', '.ods', '.csv', '.tsv', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.bmp', '.svg', '.avif', '.json', '.srt', '.lrc', '.chordpro', '.cho',
  'application/pdf', 'image/*', 'text/*',
].join(',');
