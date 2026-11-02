// Exporta PDFs com as anotações "gravadas" por cima das páginas.
// 1) Tenta manter o PDF original (texto continua selecionável) e desenhar as anotações
//    como imagens transparentes — marca-texto com blend "Multiply", igual ao real.
// 2) Se o PDF não puder ser modificado (ex.: criptografado), rasteriza as páginas.
import { PDFDocument, BlendMode, degrees } from 'pdf-lib';
import { renderShapesToCanvases } from '../annotations.js';
import { canvasToBlob } from '../util.js';

const EXPORT_SCALE = 2.2; // resolução das anotações (pixels por ponto PDF)

async function canvasBytes(c, type = 'image/png', q) {
  return new Uint8Array(await (await canvasToBlob(c, type, q)).arrayBuffer());
}

function isEmpty(shapes) {
  return !shapes || !shapes.length;
}

export async function exportAnnotatedPdf({ bytes, pdfjsDoc, annotations }) {
  try {
    return await overlayExport(bytes, pdfjsDoc, annotations);
  } catch (e) {
    console.warn('Exportação vetorial falhou, rasterizando…', e);
    return rasterExport(pdfjsDoc, annotations);
  }
}

async function overlayExport(bytes, pdfjsDoc, annotations) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const shapes = annotations[`p${i + 1}`];
    if (isEmpty(shapes)) continue;
    const page = pages[i];
    // Tamanho exibido (com rotação) segundo o pdf.js — o mesmo usado na tela.
    const pj = await pdfjsDoc.getPage(i + 1);
    const vp = pj.getViewport({ scale: 1 });
    const W = vp.width,
      H = vp.height;
    const { hl, ink } = renderShapesToCanvases(shapes, W * EXPORT_SCALE, H * EXPORT_SCALE);
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const box = page.getCropBox?.() || page.getMediaBox();
    // Retângulo no espaço não-rotacionado onde a imagem deve cair.
    const uw = rot % 180 ? H : W; // largura não-rotacionada
    const uh = rot % 180 ? W : H;
    const place = {
      0: { x: 0, y: 0 },
      90: { x: uw, y: 0 },
      180: { x: uw, y: uh },
      270: { x: 0, y: uh },
    }[rot] || { x: 0, y: 0 };
    const opts = { x: box.x + place.x, y: box.y + place.y, width: W, height: H, rotate: degrees(rot) };
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

async function rasterExport(pdfjsDoc, annotations) {
  const out = await PDFDocument.create();
  for (let n = 1; n <= pdfjsDoc.numPages; n++) {
    const page = await pdfjsDoc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas');
    c.width = vp.width;
    c.height = vp.height;
    const x = c.getContext('2d');
    await page.render({ canvasContext: x, viewport: vp }).promise;
    const shapes = annotations[`p${n}`];
    if (!isEmpty(shapes)) {
      const { hl, ink } = renderShapesToCanvases(shapes, c.width, c.height);
      x.globalCompositeOperation = 'multiply';
      x.drawImage(hl, 0, 0);
      x.globalCompositeOperation = 'source-over';
      x.drawImage(ink, 0, 0);
    }
    const img = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.9));
    const p = out.addPage([v1.width, v1.height]);
    p.drawImage(img, { x: 0, y: 0, width: v1.width, height: v1.height });
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
export function compositeAnnotations(ctx2d, shapes, w, hgt) {
  if (isEmpty(shapes)) return;
  const { hl, ink } = renderShapesToCanvases(shapes, w, hgt);
  ctx2d.save();
  ctx2d.globalCompositeOperation = 'multiply';
  ctx2d.drawImage(hl, 0, 0);
  ctx2d.globalCompositeOperation = 'source-over';
  ctx2d.drawImage(ink, 0, 0);
  ctx2d.restore();
}
