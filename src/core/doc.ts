import { ADJUST_DEFAULTS, LOOK_DEFAULT, type Adjust, type Look } from './adjust';
import {
  chain,
  deg,
  fitCrop,
  flipHMat,
  flipVMat,
  IDENTITY,
  largestCrop,
  mul,
  rotate,
  rotCCWMat,
  rotCWMat,
  scale,
  translate,
  type Crop,
  type Mat,
  type Pt,
  apply,
} from './geometry';
import type { Mask } from './mask';
import { uid, type SourceImage } from './source';

/**
 * Coordinate spaces
 * - source: pixels of a layer's decoded image (full resolution units)
 * - world: the base image after its quarter-turn/flip orientation, in base full-resolution pixels.
 *          Overlay layers are positioned in world space, so they stay attached to the photo.
 * - output: the crop box, w×h, with the straighten angle applied around the crop centre.
 */

export const BLEND_MODES: { id: GlobalCompositeOperation; name: string }[] = [
  { id: 'source-over', name: 'Normal' },
  { id: 'multiply', name: 'Multiply' },
  { id: 'screen', name: 'Screen' },
  { id: 'overlay', name: 'Overlay' },
  { id: 'soft-light', name: 'Soft light' },
  { id: 'hard-light', name: 'Hard light' },
  { id: 'darken', name: 'Darken' },
  { id: 'lighten', name: 'Lighten' },
  { id: 'color-dodge', name: 'Dodge' },
  { id: 'color-burn', name: 'Burn' },
  { id: 'difference', name: 'Difference' },
  { id: 'exclusion', name: 'Exclusion' },
  { id: 'hue', name: 'Hue' },
  { id: 'saturation', name: 'Saturation' },
  { id: 'color', name: 'Color' },
  { id: 'luminosity', name: 'Luminosity' },
];

/** Placement of an overlay in world space: centre, uniform scale (world px per source px), rotation, mirroring. */
export interface Placement {
  x: number;
  y: number;
  scale: number;
  rotation: number; // radians
  flipX: boolean;
  flipY: boolean;
}

