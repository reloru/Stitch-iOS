import { isIdentity, type Adjust, type Look } from './adjust';
import { createCanvas, ctx2d, releaseCanvas } from './canvas';
import { layerRect, outputSize, placementMat, worldToOutput, type Doc, type Layer, type TextLayer } from './doc';
import { chain, IDENTITY, scale, type Mat } from './geometry';
import { renderAdjusted } from './gl';
import type { Mask } from './mask';
import type { SourceImage } from './source';
import { measureText, rasterText } from './text';

interface CacheEntry {
  key: string;
  canvas: HTMLCanvasElement;
}

/** Preview-only cache of per-layer rasters (adjusted, masked, text). */
export class RasterCache {
  private map = new Map<string, CacheEntry>();

  get(slot: string, key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
    const e = this.map.get(slot);
    if (e && e.key === key) return e.canvas;
    if (e) releaseCanvas(e.canvas);
    const canvas = make();
    this.map.set(slot, { key, canvas });
    return canvas;
  }

  /** Drop entries whose slot is not in `keep`. */
  prune(keep: Set<string>) {
    for (const [slot, e] of this.map) {
      if (!keep.has(slot.split('|')[0])) {
        releaseCanvas(e.canvas);
        this.map.delete(slot);
      }
    }
  }

  clear() {
    for (const e of this.map.values()) releaseCanvas(e.canvas);
    this.map.clear();
  }
}

export interface RenderOpts {
  /** output px per world px */
  scale: number;
  mode: 'preview' | 'export';
  /** render the whole world (uncropped, unrotated) instead of the crop box */
  world?: boolean;
  cache?: RasterCache;
  /** export: decoded full-resolution pixels per source */
  full?: Map<SourceImage, HTMLCanvasElement>;
  /** hide one layer (used while it is being edited elsewhere) */
  hideLayer?: string;
  /** paint the background even if it is null (JPEG export) */
  forceBackground?: string;
}

function pixelsOf(src: SourceImage, o: RenderOpts): HTMLCanvasElement {
  if (o.mode === 'export') {
    const c = o.full?.get(src);
    if (c) return c;
  }
  return src.proxy;
}

function maskKey(m: Mask | null) {
  return m ? `${m.id}:${m.version}` : '-';
}

/** Adjusted + masked pixels of an image layer, in its source pixel grid scaled by k (= raster px per source px). */
export function imageRaster(
  slot: string,
  src: SourceImage,
  adjust: Adjust,
  look: Look,
  mask: Mask | null,
  o: RenderOpts,
): { canvas: HTMLCanvasElement; k: number; temp: HTMLCanvasElement[] } {
  const px = pixelsOf(src, o);
  const k = px.width / src.width;
  const temp: HTMLCanvasElement[] = [];
  const ident = isIdentity(adjust, look);
  const adjKey = `${src.id}|${JSON.stringify(adjust)}|${look.filter}:${look.strength}|${px.width}`;

  const makeAdjusted = () => renderAdjusted(px, adjust, look, k);
  let adjusted: HTMLCanvasElement;
  if (ident) adjusted = px;
  else if (o.cache) adjusted = o.cache.get(slot + '|adj', adjKey, makeAdjusted);
  else temp.push((adjusted = makeAdjusted()));

  if (!mask) return { canvas: adjusted, k, temp };

  const makeMasked = () => {
    const c = createCanvas(adjusted.width, adjusted.height);
    const ctx = ctx2d(c);
    ctx.drawImage(adjusted, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask.canvas, 0, 0, c.width, c.height);
    return c;
  };
  let masked: HTMLCanvasElement;
  if (o.cache) masked = o.cache.get(slot + '|mask', adjKey + '|' + maskKey(mask), makeMasked);
  else temp.push((masked = makeMasked()));
  return { canvas: masked, k, temp };
}

