// Converte o HTML do editor em um arquivo Word (.docx) de verdade, preservando
// títulos, negrito/itálico/sublinhado/tachado, cores, marca-texto, tamanhos,
// alinhamento, listas, citações, tabelas e imagens.
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun, Table, TableRow,
  TableCell, WidthType, ShadingType, LevelFormat, ExternalHyperlink, BorderStyle,
} from 'docx';
import { dataUrlToBytes, loadImage } from '../util.js';

const FONT_SIZES = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 }; // px
const HEADINGS = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3, H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6 };
const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION']);

function toHex(color) {
  if (!color || color === 'transparent') return null;
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) return color.slice(1).split('').map((c) => c + c).join('').toUpperCase();
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(color);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  // nomes de cor: usa o navegador
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = color;
  const v = c.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(v) ? v.slice(1).toUpperCase() : null;
}

function alignmentOf(el) {
  const a = (el.style?.textAlign || el.getAttribute?.('align') || '').toLowerCase();
  return { center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT }[a];
}

function styleFor(el, base) {
  const s = { ...base };
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') s.bold = true;
  if (tag === 'I' || tag === 'EM') s.italics = true;
  if (tag === 'U' || tag === 'INS') s.underline = {};
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s.strike = true;
  if (tag === 'SUP') s.superScript = true;
  if (tag === 'SUB') s.subScript = true;
  if (tag === 'CODE' || tag === 'KBD') s.font = 'Consolas';
  if (tag === 'MARK') s.shade = toHex(el.style.backgroundColor) || 'FFE14D';
  if (tag === 'FONT') {
    if (el.getAttribute('color')) s.color = toHex(el.getAttribute('color'));
    const sz = el.getAttribute('size');
    if (sz && FONT_SIZES[sz]) s.size = Math.round(FONT_SIZES[sz] * 0.75 * 2);
    if (el.getAttribute('face')) s.font = el.getAttribute('face').split(',')[0].replace(/['"]/g, '');
  }
  const st = el.style;
  if (st) {
    if (st.fontWeight === 'bold' || +st.fontWeight >= 600) s.bold = true;
    if (st.fontStyle === 'italic') s.italics = true;
    const deco = st.textDecorationLine || st.textDecoration || '';
    if (deco.includes('underline')) s.underline = {};
    if (deco.includes('line-through')) s.strike = true;
    if (st.color) s.color = toHex(st.color) || s.color;
    if (st.backgroundColor) {
      const bg = toHex(st.backgroundColor);
      if (bg) s.shade = bg;
      else if (st.backgroundColor === 'transparent') delete s.shade;
    }
    if (st.fontSize) {
      const m = /([\d.]+)(px|pt|em|rem)/.exec(st.fontSize);
      if (m) {
        let pt = +m[1];
        if (m[2] === 'px') pt *= 0.75;
        if (m[2] === 'em' || m[2] === 'rem') pt *= 12;
        s.size = Math.round(pt * 2);
      }
    }
    if (st.fontFamily) s.font = st.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
  }
  return s;
}

function run(text, s) {
  const opts = {
    text,
    bold: s.bold,
    italics: s.italics,
    underline: s.underline,
    strike: s.strike,
    color: s.color || undefined,
    size: s.size,
    font: s.font,
    superScript: s.superScript,
    subScript: s.subScript,
  };
  if (s.shade) opts.shading = { type: ShadingType.CLEAR, color: 'auto', fill: s.shade };
  return new TextRun(opts);
}

async function imageRun(img) {
  const src = img.getAttribute('src') || '';
  let bytes, mime;
  try {
    if (src.startsWith('data:')) ({ bytes, mime } = dataUrlToBytes(src));
    else {
      const r = await fetch(src);
      mime = r.headers.get('content-type') || 'image/png';
      bytes = new Uint8Array(await r.arrayBuffer());
    }
  } catch {
    return null;
  }
  let type = /png/.test(mime) ? 'png' : /jpe?g/.test(mime) ? 'jpg' : /gif/.test(mime) ? 'gif' : /bmp/.test(mime) ? 'bmp' : null;
  let w = img.naturalWidth || img.width || 400;
  let hgt = img.naturalHeight || img.height || 300;
  if (!type) {
    // webp/svg → converte para PNG
    try {
      const im = await loadImage(src);
      const c = document.createElement('canvas');
      c.width = im.naturalWidth || 600;
      c.height = im.naturalHeight || 400;
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      ({ bytes } = dataUrlToBytes(c.toDataURL('image/png')));
      type = 'png';
      w = c.width;
      hgt = c.height;
    } catch {
      return null;
    }
  }
  const maxW = 600;
  if (w > maxW) {
    hgt = Math.round((hgt * maxW) / w);
    w = maxW;
  }
  return new ImageRun({ type, data: bytes, transformation: { width: w, height: hgt } });
}

async function inlineRuns(node, s, out) {
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      const t = n.textContent.replace(/\s+/g, ' ');
      if (t) out.push(run(t, s));
    } else if (n.nodeType === 1) {
      const tag = n.tagName;
      if (tag === 'BR') out.push(new TextRun({ break: 1 }));
      else if (tag === 'IMG') {
        const r = await imageRun(n);
        if (r) out.push(r);
      } else if (tag === 'A' && n.getAttribute('href')?.startsWith('http')) {
        const kids = [];
        await inlineRuns(n, { ...styleFor(n, s), color: '1971C2', underline: {} }, kids);
        out.push(new ExternalHyperlink({ link: n.getAttribute('href'), children: kids }));
      } else if (!BLOCKS.has(tag)) await inlineRuns(n, styleFor(n, s), out);
      else await inlineRuns(n, styleFor(n, s), out); // bloco aninhado em inline: achata
    }
  }
  return out;
}

