// Apresentações PowerPoint (.pptx): interpreta o XML dos slides (temas, layouts,
// masters, textos, formas, imagens, tabelas, grupos) e desenha cada slide num canvas.
// Tem anotações por slide, notas do apresentador, modo apresentação e exportação em PDF.
import JSZip from 'jszip';
import { h, esc, download, baseName } from '../util.js';
import { icon } from '../icons.js';
import { pagesToPdf, compositeAnnotations } from '../export/pdf-export.js';
import { renderShapesToCanvases } from '../annotations.js';

const EMU_PT = 12700;

// ---------------------------------------------------------------- XML helpers
const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const path = (el, ...names) => names.reduce((e, n) => kid(e, n), el);
const desc = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
const attr = (el, name) => (el ? el.getAttribute(name) : null);
const num = (v, d = 0) => (v == null || v === '' ? d : Number(v));

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const relsPathOf = (p) => {
  const i = p.lastIndexOf('/');
  return `${p.slice(0, i)}/_rels/${p.slice(i + 1)}.rels`;
};

// ---------------------------------------------------------------- cores
function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let hh = 0,
    s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hh = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh, s, l];
}
function hslToRgb([hh, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(hh + 1 / 3) * 255, f(hh) * 255, f(hh - 1 / 3) * 255];
}
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080' };