export function textRaster(l: TextLayer, pxPerUnit: number, o: RenderOpts): { canvas: HTMLCanvasElement; temp: HTMLCanvasElement[] } {
  // bucket the resolution so pinching does not re-rasterise on every frame
  const bucket = Math.pow(2, Math.ceil(Math.log2(Math.max(0.05, pxPerUnit)) * 2) / 2);
  const k = Math.min(bucket, 1024 / l.size);
  const make = () => rasterText(l, k);
  if (o.cache) {
    const key = JSON.stringify([l.text, l.font, l.bold, l.color, l.bg, l.align, l.size, l.shadow, k]);
    return { canvas: o.cache.get(l.id + '|text', key, make), temp: [] };
  }
  const c = make();
  return { canvas: c, temp: [c] };
}

export function docViewMatrix(doc: Doc, o: RenderOpts): Mat {
  return chain(scale(o.scale), o.world ? IDENTITY : worldToOutput(doc.geo));
}

export function renderSize(doc: Doc, o: RenderOpts): { w: number; h: number } {
  if (o.world) return { w: Math.round(doc.geo.worldW * o.scale), h: Math.round(doc.geo.worldH * o.scale) };
  const s = outputSize(doc);
  return { w: Math.max(1, Math.round(s.w * o.scale)), h: Math.max(1, Math.round(s.h * o.scale)) };
}

function setMat(ctx: CanvasRenderingContext2D, m: Mat) {
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

export function drawLayer(ctx: CanvasRenderingContext2D, l: Layer, view: Mat, o: RenderOpts) {
  const temps: HTMLCanvasElement[] = [];
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.globalCompositeOperation = l.blend;
  if (l.kind === 'image') {
    const r = imageRaster(l.id, l.src, l.adjust, l.look, l.mask, o);
    temps.push(...r.temp);
    const c = layerRect(l);
    setMat(ctx, chain(view, placementMat(l.t, c.w, c.h), scale(1 / r.k)));
    ctx.drawImage(r.canvas, c.x * r.k, c.y * r.k, c.w * r.k, c.h * r.k, 0, 0, c.w * r.k, c.h * r.k);
  } else {
    const box = measureText(l);
    const pxPerUnit = o.scale * l.t.scale;
    const r = textRaster(l, pxPerUnit, o);
    temps.push(...r.temp);
    setMat(ctx, chain(view, placementMat(l.t, box.w, box.h)));
    ctx.drawImage(r.canvas, 0, 0, box.w, box.h);
  }
  ctx.restore();
  temps.forEach(releaseCanvas);
}

/** Renders the document into `ctx` (whose canvas must be renderSize(doc, o)). */
export function renderDoc(ctx: CanvasRenderingContext2D, doc: Doc, o: RenderOpts) {
  const { w, h } = renderSize(doc, o);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bg = doc.background ?? o.forceBackground;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }
  const view = docViewMatrix(doc, o);

  const base = doc.base;
  const r = imageRaster('base', base.src, base.adjust, base.look, base.mask, o);
  setMat(ctx, chain(view, doc.geo.orient, scale(1 / r.k)));
  ctx.drawImage(r.canvas, 0, 0);
  r.temp.forEach(releaseCanvas);

  for (const l of doc.layers) {
    if (l.hidden || l.id === o.hideLayer) continue;
    drawLayer(ctx, l, view, o);
  }

  if (doc.vignette > 0 && !o.world) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const rad = Math.hypot(w / 2, h / 2);
    const g = ctx.createRadialGradient(w / 2, h / 2, rad * 0.35, w / 2, h / 2, rad);
    const a = (doc.vignette / 100) * 0.85;
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, `rgba(0,0,0,${a * 0.35})`);
    g.addColorStop(1, `rgba(0,0,0,${a})`);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  if (o.cache) {
    const keep = new Set<string>(['base', ...doc.layers.map((l) => l.id)]);
    o.cache.prune(keep);
  }
}
