// Exporta PDFs com as anotações "gravadas" por cima das páginas.
// 1) Tenta manter o PDF original (texto continua selecionável) e desenhar as anotações
//    como imagens transparentes — marca-texto com blend "Multiply", igual ao real.
// 2) Se o PDF não puder ser modificado (ex.: criptografado), rasteriza as páginas.
import { PDFDocument, BlendMode, degrees, rgb } from 'pdf-lib';
import { renderShapesToCanvases, ensureImages, NO_MARGIN } from '../annotations.js';
import { canvasToBlob } from '../util.js';

const EXPORT_SCALE = 2.2; // resolução das anotações (pixels por ponto PDF)

async function canvasBytes(c, type = 'image/png', q) {
  return new Uint8Array(await (await canvasToBlob(c, type, q)).arrayBuffer());
}

function isEmpty(shapes) {
  return !shapes || !shapes.length;
}

const hasMargin = (m) => !!m && m.l + m.t + m.r + m.b > 0;

export async function exportAnnotatedPdf({ bytes, pdfjsDoc, annotations, margin = NO_MARGIN }) {
  await ensureImages(annotations);
  try {
    return await overlayExport(bytes, pdfjsDoc, annotations, margin);
  } catch (e) {
    console.warn('Exportação vetorial falhou, rasterizando…', e);
    return rasterExport(pdfjsDoc, annotations, margin);
  }
}

async function overlayExport(bytes, pdfjsDoc, annotations, m) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const withMargin = hasMargin(m);
  for (let i = 0; i < pages.length; i++) {
    const shapes = annotations[`p${i + 1}`];
    if (isEmpty(shapes) && !withMargin) continue;
    const page = pages[i];
    // Tamanho exibido (com rotação) segundo o pdf.js — o mesmo usado na tela.
    const pj = await pdfjsDoc.getPage(i + 1);
    const vp = pj.getViewport({ scale: 1 });
    const W = vp.width,
      H = vp.height;
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const box = page.getCropBox?.() || page.getMediaBox();
    let opts;
    let full = { W, H };
    if (withMargin) {
      // Página maior, com faixas brancas em volta (só para páginas sem rotação).
      if (rot !== 0) throw new Error('margem em página rotacionada');
      const k = W / 1000;
      const ml = m.l * k,
        mr = m.r * k,
        mt = m.t * k,
        mb = m.b * k;
      const nx = box.x - ml,
        ny = box.y - mb,
        nw = W + ml + mr,
        nh = H + mt + mb;
      page.setMediaBox(nx, ny, nw, nh);
      page.setCropBox(nx, ny, nw, nh);
      const white = rgb(1, 1, 1);
      if (ml) page.drawRectangle({ x: nx, y: ny, width: ml, height: nh, color: white });
      if (mr) page.drawRectangle({ x: box.x + W, y: ny, width: mr, height: nh, color: white });
      if (mb) page.drawRectangle({ x: nx, y: ny, width: nw, height: mb, color: white });
      if (mt) page.drawRectangle({ x: nx, y: box.y + H, width: nw, height: mt, color: white });
      full = { W: nw, H: nh };
      opts = { x: nx, y: ny, width: nw, height: nh };
    } else {
      // Retângulo no espaço não-rotacionado onde a imagem deve cair.
      const uw = rot % 180 ? H : W; // largura não-rotacionada
      const uh = rot % 180 ? W : H;
      const place = {
        0: { x: 0, y: 0 },
        90: { x: uw, y: 0 },
        180: { x: uw, y: uh },
        270: { x: 0, y: uh },
      }[rot] || { x: 0, y: 0 };
      opts = { x: box.x + place.x, y: box.y + place.y, width: W, height: H, rotate: degrees(rot) };
    }
    if (isEmpty(shapes)) continue;
    const { hl, ink } = renderShapesToCanvases(shapes, full.W * EXPORT_SCALE, full.H * EXPORT_SCALE, withMargin ? m : NO_MARGIN);
    const hasHl = shapes.some((s) => s.t === 'hl' || s.t === 'hlrect');
    const hasInk = shapes.some((s) => !(s.t === 'hl' || s.t === 'hlrect'));
    if (hasHl) {
      const img = await doc.embedPng(await canvasBytes(hl));
      page.drawImage(img, { ...opts, blendMode: BlendMode.Multiply });
    }
    if (hasInk) {
      const img = await doc.embedPng(await canvasBytes(ink));
      page.drawImage(img, opts);
    }
  }
  const out = await doc.save();
  return new Blob([out], { type: 'application/pdf' });
}

async function rasterExport(pdfjsDoc, annotations, m = NO_MARGIN) {
  const out = await PDFDocument.create();
  for (let n = 1; n <= pdfjsDoc.numPages; n++) {
    const page = await pdfjsDoc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 2 });
    const k = vp.width / 1000;
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width + (m.l + m.r) * k);
    c.height = Math.round(vp.height + (m.t + m.b) * k);
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp, transform: [1, 0, 0, 1, m.l * k, m.t * k] }).promise;
    const shapes = annotations[`p${n}`];
    if (!isEmpty(shapes)) {
      const { hl, ink } = renderShapesToCanvases(shapes, c.width, c.height, m);
      x.globalCompositeOperation = 'multiply';
      x.drawImage(hl, 0, 0);
      x.globalCompositeOperation = 'source-over';
      x.drawImage(ink, 0, 0);
    }
    const img = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.9));
    const pw = c.width / 2,
      ph = c.height / 2;
    const p = out.addPage([pw, ph]);
    p.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  }
  return new Blob([await out.save()], { type: 'application/pdf' });
}

/**
 * Monta um PDF a partir de "páginas" genéricas (partitura, caderno, imagem...).
 * pages: [{ width, height (em pt), draw: async (ctx, pxWidth, pxHeight) }]
 */
export async function pagesToPdf(pages, scale = 2) {
  const out = await PDFDocument.create();
  for (const pg of pages) {
    const c = document.createElement('canvas');
    c.width = Math.round(pg.width * scale);
    c.height = Math.round(pg.height * scale);
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    await pg.draw(x, c.width, c.height);
    const img = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.92));
    const p = out.addPage([pg.width, pg.height]);
    p.drawImage(img, { x: 0, y: 0, width: pg.width, height: pg.height });
  }
  return new Blob([await out.save()], { type: 'application/pdf' });
}

/** Compõe anotações sobre um contexto 2D já desenhado. */
export function compositeAnnotations(ctx2d, shapes, w, hgt, m = NO_MARGIN) {
  if (isEmpty(shapes)) return;
  const { hl, ink } = renderShapesToCanvases(shapes, w, hgt, m);
  ctx2d.save();
  ctx2d.globalCompositeOperation = 'multiply';
  ctx2d.drawImage(hl, 0, 0);
  ctx2d.globalCompositeOperation = 'source-over';
  ctx2d.drawImage(ink, 0, 0);
  ctx2d.restore();
}