// ---------------------------------------------------------------- leitor
class Pptx {
  constructor(zip) {
    this.zip = zip;
    this.xmlCache = new Map();
    this.images = new Map();
  }
  async xml(p) {
    if (!this.xmlCache.has(p)) {
      const f = this.zip.file(p);
      this.xmlCache.set(p, f ? parseXml(await f.async('string')) : null);
    }
    return this.xmlCache.get(p);
  }
  async rels(p) {
    const doc = await this.xml(relsPathOf(p));
    const map = {};
    if (doc) for (const r of doc.getElementsByTagNameNS('*', 'Relationship')) map[r.getAttribute('Id')] = { target: resolvePath(p, r.getAttribute('Target')), type: r.getAttribute('Type'), external: r.getAttribute('TargetMode') === 'External' };
    return map;
  }
  async image(p) {
    if (this.images.has(p)) return this.images.get(p);
    const prom = (async () => {
      const f = this.zip.file(p);
      if (!f || /\.(emf|wmf|tiff?)$/i.test(p)) return null;
      const blob = await f.async('blob');
      const typed = /\.svg$/i.test(p) ? new Blob([blob], { type: 'image/svg+xml' }) : blob;
      const url = URL.createObjectURL(typed);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        return img;
      } catch {
        return null;
      }
    })();
    this.images.set(p, prom);
    return prom;
  }

  async load() {
    const pres = await this.xml('ppt/presentation.xml');
    const sz = desc(pres, 'sldSz');
    this.cx = num(attr(sz, 'cx'), 9144000);
    this.cy = num(attr(sz, 'cy'), 6858000);
    const prels = await this.rels('ppt/presentation.xml');
    const ids = [...pres.getElementsByTagNameNS('*', 'sldId')];
    this.slidePaths = ids.map((s) => prels[s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id')]?.target).filter(Boolean);
    this.slides = [];
    for (const p of this.slidePaths) this.slides.push(await this.loadSlide(p));
  }

  async loadSlide(p) {
    const doc = await this.xml(p);
    const rels = await this.rels(p);
    const layoutPath = Object.values(rels).find((r) => r.type.endsWith('/slideLayout'))?.target;
    const layout = layoutPath ? await this.part(layoutPath, 'slideMaster') : null;
    const master = layout?.parentPath ? await this.part(layout.parentPath, 'theme') : null;
    const theme = master?.parentPath ? await this.loadTheme(master.parentPath) : this.defaultTheme();
    const notesPath = Object.values(rels).find((r) => r.type.endsWith('/notesSlide'))?.target;
    let notes = '';
    if (notesPath) {
      const nd = await this.xml(notesPath);
      for (const sp of nd?.getElementsByTagNameNS('*', 'sp') || []) {
        const ph = desc(sp, 'ph');
        if (attr(ph, 'type') === 'body') notes = [...sp.getElementsByTagNameNS('*', 'p')].map((pp) => [...pp.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('')).join('\n').trim();
      }
    }
    return { path: p, doc, rels, layout, master, theme, notes, show: attr(doc.documentElement, 'show') !== '0' };
  }

  async part(p, parentType) {
    const doc = await this.xml(p);
    const rels = await this.rels(p);
    const parentPath = Object.values(rels).find((r) => r.type.endsWith(`/${parentType}`))?.target;
    return { path: p, doc, rels, parentPath };
  }

  defaultTheme() {
    return { colors: { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72' }, major: 'Calibri Light', minor: 'Calibri' };
  }

  async loadTheme(p) {
    if (this.themeCache?.[p]) return this.themeCache[p];
    const doc = await this.xml(p);
    const t = this.defaultTheme();
    const cs = desc(doc, 'clrScheme');
    for (const c of cs ? [...cs.children] : []) {
      const v = kid(c, 'srgbClr') ? attr(kid(c, 'srgbClr'), 'val') : attr(kid(c, 'sysClr'), 'lastClr');
      if (v) t.colors[c.localName] = v;
    }
    const maj = desc(desc(doc, 'majorFont'), 'latin');
    const min = desc(desc(doc, 'minorFont'), 'latin');
    if (attr(maj, 'typeface')) t.major = attr(maj, 'typeface');
    if (attr(min, 'typeface')) t.minor = attr(min, 'typeface');
    (this.themeCache ||= {})[p] = t;
    return t;
  }
}

// ---------------------------------------------------------------- renderização
class SlideRenderer {
  constructor(pptx, slide) {
    this.p = pptx;
    this.s = slide;
    this.theme = slide.theme;
  }

  color(el, phClr) {
    if (!el) return null;
    let hex = null,
      alpha = 1;
    let base = el;
    const n = el.localName;
    if (n === 'srgbClr') hex = attr(el, 'val');
    else if (n === 'sysClr') hex = attr(el, 'lastClr') || '000000';
    else if (n === 'prstClr') hex = PRESET[attr(el, 'val')] || '000000';
    else if (n === 'schemeClr') {
      let v = attr(el, 'val');
      v = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[v] || v;
      hex = v === 'phClr' ? phClr || '000000' : this.theme.colors[v] || '000000';
    } else if (n === 'scrgbClr') {
      hex = [attr(el, 'r'), attr(el, 'g'), attr(el, 'b')].map((x) => Math.round((num(x) / 100000) * 255).toString(16).padStart(2, '0')).join('');
    } else {
      const c = [...el.children].find((x) => /Clr$/.test(x.localName));
      return c ? this.color(c, phClr) : null;
    }
    let rgb = hexToRgb(hex || '000000');
    for (const m of base.children) {
      const v = num(attr(m, 'val')) / 100000;
      if (m.localName === 'alpha') alpha = v;
      else if (m.localName === 'lumMod' || m.localName === 'lumOff') {
        const hsl = rgbToHsl(rgb);
        hsl[2] = m.localName === 'lumMod' ? hsl[2] * v : hsl[2] + v;
        hsl[2] = Math.max(0, Math.min(1, hsl[2]));
        rgb = hslToRgb(hsl);
      } else if (m.localName === 'tint') rgb = rgb.map((c) => c + (255 - c) * (1 - v));
      else if (m.localName === 'shade') rgb = rgb.map((c) => c * v);
    }
    return `rgba(${rgb.map((c) => Math.round(Math.max(0, Math.min(255, c)))).join(',')},${alpha})`;
  }

  /** Converte um elemento de preenchimento em estilo de canvas. */
  async fill(container, x, y, w, hh, ctx, phClr, rels) {
    if (!container) return undefined;
    if (kid(container, 'noFill')) return null;
    const sf = kid(container, 'solidFill');
    if (sf) return this.color(sf, phClr);
    const gf = kid(container, 'gradFill');
    if (gf) {
      const stops = kids(kid(gf, 'gsLst'), 'gs');
      if (!stops.length) return undefined;
      const ang = (num(attr(kid(gf, 'lin'), 'ang'), 5400000) / 60000) * (Math.PI / 180);
      const cx = x + w / 2,
        cy = y + hh / 2;
      const len = (Math.abs(w * Math.cos(ang)) + Math.abs(hh * Math.sin(ang))) / 2;
      const g = kid(gf, 'path')
        ? ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, hh) / 1.4)
        : ctx.createLinearGradient(cx - Math.cos(ang) * len, cy - Math.sin(ang) * len, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, num(attr(s, 'pos')) / 100000)), this.color(s, phClr) || '#000');
      return g;
    }
    const bf = kid(container, 'blipFill');
    if (bf) {
      const img = await this.blip(bf, rels);
      if (img) return { img, crop: kid(bf, 'srcRect') };
    }
    return undefined;
  }

  async blip(blipFill, rels) {
    const b = kid(blipFill, 'blip');
    const id = b?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
    const r = id && rels[id];
    if (!r || r.external) return null;
    return this.p.image(r.target);
  }

  // ------------------------------------------------ placeholders
  phOf(sp) {
    const ph = desc(kid(sp, 'nvSpPr') || kid(sp, 'nvPicPr') || kid(sp, 'nvGraphicFramePr') || sp, 'ph');
    if (!ph) return null;
    return { type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx') };
  }
  findPh(partDoc, ph) {
    if (!partDoc || !ph) return null;
    const sps = [...partDoc.getElementsByTagNameNS('*', 'sp')];
    const norm = (t) => (t === 'ctrTitle' ? 'title' : t === 'subTitle' ? 'body' : t);
    let found = ph.idx != null ? sps.find((s) => attr(desc(s, 'ph'), 'idx') === ph.idx) : null;
    if (!found) found = sps.find((s) => desc(s, 'ph') && (attr(desc(s, 'ph'), 'type') || 'body') === ph.type);
    if (!found) found = sps.find((s) => desc(s, 'ph') && norm(attr(desc(s, 'ph'), 'type') || 'body') === norm(ph.type));
    return found;
  }
  chain(sp) {
    const ph = this.phOf(sp);
    if (!ph) return [sp];
    const l = this.findPh(this.s.layout?.doc, ph);
    const m = this.findPh(this.s.master?.doc, ph);
    return [sp, l, m].filter(Boolean);
  }

  /** Estilo padrão de texto para um nível, buscando na cadeia de herança. */
  levelStyle(chain, ph, lvl) {
    const out = {};
    const merge = (pPr) => {
      if (!pPr) return;
      const r = kid(pPr, 'defRPr');
      if (out.sz == null && attr(r, 'sz')) out.sz = num(attr(r, 'sz'));
      if (out.b == null && attr(r, 'b') != null) out.b = attr(r, 'b') === '1';
      if (out.i == null && attr(r, 'i') != null) out.i = attr(r, 'i') === '1';
      if (out.color == null && kid(r, 'solidFill')) out.color = this.color(kid(r, 'solidFill'));
      if (out.font == null && attr(kid(r, 'latin'), 'typeface')) out.font = attr(kid(r, 'latin'), 'typeface');
      if (out.algn == null && attr(pPr, 'algn')) out.algn = attr(pPr, 'algn');
      if (out.marL == null && attr(pPr, 'marL')) out.marL = num(attr(pPr, 'marL'));
      if (out.indent == null && attr(pPr, 'indent')) out.indent = num(attr(pPr, 'indent'));
      if (out.bu == null) {
        if (kid(pPr, 'buNone')) out.bu = false;
        else if (kid(pPr, 'buChar')) out.bu = attr(kid(pPr, 'buChar'), 'char');
        else if (kid(pPr, 'buAutoNum')) out.bu = '#';
      }
      if (out.lnSpc == null && desc(kid(pPr, 'lnSpc'), 'spcPct')) out.lnSpc = num(attr(desc(kid(pPr, 'lnSpc'), 'spcPct'), 'val')) / 100000;
      if (out.spcBef == null && desc(kid(pPr, 'spcBef'), 'spcPts')) out.spcBef = num(attr(desc(kid(pPr, 'spcBef'), 'spcPts'), 'val'));
    };
    const L = `lvl${lvl + 1}pPr`;
    for (const sp of chain) merge(kid(desc(sp, 'lstStyle'), L));
    const tx = desc(this.s.master?.doc, 'txStyles');
    if (tx) {
      const t = ph?.type;
      const style = t === 'title' || t === 'ctrTitle' ? kid(tx, 'titleStyle') : ph ? kid(tx, 'bodyStyle') : kid(tx, 'otherStyle');
      merge(kid(style, L));
    }
    return out;
  }

  // ------------------------------------------------ desenho
  async render(ctx, k) {
    const { s } = this;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.p.cx * k, this.p.cy * k);
    await this.background(ctx, k);
    const showMaster = (d) => attr(d?.documentElement, 'showMasterSp') !== '0';
    if (s.master && showMaster(s.doc) && showMaster(s.layout?.doc)) await this.tree(ctx, k, desc(s.master.doc, 'spTree'), s.master.rels, true);
    if (s.layout && showMaster(s.doc)) await this.tree(ctx, k, desc(s.layout.doc, 'spTree'), s.layout.rels, true);
    await this.tree(ctx, k, desc(s.doc, 'spTree'), s.rels, false);
    ctx.restore();
  }

  async background(ctx, k) {
    const W = this.p.cx * k,
      H = this.p.cy * k;
    for (const part of [this.s, this.s.layout, this.s.master]) {
      const bg = desc(part?.doc, 'bg');
      if (!bg) continue;
      const bgPr = kid(bg, 'bgPr');
      let style;
      if (bgPr) style = await this.fill(bgPr, 0, 0, W, H, ctx, null, part.rels);
      else if (kid(bg, 'bgRef')) style = this.color(kid(bg, 'bgRef'));
      if (style === undefined || style === null) continue;
      this.paint(ctx, style, () => ctx.rect(0, 0, W, H), 0, 0, W, H);
      return;
    }
  }

  paint(ctx, style, pathFn, x, y, w, hh) {
    if (style && style.img) {
      ctx.save();
      ctx.beginPath();
      pathFn();
      ctx.clip();
      this.drawImg(ctx, style.img, style.crop, x, y, w, hh);
      ctx.restore();
      return;
    }
    ctx.fillStyle = style;
    ctx.beginPath();
    pathFn();
    ctx.fill();
  }

  drawImg(ctx, img, crop, x, y, w, hh) {
    let sx = 0,
      sy = 0,
      sw = img.naturalWidth,
      sh = img.naturalHeight;
    if (crop) {
      const l = num(attr(crop, 'l')) / 100000,
        t = num(attr(crop, 't')) / 100000,
        r = num(attr(crop, 'r')) / 100000,
        b = num(attr(crop, 'b')) / 100000;
      sx = sw * l;
      sy = sh * t;
      sw = sw * (1 - l - r);
      sh = sh * (1 - t - b);
    }
    if (sw > 0 && sh > 0) ctx.drawImage(img, sx, sy, sw, sh, x, y, w, hh);
  }

  xfrmOf(el) {
    const x = kid(el, 'xfrm') || desc(kid(el, 'spPr') || kid(el, 'grpSpPr'), 'xfrm');
    if (!x) return null;
    const off = kid(x, 'off'),
      ext = kid(x, 'ext');
    if (!off || !ext) return null;
    return {
      x: num(attr(off, 'x')),
      y: num(attr(off, 'y')),
      w: num(attr(ext, 'cx')),
      h: num(attr(ext, 'cy')),
      rot: num(attr(x, 'rot')) / 60000,
      flipH: attr(x, 'flipH') === '1',
      flipV: attr(x, 'flipV') === '1',
      chOff: kid(x, 'chOff') ? { x: num(attr(kid(x, 'chOff'), 'x')), y: num(attr(kid(x, 'chOff'), 'y')) } : null,
      chExt: kid(x, 'chExt') ? { w: num(attr(kid(x, 'chExt'), 'cx')), h: num(attr(kid(x, 'chExt'), 'cy')) } : null,
    };
  }

  async tree(ctx, k, tree, rels, skipPh, map = (r) => r) {
    if (!tree) return;
    for (const el of tree.children) {
      const n = el.localName;
      try {
        if (n === 'sp' || n === 'cxnSp') {
          if (skipPh && this.phOf(el)) continue;
          await this.shape(ctx, k, el, rels, map);
        } else if (n === 'pic') {
          if (skipPh && this.phOf(el)) continue;
          await this.pic(ctx, k, el, rels, map);
        } else if (n === 'grpSp') {
          const x = this.xfrmOf(el);
          let child = map;
          if (x && x.chExt && x.chOff) {
            const sx = x.chExt.w ? x.w / x.chExt.w : 1,
              sy = x.chExt.h ? x.h / x.chExt.h : 1;
            child = (r) => map({ ...r, x: x.x + (r.x - x.chOff.x) * sx, y: x.y + (r.y - x.chOff.y) * sy, w: r.w * sx, h: r.h * sy });
          }
          await this.tree(ctx, k, el, rels, skipPh, child);
        } else if (n === 'graphicFrame') {
          await this.frame(ctx, k, el, rels, map);
        } else if (n === 'AlternateContent') {
          const fb = kid(el, 'Fallback') || kid(el, 'Choice');
          if (fb) await this.tree(ctx, k, fb, rels, skipPh, map);
        }
      } catch (e) {
        console.warn('pptx shape', e);
      }
    }
  }

  withXfrm(ctx, k, r, fn) {
    const x = r.x * k,
      y = r.y * k,
      w = r.w * k,
      hh = r.h * k;
    ctx.save();
    if (r.rot || r.flipH || r.flipV) {
      ctx.translate(x + w / 2, y + hh / 2);
      if (r.rot) ctx.rotate((r.rot * Math.PI) / 180);
      ctx.scale(r.flipH ? -1 : 1, r.flipV ? -1 : 1);
      ctx.translate(-(x + w / 2), -(y + hh / 2));
    }
    const res = fn(x, y, w, hh);
    return Promise.resolve(res).finally(() => ctx.restore());
  }

  geomPath(ctx, spPr, x, y, w, hh, k) {
    const prst = attr(kid(spPr, 'prstGeom'), 'prst');
    const cust = kid(spPr, 'custGeom');
    if (cust) {
      for (const p of kids(kid(cust, 'pathLst'), 'path')) {
        const pw = num(attr(p, 'w'), w / k) || 1,
          ph = num(attr(p, 'h'), hh / k) || 1;
        const X = (v) => x + (num(v) / pw) * w,
          Y = (v) => y + (num(v) / ph) * hh;
        for (const c of p.children) {
          const pts = kids(c, 'pt');
          if (c.localName === 'moveTo') ctx.moveTo(X(attr(pts[0], 'x')), Y(attr(pts[0], 'y')));
          else if (c.localName === 'lnTo') ctx.lineTo(X(attr(pts[0], 'x')), Y(attr(pts[0], 'y')));
          else if (c.localName === 'cubicBezTo' && pts.length === 3) ctx.bezierCurveTo(X(attr(pts[0], 'x')), Y(attr(pts[0], 'y')), X(attr(pts[1], 'x')), Y(attr(pts[1], 'y')), X(attr(pts[2], 'x')), Y(attr(pts[2], 'y')));
          else if (c.localName === 'quadBezTo' && pts.length === 2) ctx.quadraticCurveTo(X(attr(pts[0], 'x')), Y(attr(pts[0], 'y')), X(attr(pts[1], 'x')), Y(attr(pts[1], 'y')));
          else if (c.localName === 'close') ctx.closePath();
        }
      }
      return 'cust';
    }
    switch (prst) {
      case 'ellipse':
      case 'flowChartConnector':
        ctx.ellipse(x + w / 2, y + hh / 2, Math.abs(w / 2), Math.abs(hh / 2), 0, 0, Math.PI * 2);
        break;
      case 'roundRect':
      case 'flowChartAlternateProcess':
        ctx.roundRect(x, y, w, hh, Math.min(w, hh) * 0.16);
        break;
      case 'triangle':
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + hh);
        ctx.lineTo(x, y + hh);
        ctx.closePath();
        break;
      case 'rtTriangle':
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y + hh);
        ctx.lineTo(x, y + hh);
        ctx.closePath();
        break;
      case 'diamond':
      case 'flowChartDecision':
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + hh / 2);
        ctx.lineTo(x + w / 2, y + hh);
        ctx.lineTo(x, y + hh / 2);
        ctx.closePath();
        break;
      case 'line':
      case 'straightConnector1':
      case 'bentConnector3':
      case 'curvedConnector3':
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y + hh);
        return 'line';
      case 'rightArrow': {
        const t = hh * 0.25;
        const head = Math.min(w * 0.4, hh);
        ctx.moveTo(x, y + t);
        ctx.lineTo(x + w - head, y + t);
        ctx.lineTo(x + w - head, y);
        ctx.lineTo(x + w, y + hh / 2);
        ctx.lineTo(x + w - head, y + hh);
        ctx.lineTo(x + w - head, y + hh - t);
        ctx.lineTo(x, y + hh - t);
        ctx.closePath();
        break;
      }
      case 'chevron':
      case 'homePlate': {
        const d = Math.min(w * 0.4, hh / 2);
        ctx.moveTo(x, y);
        ctx.lineTo(x + w - d, y);
        ctx.lineTo(x + w, y + hh / 2);
        ctx.lineTo(x + w - d, y + hh);
        ctx.lineTo(x, y + hh);
        if (prst === 'chevron') ctx.lineTo(x + d, y + hh / 2);
        ctx.closePath();
        break;
      }
      default:
        ctx.rect(x, y, w, hh);
    }
    return prst || 'rect';
  }

  styleRef(el, name) {
    const ref = desc(kid(el, 'style'), name);
    if (!ref || attr(ref, 'idx') === '0') return null;
    return this.color(ref);
  }

  async shape(ctx, k, sp, rels, map) {
    const chain = this.chain(sp);
    let xf = null;
    for (const c of chain) if ((xf = this.xfrmOf(c))) break;
    if (!xf) return;
    const r = map(xf);
    const spPr = kid(sp, 'spPr');
    await this.withXfrm(ctx, k, r, async (x, y, w, hh) => {
      // preenchimento
      let fill = await this.fill(spPr, x, y, w, hh, ctx, null, rels);
      if (fill === undefined) fill = this.styleRef(sp, 'fillRef');
      const kind = (() => {
        ctx.beginPath();
        return this.geomPath(ctx, spPr, x, y, w, hh, k);
      })();
      if (fill && kind !== 'line') this.paint(ctx, fill, () => this.geomPath(ctx, spPr, x, y, w, hh, k), x, y, w, hh);
      // contorno
      const ln = kid(spPr, 'ln');
      let stroke = ln ? (kid(ln, 'noFill') ? null : kid(ln, 'solidFill') ? this.color(kid(ln, 'solidFill')) : undefined) : undefined;
      if (stroke === undefined) stroke = this.styleRef(sp, 'lnRef');
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(0.5, num(attr(ln, 'w'), 12700) * k);
        ctx.beginPath();
        this.geomPath(ctx, spPr, x, y, w, hh, k);
        ctx.stroke();
      }
      // texto
      const tx = kid(sp, 'txBody');
      if (tx) {
        const fontRefColor = this.color(desc(kid(sp, 'style'), 'fontRef'));
        this.text(ctx, k, tx, chain, this.phOf(sp), { x, y, w, h: hh }, fontRefColor, r.rot);
      }
    });
  }

  async pic(ctx, k, pic, rels, map) {
    const chain = this.chain(pic);
    let xf = null;
    for (const c of chain) if ((xf = this.xfrmOf(c))) break;
    if (!xf) return;
    const bf = kid(pic, 'blipFill');
    const img = await this.blip(bf, rels);
    if (!img) return;
    await this.withXfrm(ctx, k, map(xf), (x, y, w, hh) => {
      const spPr = kid(pic, 'spPr');
      const g = attr(kid(spPr, 'prstGeom'), 'prst');
      if (g && g !== 'rect') {
        ctx.beginPath();
        this.geomPath(ctx, spPr, x, y, w, hh, k);
        ctx.clip();
      }
      this.drawImg(ctx, img, kid(bf, 'srcRect'), x, y, w, hh);
    });
  }

  async frame(ctx, k, gf, rels, map) {
    const xf = this.xfrmOf(gf);
    if (!xf) return;
    const tbl = desc(gf, 'tbl');
    const r = map(xf);
    if (!tbl) {
      // gráfico / SmartArt: indica a área
      const x = r.x * k,
        y = r.y * k,
        w = r.w * k,
        hh = r.h * k;
      ctx.save();
      ctx.strokeStyle = 'rgba(120,120,140,.5)';
      ctx.setLineDash([6, 5]);
      ctx.strokeRect(x, y, w, hh);
      ctx.fillStyle = 'rgba(120,120,140,.8)';
      ctx.font = `${Math.max(10, 14 * k * EMU_PT)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const isChart = desc(gf, 'chart');
      ctx.fillText(isChart ? 'Gráfico' : 'Elemento gráfico', x + w / 2, y + hh / 2);
      ctx.restore();
      return;
    }
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => num(attr(c, 'w')));
    let cy = r.y;
    for (const [ri, tr] of kids(tbl, 'tr').entries()) {
      const rh = num(attr(tr, 'h'), 370840);
      let cx = r.x;
      for (const [ci, tc] of kids(tr, 'tc').entries()) {
        const span = num(attr(tc, 'gridSpan'), 1);
        const cw = cols.slice(ci, ci + span).reduce((a, b) => a + b, 0) || cols[ci] || 914400;
        if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') {
          cx += cols[ci] || 0;
          continue;
        }
        const x = cx * k,
          y = cy * k,
          w = cw * k,
          hh = rh * k;
        const tcPr = kid(tc, 'tcPr');
        let fill = await this.fill(tcPr, x, y, w, hh, ctx, null, rels);
        if (fill === undefined) fill = ri === 0 ? this.color({ localName: 'schemeClr', getAttribute: () => 'accent1', children: [] }) : ri % 2 ? 'rgba(207,213,234,1)' : 'rgba(233,235,245,1)';
        if (fill) {
          ctx.fillStyle = fill.img ? '#fff' : fill;
          ctx.fillRect(x, y, w, hh);
        }
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1, 12700 * k);
        ctx.strokeRect(x, y, w, hh);
        const tx = kid(tc, 'txBody');
        if (tx) this.text(ctx, k, tx, [], null, { x, y, w, h: hh }, ri === 0 ? '#fff' : null, 0, { lIns: 91440, rIns: 91440, tIns: 45720, bIns: 45720, defSz: 1400 });
        cx += cw;
      }
      cy += rh;
    }
  }

  fontFace(f) {
    if (!f || f === '+mn-lt') return this.theme.minor;
    if (f === '+mj-lt') return this.theme.major;
    return f;
  }

  text(ctx, k, tx, chain, ph, box, fontRefColor, rot, opts = {}) {
    const bodyPrs = [kid(tx, 'bodyPr'), ...chain.slice(1).map((c) => desc(c, 'bodyPr'))].filter(Boolean);
    const bp = (name, d) => {
      for (const b of bodyPrs) if (attr(b, name) != null) return attr(b, name);
      return d;
    };
    const lIns = num(bp('lIns', opts.lIns ?? 91440)) * k,
      rIns = num(bp('rIns', opts.rIns ?? 91440)) * k;
    const tIns = num(bp('tIns', opts.tIns ?? 45720)) * k,
      bIns = num(bp('bIns', opts.bIns ?? 45720)) * k;
    const anchor = bp('anchor', ph && (ph.type === 'title' || ph.type === 'ctrTitle') ? 'ctr' : 't');
    const wrap = bp('wrap', 'square') !== 'none';
    const vert = bp('vert', 'horz');
    const autofit = desc(kid(tx, 'bodyPr'), 'normAutofit');
    const fontScale = autofit ? num(attr(autofit, 'fontScale'), 100000) / 100000 : 1;
    const lnRed = autofit ? num(attr(autofit, 'lnSpcReduction'), 0) / 100000 : 0;
    const maxW = Math.max(4, box.w - lIns - rIns);
    const isTitle = ph && (ph.type === 'title' || ph.type === 'ctrTitle');
    const defSz = opts.defSz ?? (isTitle ? 4400 : ph ? 2800 : 1800);
    const ptPx = EMU_PT * k;

    const lines = [];
    let autoNum = 0;
    for (const p of kids(tx, 'p')) {
      const pPr = kid(p, 'pPr');
      const lvl = num(attr(pPr, 'lvl'), 0);
      const st = this.levelStyle(chain, ph, lvl);
      const algn = attr(pPr, 'algn') || st.algn || 'l';
      const marL = num(attr(pPr, 'marL'), st.marL ?? 0) * k;
      const indent = num(attr(pPr, 'indent'), st.indent ?? 0) * k;
      let bu = st.bu;
      if (kid(pPr, 'buNone')) bu = false;
      else if (kid(pPr, 'buChar')) bu = attr(kid(pPr, 'buChar'), 'char');
      else if (kid(pPr, 'buAutoNum')) bu = '#';
      const lnPct = desc(kid(pPr, 'lnSpc'), 'spcPct') ? num(attr(desc(kid(pPr, 'lnSpc'), 'spcPct'), 'val')) / 100000 : st.lnSpc || 1;
      const spcBef = (desc(kid(pPr, 'spcBef'), 'spcPts') ? num(attr(desc(kid(pPr, 'spcBef'), 'spcPts'), 'val')) : st.spcBef ?? 0) / 100;
      const spcAft = desc(kid(pPr, 'spcAft'), 'spcPts') ? num(attr(desc(kid(pPr, 'spcAft'), 'spcPts'), 'val')) / 100 : 0;
      const endSz = num(attr(kid(p, 'endParaRPr'), 'sz'), st.sz ?? defSz);
      // runs → tokens
      const tokens = [];
      for (const r of p.children) {
        if (r.localName !== 'r' && r.localName !== 'fld' && r.localName !== 'br') continue;
        if (r.localName === 'br') {
          tokens.push({ br: true });
          continue;
        }
        const rPr = kid(r, 'rPr');
        const sz = num(attr(rPr, 'sz'), st.sz ?? defSz) * fontScale;
        const b = attr(rPr, 'b') != null ? attr(rPr, 'b') === '1' : st.b || (isTitle && false);
        const i = attr(rPr, 'i') != null ? attr(rPr, 'i') === '1' : st.i;
        const u = attr(rPr, 'u') && attr(rPr, 'u') !== 'none';
        const strike = attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike';
        const color = (kid(rPr, 'solidFill') && this.color(kid(rPr, 'solidFill'))) || (ph ? st.color || fontRefColor : fontRefColor || st.color) || this.color({ localName: 'schemeClr', getAttribute: () => 'tx1', children: [] });
        const hl = kid(rPr, 'highlight') ? this.color(kid(rPr, 'highlight')) : null;
        const face = this.fontFace(attr(kid(rPr, 'latin'), 'typeface') || st.font || (isTitle ? '+mj-lt' : '+mn-lt'));
        const caps = attr(rPr, 'cap') === 'all';
        let t = kid(r, 't')?.textContent ?? '';
        if (caps) t = t.toUpperCase();
        const px = (sz / 100) * ptPx;
        const font = `${i ? 'italic ' : ''}${b ? '700' : '400'} ${px}px "${face}", Calibri, Carlito, Arial, sans-serif`;
        for (const part of t.split(/(\s+)/)) if (part) tokens.push({ t: part, font, px, color, u, strike, hl, space: /^\s+$/.test(part) });
      }
      const sizePx = (endSz / 100) * fontScale * ptPx;
      let buText = null;
      if (bu && tokens.some((t) => t.t?.trim())) {
        autoNum++;
        buText = bu === '#' ? `${autoNum}.` : bu;
      } else if (!bu) autoNum = 0;
      // quebra de linha
      const paraStart = lines.length;
      const first = tokens.find((t) => t.t);
      const pxLine = Math.max(sizePx, ...tokens.filter((t) => t.px).map((t) => t.px));
      const startX = marL + (buText ? 0 : indent);
      let cur = { items: [], w: 0, h: pxLine, algn, x0: startX, bu: buText, buFont: first?.font, buColor: first?.color, buX: marL + indent };
      const avail = (l) => maxW - l.x0;
      const push = () => {
        lines.push(cur);
        cur = { items: [], w: 0, h: pxLine, algn, x0: marL, bu: null };
      };
      for (const tk of tokens) {
        if (tk.br) {
          push();
          continue;
        }
        ctx.font = tk.font;
        const w = ctx.measureText(tk.t).width;
        if (wrap && cur.items.length && !tk.space && cur.w + w > avail(cur)) {
          // remove espaço final
          while (cur.items.length && cur.items[cur.items.length - 1].space) cur.w -= cur.items.pop().w;
          push();
        }
        if (tk.space && !cur.items.length && lines.length && lines[lines.length - 1].items.length) continue;
        cur.items.push({ ...tk, w });
        cur.w += w;
      }
      lines.push(cur);
      for (let li = paraStart; li < lines.length; li++) {
        const l = lines[li];
        l.para = true;
        l.lnPct = lnPct * (1 - lnRed);
        l.before = li === paraStart ? spcBef * ptPx : 0;
        l.after = li === lines.length - 1 ? spcAft * ptPx : 0;
      }
    }
    if (vert !== 'horz' && vert != null) {
      // texto vertical: rotaciona a caixa
      ctx.save();
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
      ctx.rotate(vert === 'vert270' ? -Math.PI / 2 : Math.PI / 2);
      ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
    }
    const lineH = (l) => l.h * 1.2 * (l.lnPct || 1);
    const total = lines.reduce((a, l, i) => a + lineH(l) + (i ? l.before : 0) + l.after, 0);
    const innerH = box.h - tIns - bIns;
    let y = box.y + tIns + (anchor === 'ctr' ? (innerH - total) / 2 : anchor === 'b' ? innerH - total : 0);
    for (const [i, l] of lines.entries()) {
      if (i) y += l.before;
      const lh = lineH(l);
      const baseline = y + lh * 0.8;
      const avail = maxW - l.x0;
      let x = box.x + lIns + l.x0;
      if (l.algn === 'ctr') x += (avail - l.w) / 2;
      else if (l.algn === 'r') x += avail - l.w;
      const justify = l.algn === 'just' && i < lines.length - 1 && lines[i + 1].bu == null && lines[i + 1].para;
      const gaps = l.items.filter((t) => t.space).length;
      const extra = justify && gaps ? (avail - l.w) / gaps : 0;
      if (l.bu) {
        ctx.font = l.buFont || `${l.h}px sans-serif`;
        ctx.fillStyle = l.buColor || '#000';
        ctx.textBaseline = 'alphabetic';
        const bx = box.x + lIns + l.buX;
        ctx.fillText(l.bu, bx, baseline);
      }
      for (const it of l.items) {
        ctx.font = it.font;
        if (it.hl) {
          ctx.fillStyle = it.hl;
          ctx.fillRect(x, baseline - it.px * 0.85, it.w, it.px * 1.1);
        }
        ctx.fillStyle = it.color;
        ctx.textBaseline = 'alphabetic';
        if (!it.space) ctx.fillText(it.t, x, baseline);
        if (it.u || it.strike) {
          ctx.fillRect(x, it.u ? baseline + it.px * 0.1 : baseline - it.px * 0.3, it.w + (it.space ? extra : 0), Math.max(1, it.px / 16));
        }
        x += it.w + (it.space ? extra : 0);
      }
      y += lh + l.after;
    }
    if (vert !== 'horz' && vert != null) ctx.restore();
    void rot;
  }
}

// ---------------------------------------------------------------- visualizador
export default class PptxViewer {
  annotatable = true;
  minZoom = 0.3;
  maxZoom = 4;

  constructor(ctx) {
    this.ctx = ctx;
    this.zoom = ctx.state.zoom || 1;
    this.rendered = new Map();
  }

  async mount() {
    const { ctx } = this;
    const zip = await JSZip.loadAsync(await ctx.blob.arrayBuffer());
    if (!zip.file('ppt/presentation.xml')) throw new Error('Este arquivo não parece ser uma apresentação .pptx válida.');
    this.pptx = new Pptx(zip);
    await this.pptx.load();
    if (!this.pptx.slides.length) throw new Error('A apresentação não tem slides.');
    this.ratio = this.pptx.cy / this.pptx.cx;
    this.wrap = h('<div class="slides"></div>');
    ctx.content.appendChild(this.wrap);
    this.blocks = this.pptx.slides.map((s, i) => {
      const b = h(`<div class="slide-block"><div class="page-host slide-host" data-i="${i}"><canvas class="slide-canvas"></canvas><span class="page-num">${i + 1}</span></div>${s.notes ? `<div class="slide-notes"><b>Notas</b>${esc(s.notes)}</div>` : ''}</div>`);
      this.wrap.appendChild(b);
      return b;
    });
    this.hosts = this.blocks.map((b) => b.querySelector('.slide-host'));
    this.layout();
    this.io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && this.renderSlide(+e.target.dataset.i)), { root: ctx.stage, rootMargin: '800px 0px' });
    this.hosts.forEach((hh) => this.io.observe(hh));
    this.hosts.forEach((hh, i) => ctx.ann.attach(hh, `sl${i + 1}`));
    this.buildSlot();
    if (!ctx.rec.thumb) this.makeThumb();
  }

  get width() {
    return Math.min(1100, this.ctx.stage.clientWidth - (innerWidth < 720 ? 16 : 64)) * this.zoom;
  }

  layout() {
    const W = Math.round(this.width);
    const H = Math.round(W * this.ratio);
    this.blocks.forEach((b) => (b.style.width = `${W}px`));
    this.hosts.forEach((hh) => {
      hh.style.width = `${W}px`;
      hh.style.height = `${H}px`;
    });
    this.W = W;
  }

  async drawTo(i, ctx2d, pxW) {
    const r = new SlideRenderer(this.pptx, this.pptx.slides[i]);
    await r.render(ctx2d, pxW / this.pptx.cx);
  }

  async renderSlide(i) {
    const W = this.W;
    if (this.rendered.get(i) === W) return;
    this.rendered.set(i, W);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.className = 'slide-canvas';
    c.width = Math.round(W * dpr);
    c.height = Math.round(W * this.ratio * dpr);
    await this.drawTo(i, c.getContext('2d'), c.width);
    if (this.rendered.get(i) !== W) return;
    const old = this.hosts[i].querySelector('.slide-canvas');
    old.replaceWith(c);
  }

  setZoom(z) {
    this.zoom = z;
    this.ctx.state.zoom = z;
    this.ctx.saveState();
    this.layout();
    this.rerender();
  }
  onResize() {
    this.layout();
    this.rerender();
  }
  rerender() {
    clearTimeout(this.rt);
    this.rt = setTimeout(() => {
      const st = this.ctx.stage.getBoundingClientRect();
      this.hosts.forEach((hh, i) => {
        const r = hh.getBoundingClientRect();
        if (r.bottom > st.top - 800 && r.top < st.bottom + 800) this.renderSlide(i);
        else this.rendered.delete(i);
      });
    }, 100);
  }

  buildSlot() {
    const s = h(`<div class="play-ctrl"><button class="btn btn-soft btn-sm" data-a="present">${icon('play', 17)}<span class="hide-sm">Apresentar</span></button></div>`);
    s.querySelector('button').onclick = () => this.present();
    this.ctx.slot.appendChild(s);
  }

  currentIndex() {
    const st = this.ctx.stage;
    const mid = st.scrollTop + st.clientHeight * 0.4;
    let cur = 0;
    this.blocks.forEach((b, i) => {
      if (b.offsetTop <= mid) cur = i;
    });
    return cur;
  }

  async present() {
    let i = this.currentIndex();
    const el = h('<div class="present" tabindex="0"><canvas></canvas><div class="present-hint">← → para navegar · Esc para sair</div></div>');
    document.body.appendChild(el);
    const c = el.querySelector('canvas');
    const draw = async () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const W = Math.min(innerWidth, innerHeight / this.ratio);
      c.style.width = `${W}px`;
      c.style.height = `${W * this.ratio}px`;
      c.width = W * dpr;
      c.height = W * this.ratio * dpr;
      const x = c.getContext('2d');
      await this.drawTo(i, x, c.width);
      const shapes = this.ctx.ann.pages[`sl${i + 1}`];
      if (shapes?.length) {
        const { hl, ink } = renderShapesToCanvases(shapes, c.width, c.height);
        x.globalCompositeOperation = 'multiply';
        x.drawImage(hl, 0, 0);
        x.globalCompositeOperation = 'source-over';
        x.drawImage(ink, 0, 0);
      }
    };
    const n = this.pptx.slides.length;
    const go = (d) => {
      const ni = Math.max(0, Math.min(n - 1, i + d));
      if (ni !== i) {
        i = ni;
        draw();
      }
    };
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', draw);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      el.remove();
      this.blocks[i].scrollIntoView({ block: 'start' });
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) go(1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(-1);
      else if (e.key === 'Escape') close();
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', draw);
    el.addEventListener('click', (e) => (e.clientX < innerWidth / 3 ? go(-1) : go(1)));
    let sx = null;
    el.addEventListener('touchstart', (e) => (sx = e.touches[0].clientX), { passive: true });
    el.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      sx = null;
    });
    document.addEventListener('fullscreenchange', function fc() {
      if (!document.fullscreenElement && el.isConnected) {
        document.removeEventListener('fullscreenchange', fc);
        close();
      }
    });
    el.requestFullscreen?.().catch(() => {});
    el.focus();
    await draw();
  }

  async makeThumb() {
    try {
      const c = document.createElement('canvas');
      c.width = 360;
      c.height = Math.round(360 * this.ratio);
      await this.drawTo(0, c.getContext('2d'), 360);
      this.ctx.setThumb(c.toDataURL('image/jpeg', 0.8));
    } catch {}
  }

  exports() {
    const name = baseName(this.ctx.rec.name);
    const W = this.pptx.cx / EMU_PT,
      H = this.pptx.cy / EMU_PT;
    return [
      {
        label: 'PDF com anotações',
        icon: 'file-down',
        hint: '.pdf',
        run: async () => {
          const pages = this.pptx.slides.map((_, i) => ({
            width: W,
            height: H,
            draw: async (x, pw, ph) => {
              await this.drawTo(i, x, pw);
              compositeAnnotations(x, this.ctx.ann.pages[`sl${i + 1}`], pw, ph);
            },
          }));
          download(await pagesToPdf(pages, 2), `${name}.pdf`);
        },
      },
      {
        label: 'Notas do apresentador',
        icon: 'sticky',
        hint: '.txt',
        run: () => {
          const txt = this.pptx.slides.map((s, i) => `Slide ${i + 1}\n${s.notes || '(sem notas)'}\n`).join('\n');
          download(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${name} - notas.txt`);
        },
      },
      { label: 'Apresentação original', icon: 'download', hint: '.pptx', run: () => download(this.ctx.blob, this.ctx.rec.name) },
    ];
  }

  destroy() {
    this.io?.disconnect();
    clearTimeout(this.rt);
  }
}