interface LayerCommon {
  id: string;
  name: string;
  opacity: number; // 0..1
  blend: GlobalCompositeOperation;
  hidden: boolean;
  t: Placement;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageLayer extends LayerCommon {
  kind: 'image';
  src: SourceImage;
  adjust: Adjust;
  look: Look;
  /** in full source pixels; masks stay in full source pixels and are cropped along with the image */
  mask: Mask | null;
  /** visible part of the source, in source pixels; null = whole image */
  crop: Rect | null;
}

export const FONTS: { id: string; name: string; css: string }[] = [
  { id: 'sf', name: 'System', css: '-apple-system, "SF Pro Display", system-ui, sans-serif' },
  { id: 'rounded', name: 'Rounded', css: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif' },
  { id: 'serif', name: 'Serif', css: 'ui-serif, "New York", Georgia, serif' },
  { id: 'mono', name: 'Mono', css: 'ui-monospace, "SF Mono", Menlo, monospace' },
  { id: 'didot', name: 'Didot', css: 'Didot, "Bodoni 72", serif' },
  { id: 'futura', name: 'Futura', css: 'Futura, "Avenir Next", sans-serif' },
  { id: 'avenir', name: 'Avenir', css: '"Avenir Next", Avenir, sans-serif' },
  { id: 'typewriter', name: 'Typewriter', css: '"American Typewriter", "Courier New", monospace' },
  { id: 'marker', name: 'Marker', css: '"Marker Felt", "Chalkboard SE", fantasy' },
  { id: 'script', name: 'Script', css: '"Snell Roundhand", "Apple Chancery", cursive' },
  { id: 'hand', name: 'Hand', css: '"Bradley Hand", "Noteworthy", cursive' },
];

export interface TextLayer extends LayerCommon {
  kind: 'text';
  text: string;
  font: string;
  bold: boolean;
  color: string;
  /** background box colour, or null */
  bg: string | null;
  align: CanvasTextAlign;
  /** font size in world px at t.scale = 1 */
  size: number;
  shadow: boolean;
}

export type Layer = ImageLayer | TextLayer;

export interface BaseLayer {
  src: SourceImage;
  adjust: Adjust;
  look: Look;
  mask: Mask | null;
}

export interface Geometry {
  /** source px -> world px for the base image */
  orient: Mat;
  worldW: number;
  worldH: number;
  /** straighten angle in degrees, -45..45 */
  angle: number;
  crop: Crop;
}

export interface Doc {
  base: BaseLayer;
  layers: Layer[];
  geo: Geometry;
  vignette: number; // 0..100
  /** fill behind transparent areas; null keeps transparency (PNG) */
  background: string | null;
}

export function newDoc(src: SourceImage): Doc {
  const W = src.width;
  const H = src.height;
  return {
    base: { src, adjust: { ...ADJUST_DEFAULTS }, look: { ...LOOK_DEFAULT }, mask: null },
    layers: [],
    geo: { orient: IDENTITY, worldW: W, worldH: H, angle: 0, crop: { cx: W / 2, cy: H / 2, w: W, h: H } },
    vignette: 0,
    background: null,
  };
}

export function outputSize(doc: Doc): { w: number; h: number } {
  return { w: Math.max(1, Math.round(doc.geo.crop.w)), h: Math.max(1, Math.round(doc.geo.crop.h)) };
}

/** world -> output (crop box), at output scale 1. */
export function worldToOutput(geo: Geometry): Mat {
  const c = geo.crop;
  return chain(translate(c.w / 2, c.h / 2), rotate(deg(geo.angle)), translate(-c.cx, -c.cy));
}

/** layer source px -> world px. */
export function placementMat(t: Placement, srcW: number, srcH: number): Mat {
  return chain(
    translate(t.x, t.y),
    rotate(t.rotation),
    scale(t.scale * (t.flipX ? -1 : 1), t.scale * (t.flipY ? -1 : 1)),
    translate(-srcW / 2, -srcH / 2),
  );
}

export function layerRect(l: ImageLayer): Rect {
  return l.crop ?? { x: 0, y: 0, w: l.src.width, h: l.src.height };
}

/** source px -> world px for an image layer, including its crop. Use this wherever layer pixels are mapped. */
export function imageLayerMat(l: ImageLayer): Mat {
  const r = layerRect(l);
  return chain(placementMat(l.t, r.w, r.h), translate(-r.x, -r.y));
}

/** Natural (t.scale = 1) size in world px of a layer's content box. */
export function layerSize(l: Layer, measure: (l: TextLayer) => { w: number; h: number }): { w: number; h: number } {
  if (l.kind === 'image') {
    const r = layerRect(l);
    return { w: r.w, h: r.h };
  }
  return measure(l);
}

/** Changes a photo layer's crop while keeping the visible pixels where they are in the picture. */
export function setLayerCrop(doc: Doc, id: string, crop: Rect | null): Doc {
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.id !== id || l.kind !== 'image') return l;
      const full = { x: 0, y: 0, w: l.src.width, h: l.src.height };
      const r = crop ?? full;
      const isFull = r.x <= 0 && r.y <= 0 && r.w >= full.w && r.h >= full.h;
      const c = apply(imageLayerMat(l), { x: r.x + r.w / 2, y: r.y + r.h / 2 });
      return { ...l, crop: isFull ? null : r, t: { ...l.t, x: c.x, y: c.y } };
    }),
  };
}

export function layerCorners(l: Layer, size: { w: number; h: number }): Pt[] {
  const m = placementMat(l.t, size.w, size.h);
  return [
    { x: 0, y: 0 },
    { x: size.w, y: 0 },
    { x: size.w, y: size.h },
    { x: 0, y: size.h },
  ].map((p) => apply(m, p));
}

// ---------- geometry operations (pure) ----------

function remapAll(doc: Doc, op: { m: Mat; w: number; h: number }, mirror: boolean, angleSign: 1 | -1, rotBy: number): Doc {
  const g = doc.geo;
  const c = apply(op.m, { x: g.crop.cx, y: g.crop.cy });
  const quarter = Math.abs(op.m[1]) > 0.5;
  const crop: Crop = { cx: c.x, cy: c.y, w: quarter ? g.crop.h : g.crop.w, h: quarter ? g.crop.w : g.crop.h };
  const layers = doc.layers.map((l) => {
    const p = apply(op.m, { x: l.t.x, y: l.t.y });
    let rotation = l.t.rotation + rotBy;
    let flipX = l.t.flipX;
    if (mirror) {
      // diag(-1,1)·R(r) = R(-r)·diag(-1,1) and diag(1,-1)·R(r) = R(π-r)·diag(-1,1)
      rotation = (op.m[0] < 0 ? 0 : Math.PI) - rotation;
      flipX = !flipX;
    }
    return { ...l, t: { ...l.t, x: p.x, y: p.y, rotation, flipX } };
  });
  return {
    ...doc,
    layers,
    geo: { orient: mul(op.m, g.orient), worldW: op.w, worldH: op.h, angle: g.angle * angleSign, crop },
  };
}