function para(base, opts) {
  if (base.quote && !opts.indent) {
    opts.indent = { left: 567 };
    opts.border = { left: { style: BorderStyle.SINGLE, size: 12, color: 'BBBBBB', space: 10 } };
  }
  return new Paragraph(opts);
}

/** Converte um container de blocos em parágrafos/tabelas. */
async function blocks(root, ctx, base = {}, listLevel = -1, listType = null) {
  const out = [];
  let pendingInline = [];
  const flushInline = async () => {
    if (!pendingInline.length) return;
    const holder = document.createElement('p');
    pendingInline.forEach((n) => holder.appendChild(n.cloneNode(true)));
    pendingInline = [];
    const runs = await inlineRuns(holder, base, []);
    if (runs.length) out.push(para(base, { children: runs }));
  };
  for (const n of [...root.childNodes]) {
    if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCKS.has(n.tagName))) {
      if (n.nodeType === 3 && !n.textContent.trim() && !pendingInline.length) continue;
      pendingInline.push(n);
      continue;
    }
    if (n.nodeType !== 1) continue;
    await flushInline();
    const tag = n.tagName;
    const align = alignmentOf(n);
    const indentPx = parseFloat(n.style?.marginLeft || n.style?.paddingLeft || 0) || 0;
    const indent = indentPx ? { left: Math.round(indentPx * 15) } : undefined;
    if (HEADINGS[tag]) {
      out.push(para(base, { heading: HEADINGS[tag], alignment: align, indent, children: await inlineRuns(n, styleFor(n, base), []) }));
    } else if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'FIGURE' || tag === 'FIGCAPTION') {
      if ([...n.children].some((c) => BLOCKS.has(c.tagName))) out.push(...(await blocks(n, ctx, styleFor(n, base))));
      else out.push(para(base, { alignment: align, indent, children: await inlineRuns(n, styleFor(n, base), []) }));
    } else if (tag === 'BLOCKQUOTE') {
      const qb = { ...base, italics: true, color: '555555', quote: true };
      if ([...n.children].some((c) => BLOCKS.has(c.tagName))) out.push(...(await blocks(n, ctx, qb)));
      else out.push(para(qb, { children: await inlineRuns(n, qb, []) }));
    } else if (tag === 'PRE') {
      const lines = n.textContent.split('\n');
      out.push(
        new Paragraph({
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F3F5' },
          children: lines.flatMap((l, i) => [run(l, { ...base, font: 'Consolas', size: 19 }), ...(i < lines.length - 1 ? [new TextRun({ break: 1 })] : [])]),
        }),
      );
    } else if (tag === 'UL' || tag === 'OL') {
      out.push(...(await blocks(n, ctx, base, listLevel + 1, tag)));
    } else if (tag === 'LI') {
      const level = Math.max(0, Math.min(8, listLevel));
      const inlineHolder = document.createElement('span');
      const nested = [];
      for (const c of n.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
        else if (c.nodeType === 1 && c.tagName === 'P') {
          inlineHolder.append(...[...c.childNodes].map((x) => x.cloneNode(true)));
          inlineHolder.append(document.createElement('br'));
        } else inlineHolder.appendChild(c.cloneNode(true));
      }
      if (inlineHolder.lastChild?.tagName === 'BR') inlineHolder.lastChild.remove();
      const runs = await inlineRuns(inlineHolder, styleFor(n, base), []);
      out.push(
        para(base, {
          alignment: align,
          children: runs,
          ...(listType === 'OL' ? { numbering: { reference: 'mr-numbered', level } } : { bullet: { level } }),
        }),
      );
      for (const l of nested) out.push(...(await blocks(l, ctx, base, listLevel + 1, l.tagName)));
    } else if (tag === 'TABLE') {
      const rows = [...n.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr')];
      if (!rows.length) continue;
      const cols = Math.max(...rows.map((r) => [...r.cells].reduce((a, c) => a + (c.colSpan || 1), 0)));
      const trs = [];
      for (const r of rows) {
        const cells = [];
        for (const c of r.cells) {
          const inner = await blocks(c, ctx, c.tagName === 'TH' ? { ...base, bold: true } : base);
          cells.push(
            new TableCell({
              children: inner.length ? inner : [new Paragraph('')],
              columnSpan: c.colSpan > 1 ? c.colSpan : undefined,
              rowSpan: c.rowSpan > 1 ? c.rowSpan : undefined,
              shading: toHex(c.style.backgroundColor) ? { type: ShadingType.CLEAR, color: 'auto', fill: toHex(c.style.backgroundColor) } : undefined,
            }),
          );
        }
        if (cells.length) trs.push(new TableRow({ children: cells }));
      }
      if (trs.length) out.push(new Table({ rows: trs, width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: Array(cols).fill(Math.floor(9000 / cols)) }));
      out.push(new Paragraph(''));
    } else if (tag === 'HR') {
      out.push(new Paragraph({ border: { bottom: { color: 'BBBBBB', space: 1, style: BorderStyle.SINGLE, size: 6 } }, children: [] }));
    }
  }
  await flushInline();
  return out;
}

export async function htmlToDocx(root, { title = 'Documento' } = {}) {
  const ctx = {};
  const children = await blocks(root, ctx);
  const levels = Array.from({ length: 9 }, (_, i) => ({
    level: i,
    format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][i % 3],
    text: `%${i + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } },
  }));
  const doc = new Document({
    title,
    creator: 'MyReader',
    styles: {
      default: { document: { run: { font: 'Calibri', size: 24 } } },
    },
    numbering: { config: [{ reference: 'mr-numbered', levels }] },
    sections: [{ properties: {}, children: children.length ? children : [new Paragraph('')] }],
  });
  return Packer.toBlob(doc);
}