export function rotateCW(doc: Doc): Doc {
  return remapAll(doc, rotCWMat(doc.geo.worldW, doc.geo.worldH), false, 1, Math.PI / 2);
}

export function rotateCCW(doc: Doc): Doc {
  return remapAll(doc, rotCCWMat(doc.geo.worldW, doc.geo.worldH), false, 1, -Math.PI / 2);
}

export function flipH(doc: Doc): Doc {
  return remapAll(doc, flipHMat(doc.geo.worldW, doc.geo.worldH), true, -1, 0);
}

export function flipV(doc: Doc): Doc {
  return remapAll(doc, flipVMat(doc.geo.worldW, doc.geo.worldH), true, -1, 0);
}

export function setAngle(doc: Doc, angle: number): Doc {
  const g = doc.geo;
  const crop = fitCrop(g.crop, deg(angle), g.worldW, g.worldH);
  return { ...doc, geo: { ...g, angle, crop } };
}

/** Sets an aspect ratio (w/h). null = free (keeps the current box). */
export function setAspect(doc: Doc, aspect: number | null): Doc {
  if (aspect === null) return doc;
  const g = doc.geo;
  const crop = largestCrop(aspect, deg(g.angle), g.worldW, g.worldH, g.crop.cx, g.crop.cy);
  // fall back to the image centre if the current centre leaves too little room
  const centred = largestCrop(aspect, deg(g.angle), g.worldW, g.worldH);
  return { ...doc, geo: { ...g, crop: crop.w * crop.h > centred.w * centred.h * 0.85 ? crop : centred } };
}

export function resetGeometry(doc: Doc): Doc {
  const g = doc.geo;
  return { ...doc, geo: { ...g, angle: 0, crop: { cx: g.worldW / 2, cy: g.worldH / 2, w: g.worldW, h: g.worldH } } };
}

export function newImageLayer(doc: Doc, src: SourceImage): ImageLayer {
  const c = doc.geo.crop;
  const fit = Math.min((c.w * 0.6) / src.width, (c.h * 0.6) / src.height);
  return {
    id: uid('layer'),
    kind: 'image',
    name: src.name || 'Photo',
    src,
    opacity: 1,
    blend: 'source-over',
    hidden: false,
    t: { x: c.cx, y: c.cy, scale: fit, rotation: -deg(doc.geo.angle), flipX: false, flipY: false },
    adjust: { ...ADJUST_DEFAULTS },
    look: { ...LOOK_DEFAULT },
    mask: null,
    crop: null,
  };
}

export function newTextLayer(doc: Doc, text = 'Text'): TextLayer {
  const c = doc.geo.crop;
  return {
    id: uid('layer'),
    kind: 'text',
    name: 'Text',
    text,
    font: 'sf',
    bold: true,
    color: '#ffffff',
    bg: null,
    align: 'center',
    size: Math.max(16, Math.min(c.w, c.h) * 0.09),
    shadow: true,
    opacity: 1,
    blend: 'source-over',
    hidden: false,
    t: { x: c.cx, y: c.cy, scale: 1, rotation: -deg(doc.geo.angle), flipX: false, flipY: false },
  };
}

export function updateLayer(doc: Doc, id: string, patch: Partial<ImageLayer> | Partial<TextLayer>): Doc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) };
}

export function moveLayer(doc: Doc, id: string, dir: 1 | -1): Doc {
  const i = doc.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= doc.layers.length) return doc;
  const layers = doc.layers.slice();
  [layers[i], layers[j]] = [layers[j], layers[i]];
  return { ...doc, layers };
}

export function removeLayer(doc: Doc, id: string): Doc {
  return { ...doc, layers: doc.layers.filter((l) => l.id !== id) };
}

/** Every mask referenced by a document (used by history snapshots). */
export function docMasks(doc: Doc): Mask[] {
  const out: Mask[] = [];
  if (doc.base.mask) out.push(doc.base.mask);
  for (const l of doc.layers) if (l.kind === 'image' && l.mask) out.push(l.mask);
  return out;
}
