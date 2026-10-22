import { ADJUST_DEFAULTS, LOOK_DEFAULT } from '../core/adjust';
import { checkerPattern, createCanvas, ctx2d, releaseCanvas } from '../core/canvas';
import { imageLayerMat, layerSize, outputSize, placementMat, worldToOutput, type Doc, type ImageLayer, type Layer } from '../core/doc';
import {
  apply,
  chain,
  clamp,
  constrainCrop,
  deg,
  invert,
  pointInPoly,
  rotate,
  scale,
  translate,
  type Crop,
  type Mat,
  type Pt,
} from '../core/geometry';
import {
  applySelection,
  colorSelect,
  createMask,
  dab,
  linearGradient,
  radialGradient,
  readAlpha,
  softenSelection,
  strokeSegment,
  touch,
  writeAlpha,
  type Brush,
  type BrushMode,
  type Mask,
} from '../core/mask';
import { imageRaster, RasterCache, renderDoc, renderSize } from '../core/render';
import { measureText } from '../core/text';

export type Tool = 'adjust' | 'filters' | 'crop' | 'layers' | 'mask';
export type MaskTool = 'brush' | 'linear' | 'radial' | 'wand';

export interface MaskSettings {
  tool: MaskTool;
  mode: BrushMode;
  /** brush radius in CSS px on screen */
  size: number;
  hardness: number;
  flow: number;
  tolerance: number;
  contiguous: boolean;
  feather: number;
  show: boolean;
}

export const MASK_DEFAULTS: MaskSettings = {
  tool: 'brush',
  mode: 'hide',
  size: 28,
  hardness: 0.5,
  flow: 0.9,
  tolerance: 32,
  contiguous: true,
  feather: 0.5,
  show: true,
};

export interface ViewState {
  doc: Doc;
  tool: Tool;
  /** 'base' or a layer id */
  selected: string;
  mask: MaskSettings;
  /** crop aspect lock (w/h) or null */
  aspect: number | null;
  compare: boolean;
}

export interface ViewCallbacks {
  change(doc: Doc, commit: boolean): void;
  select(id: string): void;
  /** discard uncommitted changes (e.g. a stroke interrupted by a pinch) */
  revert(): void;
  editText(id: string): void;
  notify(msg: string): void;
}

type Gesture =
  | { kind: 'view-pan'; start: Pt; panX: number; panY: number }
  | { kind: 'pinch-view'; c0: Pt; d0: number; zoom: number; panX: number; panY: number }
  | { kind: 'layer-move'; id: string; startWorld: Pt; x: number; y: number }
  | { kind: 'layer-handle'; id: string; center: Pt; p0: Pt; scale: number; rotation: number }
  | { kind: 'pinch-layer'; id: string; c0: Pt; d0: number; a0: number; x: number; y: number; scale: number; rotation: number }
  | { kind: 'crop-pan'; start: Pt; crop: Crop; f: number }
  | { kind: 'crop-edge'; start: Pt; crop: Crop; anchor: Pt; f: number; l: boolean; r: boolean; t: boolean; b: boolean }
  | { kind: 'pinch-crop'; d0: number; crop: Crop }
  | { kind: 'mask-brush'; last: Pt; carry: number; startedAt: number }
  | { kind: 'mask-line'; p0: Pt; p1: Pt }
  | { kind: 'none' };

const CSS_MARGIN = 16;
const CROP_MARGIN = 34;

export class EditorView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(3, window.devicePixelRatio || 1);
  private cw = 1;
  private ch = 1;
  private state: ViewState;
  private cb: ViewCallbacks;

  private cache = new RasterCache();
  private composite: HTMLCanvasElement | null = null;
  private compositeFor: { doc: Doc | null; world: boolean; compare: boolean; ps: number; tick: number } = {
    doc: null,
    world: false,
    compare: false,
    ps: 0,
    tick: -1,
  };
  private maskTick = 0;
  private tint: { key: string; canvas: HTMLCanvasElement } | null = null;
  private checker: CanvasPattern | string | null = null;

  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** frozen crop view while dragging a crop edge */
  private cropFrozen: { anchor: Pt; f: number } | null = null;

  private pointers = new Map<number, Pt>();
  private gesture: Gesture = { kind: 'none' };
  private lastTap = { t: 0, x: 0, y: 0 };
  private downAt = { t: 0, x: 0, y: 0 };
  private cursor: Pt | null = null;
  private raf = 0;
  private ro: ResizeObserver;

  constructor(host: HTMLElement, state: ViewState, cb: ViewCallbacks) {
    this.state = state;
    this.cb = cb;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('data-testid', 'editor-canvas');
    host.appendChild(this.canvas);
    this.ctx = ctx2d(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onCancel);
    c.addEventListener('lostpointercapture', this.onUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    this.cache.clear();
    releaseCanvas(this.composite);
    if (this.tint) releaseCanvas(this.tint.canvas);
    this.canvas.remove();
  }

  update(state: ViewState) {
    const prev = this.state;
    this.state = state;
    if (prev.tool !== state.tool) {
      this.gesture = { kind: 'none' };
      this.cropFrozen = null;
      if (state.tool === 'crop') this.resetView();
    }
    this.schedule();
  }

  resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.schedule();
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.cw = Math.max(1, Math.round(r.width * this.dpr));
    this.ch = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.width = this.cw;
    this.canvas.height = this.ch;
    this.checker = null;
    this.draw();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  /** Call after mutating a mask in place. */
  maskChanged() {
    this.maskTick++;
    this.schedule();
  }

  // ---------- transforms ----------

  private get isCrop() {
    return this.state.tool === 'crop';
  }

  private fitScale(): number {
    const { w, h } = outputSize(this.state.doc);
    const m = CSS_MARGIN * this.dpr;
    return Math.max(1e-6, Math.min((this.cw - 2 * m) / w, (this.ch - 2 * m) / h));
  }

  private cropFit(crop: Crop): number {
    const m = CROP_MARGIN * this.dpr;
    return Math.max(1e-6, Math.min((this.cw - 2 * m) / crop.w, (this.ch - 2 * m) / crop.h));
  }

  /** screen <- output (normal modes) */
  private screenFromOutput(): Mat {
    const { w, h } = outputSize(this.state.doc);
    const k = this.fitScale() * this.zoom;
    return chain(translate(this.cw / 2 + this.panX, this.ch / 2 + this.panY), scale(k), translate(-w / 2, -h / 2));
  }

  private cropView(): { anchor: Pt; f: number } {
    if (this.cropFrozen) return this.cropFrozen;
    const c = this.state.doc.geo.crop;
    return { anchor: { x: c.cx, y: c.cy }, f: this.cropFit(c) };
  }

  /** screen <- world */
  screenFromWorld(): Mat {
    const g = this.state.doc.geo;
    if (this.isCrop) {
      const v = this.cropView();
      return chain(translate(this.cw / 2, this.ch / 2), scale(v.f), rotate(deg(g.angle)), translate(-v.anchor.x, -v.anchor.y));
    }
    return chain(this.screenFromOutput(), worldToOutput(g));
  }

  private layerBox(l: Layer): { w: number; h: number } {
    return layerSize(l, measureText);
  }

  private layerScreenCorners(l: Layer): Pt[] {
    const box = this.layerBox(l);
    const m = chain(this.screenFromWorld(), placementMat(l.t, box.w, box.h));
    return [
      { x: 0, y: 0 },
      { x: box.w, y: 0 },
      { x: box.w, y: box.h },
      { x: 0, y: box.h },
    ].map((p) => apply(m, p));
  }

  private toWorld(p: Pt): Pt {
    return apply(invert(this.screenFromWorld()), p);
  }

  // ---------- drawing ----------

  private previewScale(world: boolean): number {
    const d = this.state.doc;
    const span = world ? Math.max(d.geo.worldW, d.geo.worldH) : Math.max(...Object.values(outputSize(d)));
    return Math.min(1, 2048 / span);
  }

  private renderComposite() {
    const world = this.isCrop;
    const compare = this.state.compare && (this.state.tool === 'adjust' || this.state.tool === 'filters');
    const ps = this.previewScale(world);
    const f = this.compositeFor;
    if (this.composite && f.doc === this.state.doc && f.world === world && f.compare === compare && f.ps === ps && f.tick === this.maskTick)
      return;
    let doc = this.state.doc;
    if (compare) doc = { ...doc, base: { ...doc.base, adjust: ADJUST_DEFAULTS, look: LOOK_DEFAULT }, vignette: 0 };
    const opts = { scale: ps, mode: 'preview' as const, world, cache: this.cache };
    const size = renderSize(doc, opts);
    if (!this.composite) this.composite = createCanvas(size.w, size.h);
    if (this.composite.width !== size.w || this.composite.height !== size.h) {
      this.composite.width = size.w;
      this.composite.height = size.h;
    }
    renderDoc(ctx2d(this.composite), doc, opts);
    this.compositeFor = { doc: this.state.doc, world, compare, ps, tick: this.maskTick };
  }

  private setT(m: Mat) {
    this.ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#050507';
    ctx.fillRect(0, 0, this.cw, this.ch);
    try {
      this.renderComposite();
    } catch (e) {
      console.error(e);
      return;
    }
    const comp = this.composite!;
    const ps = this.compositeFor.ps;
    if (!this.checker) this.checker = checkerPattern(ctx, 8 * this.dpr);

    if (this.isCrop) {
      const g = this.state.doc.geo;
      const sw = this.screenFromWorld();
      this.setT(sw);
      ctx.fillStyle = this.checker;
      ctx.fillRect(0, 0, g.worldW, g.worldH);
      this.setT(chain(sw, scale(1 / ps)));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(comp, 0, 0);
      this.drawCropOverlay();
      return;
    }

    const so = this.screenFromOutput();
    const { w, h } = outputSize(this.state.doc);
    this.setT(so);
    ctx.fillStyle = this.checker;
    ctx.fillRect(0, 0, w, h);
    this.setT(chain(so, scale(1 / ps)));
    ctx.drawImage(comp, 0, 0);

    if (this.state.tool === 'layers') this.drawLayerOverlay();
    if (this.state.tool === 'mask') this.drawMaskOverlay();
  }

  private cropScreenRect(): { x: number; y: number; w: number; h: number } {
    const c = this.state.doc.geo.crop;
    const v = this.cropView();
    const g = this.state.doc.geo;
    // the crop centre in screen space; the box is axis-aligned on screen
    const m = chain(translate(this.cw / 2, this.ch / 2), scale(v.f), rotate(deg(g.angle)), translate(-v.anchor.x, -v.anchor.y));
    const p = apply(m, { x: c.cx, y: c.cy });
    return { x: p.x - (c.w * v.f) / 2, y: p.y - (c.h * v.f) / 2, w: c.w * v.f, h: c.h * v.f };
  }

  private drawCropOverlay() {
    const ctx = this.ctx;
    const r = this.cropScreenRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(5,5,7,0.62)';
    ctx.beginPath();
    ctx.rect(0, 0, this.cw, this.ch);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill('evenodd');
    const d = this.dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5 * d;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1 * d;
    ctx.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      ctx.moveTo(r.x + r.w * t, r.y);
      ctx.lineTo(r.x + r.w * t, r.y + r.h);
      ctx.moveTo(r.x, r.y + r.h * t);
      ctx.lineTo(r.x + r.w, r.y + r.h * t);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4 * d;
    const L = Math.min(22 * d, r.w / 3, r.h / 3);
    ctx.beginPath();
    for (const [x, y, sx, sy] of [
      [r.x, r.y, 1, 1],
      [r.x + r.w, r.y, -1, 1],
      [r.x + r.w, r.y + r.h, -1, -1],
      [r.x, r.y + r.h, 1, -1],
    ]) {
      ctx.moveTo(x, y + sy * L);
      ctx.lineTo(x, y);
      ctx.lineTo(x + sx * L, y);
    }
    ctx.stroke();
  }

  private handlePos(l: Layer): Pt {
    return this.layerScreenCorners(l)[2];
  }

  private drawLayerOverlay() {
    const l = this.state.doc.layers.find((x) => x.id === this.state.selected);
    if (!l) return;
    const ctx = this.ctx;
    const cs = this.layerScreenCorners(l);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#ffb35c';
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
    ctx.beginPath();
    cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    const h = this.handlePos(l);
    ctx.fillStyle = '#ffb35c';
    ctx.beginPath();
    ctx.arc(h.x, h.y, 11 * this.dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1a1206';
    ctx.lineWidth = 2 * this.dpr;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 5 * this.dpr, -Math.PI * 0.9, Math.PI * 0.4);
    ctx.stroke();
  }

  private maskTarget(): { mask: Mask | null; wfs: Mat; layer: ImageLayer | null } | null {
    const sel = this.state.selected;
    const d = this.state.doc;
    if (sel === 'base') return { mask: d.base.mask, wfs: d.geo.orient, layer: null };
    const l = d.layers.find((x) => x.id === sel);
    if (!l || l.kind !== 'image') return null;
    return { mask: l.mask, wfs: imageLayerMat(l), layer: l };
  }

  private drawMaskOverlay() {
    const ctx = this.ctx;
    const t = this.maskTarget();
    if (t?.mask && this.state.mask.show) {
      const m = t.mask;
      const key = `${m.id}:${m.version}`;
      if (!this.tint || this.tint.key !== key) {
        if (this.tint) releaseCanvas(this.tint.canvas);
        const c = createCanvas(m.canvas.width, m.canvas.height);
        const x = ctx2d(c);
        x.fillStyle = 'rgb(255,40,90)';
        x.fillRect(0, 0, c.width, c.height);
        x.globalCompositeOperation = 'destination-out';
        x.drawImage(m.canvas, 0, 0);
        this.tint = { key, canvas: c };
      }
      this.setT(chain(this.screenFromWorld(), t.wfs, scale(1 / m.scale)));
      ctx.globalAlpha = 0.45;
      ctx.drawImage(this.tint.canvas, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = this.gesture;
    if (g.kind === 'mask-line') {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * this.dpr;
      if (this.state.mask.tool === 'linear') {
        ctx.beginPath();
        ctx.moveTo(g.p0.x, g.p0.y);
        ctx.lineTo(g.p1.x, g.p1.y);
        ctx.stroke();
        // perpendicular guides at both ends
        const dx = g.p1.x - g.p0.x;
        const dy = g.p1.y - g.p0.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * 2000;
        const ny = (dx / len) * 2000;
        ctx.setLineDash([8 * this.dpr, 6 * this.dpr]);
        ctx.beginPath();
        for (const p of [g.p0, g.p1]) {
          ctx.moveTo(p.x - nx, p.y - ny);
          ctx.lineTo(p.x + nx, p.y + ny);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const r = Math.hypot(g.p1.x - g.p0.x, g.p1.y - g.p0.y);
        ctx.beginPath();
        ctx.arc(g.p0.x, g.p0.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([6 * this.dpr, 6 * this.dpr]);
        ctx.beginPath();
        ctx.arc(g.p0.x, g.p0.y, r * (1 - this.state.mask.feather), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.cursor && this.state.mask.tool === 'brush') {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, this.state.mask.size * this.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---------- input ----------

  private pt(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.dpr, y: (e.clientY - r.top) * this.dpr };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.isCrop) return;
    const r = this.canvas.getBoundingClientRect();
    const p = { x: (e.clientX - r.left) * this.dpr, y: (e.clientY - r.top) * this.dpr };
    this.zoomAbout(p, this.zoom * Math.exp(-e.deltaY * 0.002));
  };

  private zoomAbout(p: Pt, z: number) {
    z = clamp(z, 0.5, 12);
    const k0 = this.fitScale() * this.zoom;
    const k1 = this.fitScale() * z;
    // keep the output point under p fixed
    const ox = (p.x - this.cw / 2 - this.panX) / k0;
    const oy = (p.y - this.ch / 2 - this.panY) / k0;
    this.zoom = z;
    this.panX = p.x - this.cw / 2 - ox * k1;
    this.panY = p.y - this.ch / 2 - oy * k1;
    this.schedule();
  }

  private two(): [Pt, Pt] {
    const it = this.pointers.values();
    return [it.next().value!, it.next().value!];
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.downAt = { t: performance.now(), x: p.x, y: p.y };
      this.startOne(p);
    } else if (this.pointers.size === 2) {
      this.abortOne();
      this.startTwo();
    }
    this.schedule();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) {
      if (this.state.tool === 'mask' && e.pointerType === 'mouse') {
        this.cursor = this.pt(e);
        this.schedule();
      }
      return;
    }
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) this.moveOne(p);
    else if (this.pointers.size === 2) this.moveTwo();
    this.schedule();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.pointers.get(e.pointerId)!;
    const wasOne = this.pointers.size === 1;
    this.pointers.delete(e.pointerId);
    if (wasOne) {
      this.endOne(p);
      const now = performance.now();
      const isTap = now - this.downAt.t < 300 && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) < 12 * this.dpr;
      if (isTap) {
        this.handleTap(p);
        if (now - this.lastTap.t < 350 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30 * this.dpr) {
          this.doubleTap(p);
          this.lastTap.t = 0;
        } else this.lastTap = { t: now, x: p.x, y: p.y };
      }
    } else if (this.pointers.size === 1) {
      // continue as a fresh one-finger gesture that only pans (avoid accidental strokes after a pinch)
      this.endTwo();
      const [q] = this.pointers.values();
      this.gesture = this.isCrop
        ? { kind: 'crop-pan', start: q, crop: this.state.doc.geo.crop, f: this.cropView().f }
        : { kind: 'view-pan', start: q, panX: this.panX, panY: this.panY };
    } else if (this.pointers.size === 0) {
      this.endTwo();
    }
    this.cursor = null;
    this.schedule();
  };

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.abortOne();
    this.gesture = { kind: 'none' };
    this.cropFrozen = null;
    this.cursor = null;
    this.schedule();
  };

  private doubleTap(p: Pt) {
    if (this.state.tool === 'layers') {
      const hit = this.hitLayer(p);
      if (hit && hit.kind === 'text') {
        this.cb.editText(hit.id);
        return;
      }
    }
    if (!this.isCrop) {
      if (this.zoom !== 1 || this.panX || this.panY) this.resetView();
      else this.zoomAbout(p, 2.5);
    }
  }

  private hitLayer(p: Pt): Layer | null {
    const layers = this.state.doc.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.hidden) continue;
      if (pointInPoly(p, this.layerScreenCorners(l))) return l;
    }
    return null;
  }

  private startOne(p: Pt) {
    const s = this.state;
    const doc = s.doc;
    if (this.isCrop) {
      const r = this.cropScreenRect();
      const tol = 26 * this.dpr;
      const nearL = Math.abs(p.x - r.x) < tol;
      const nearR = Math.abs(p.x - (r.x + r.w)) < tol;
      const nearT = Math.abs(p.y - r.y) < tol;
      const nearB = Math.abs(p.y - (r.y + r.h)) < tol;
      const inY = p.y > r.y - tol && p.y < r.y + r.h + tol;
      const inX = p.x > r.x - tol && p.x < r.x + r.w + tol;
      const l = nearL && inY && !nearR;
      const rr = nearR && inY;
      const t = nearT && inX && !nearB;
      const b = nearB && inX;
      if (l || rr || t || b) {
        const v = this.cropView();
        this.cropFrozen = { ...v };
        this.gesture = { kind: 'crop-edge', start: p, crop: doc.geo.crop, anchor: v.anchor, f: v.f, l, r: rr, t, b };
      } else {
        this.gesture = { kind: 'crop-pan', start: p, crop: doc.geo.crop, f: this.cropView().f };
      }
      return;
    }
    if (s.tool === 'layers') {
      const sel = doc.layers.find((l) => l.id === s.selected);
      if (sel) {
        const h = this.handlePos(sel);
        if (Math.hypot(p.x - h.x, p.y - h.y) < 24 * this.dpr) {
          const c = apply(this.screenFromWorld(), { x: sel.t.x, y: sel.t.y });
          this.gesture = { kind: 'layer-handle', id: sel.id, center: c, p0: p, scale: sel.t.scale, rotation: sel.t.rotation };
          return;
        }
      }
      const hit = this.hitLayer(p);
      if (hit) {
        if (hit.id !== s.selected) this.cb.select(hit.id);
        this.gesture = { kind: 'layer-move', id: hit.id, startWorld: this.toWorld(p), x: hit.t.x, y: hit.t.y };
        return;
      }
      if (s.selected !== 'base') this.cb.select('base');
      this.gesture = { kind: 'view-pan', start: p, panX: this.panX, panY: this.panY };
      return;
    }
    if (s.tool === 'mask') {
      this.startMask(p);
      return;
    }
    this.gesture = { kind: 'view-pan', start: p, panX: this.panX, panY: this.panY };
  }

  private moveOne(p: Pt) {
    const g = this.gesture;
    const doc = this.state.doc;
    switch (g.kind) {
      case 'view-pan':
        this.panX = g.panX + (p.x - g.start.x);
        this.panY = g.panY + (p.y - g.start.y);
        break;
      case 'layer-move': {
        const w = this.toWorld(p);
        const l = doc.layers.find((x) => x.id === g.id);
        if (!l) return;
        this.cb.change(
          { ...doc, layers: doc.layers.map((x) => (x.id === g.id ? ({ ...x, t: { ...x.t, x: g.x + w.x - g.startWorld.x, y: g.y + w.y - g.startWorld.y } } as Layer) : x)) },
          false,
        );
        break;
      }
      case 'layer-handle': {
        const v0 = { x: g.p0.x - g.center.x, y: g.p0.y - g.center.y };
        const v1 = { x: p.x - g.center.x, y: p.y - g.center.y };
        const s = Math.hypot(v1.x, v1.y) / Math.max(1, Math.hypot(v0.x, v0.y));
        const da = Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x);
        this.cb.change(
          {
            ...doc,
            layers: doc.layers.map((x) =>
              x.id === g.id ? ({ ...x, t: { ...x.t, scale: clamp(g.scale * s, 1e-4, 1e4), rotation: g.rotation + da } } as Layer) : x,
            ),
          },
          false,
        );
        break;
      }
      case 'crop-pan': {
        const geo = doc.geo;
        const dx = (p.x - g.start.x) / g.f;
        const dy = (p.y - g.start.y) / g.f;
        // the image follows the finger, so the crop centre moves the other way (in the rotated frame)
        const d = apply(rotate(-deg(geo.angle)), { x: dx, y: dy });
        const proposed = { ...g.crop, cx: g.crop.cx - d.x, cy: g.crop.cy - d.y };
        const crop = constrainCrop(geo.crop, proposed, deg(geo.angle), geo.worldW, geo.worldH);
        this.cb.change({ ...doc, geo: { ...geo, crop } }, false);
        break;
      }
      case 'crop-edge':
        this.moveCropEdge(g, p);
        break;
      case 'mask-brush':
        this.moveBrush(g, p);
        break;
      case 'mask-line':
        g.p1 = p;
        break;
    }
  }

  private moveCropEdge(g: Extract<Gesture, { kind: 'crop-edge' }>, p: Pt) {
    const doc = this.state.doc;
    const geo = doc.geo;
    const a = deg(geo.angle);
    const du = { x: (p.x - g.start.x) / g.f, y: (p.y - g.start.y) / g.f };
    // crop box in the rotated frame centred at the anchor
    const uc = apply(rotate(a), { x: g.crop.cx - g.anchor.x, y: g.crop.cy - g.anchor.y });
    let L = uc.x - g.crop.w / 2;
    let R = uc.x + g.crop.w / 2;
    let T = uc.y - g.crop.h / 2;
    let B = uc.y + g.crop.h / 2;
    const minS = Math.max(16, Math.min(geo.worldW, geo.worldH) * 0.04);
    if (g.l) L = Math.min(L + du.x, R - minS);
    if (g.r) R = Math.max(R + du.x, L + minS);
    if (g.t) T = Math.min(T + du.y, B - minS);
    if (g.b) B = Math.max(B + du.y, T + minS);
    const asp = this.state.aspect;
    if (asp) {
      const horiz = g.l || g.r;
      const vert = g.t || g.b;
      let w = R - L;
      let h = B - T;
      if (horiz && vert) {
        // corner: follow the larger relative change
        if (w / asp > h) h = w / asp;
        else w = h * asp;
      } else if (horiz) h = w / asp;
      else w = h * asp;
      if (g.l) L = R - w;
      else if (g.r) R = L + w;
      else {
        const cx = (L + R) / 2;
        L = cx - w / 2;
        R = cx + w / 2;
      }
      if (g.t) T = B - h;
      else if (g.b) B = T + h;
      else {
        const cy = (T + B) / 2;
        T = cy - h / 2;
        B = cy + h / 2;
      }
    }
    const c = apply(rotate(-a), { x: (L + R) / 2, y: (T + B) / 2 });
    const proposed: Crop = { cx: g.anchor.x + c.x, cy: g.anchor.y + c.y, w: R - L, h: B - T };
    const crop = constrainCrop(geo.crop, proposed, a, geo.worldW, geo.worldH);
    this.cb.change({ ...doc, geo: { ...geo, crop } }, false);
  }

  private endOne(p: Pt) {
    const g = this.gesture;
    this.gesture = { kind: 'none' };
    switch (g.kind) {
      case 'layer-move':
      case 'layer-handle':
      case 'crop-pan':
        this.cb.change(this.state.doc, true);
        break;
      case 'crop-edge':
        this.cropFrozen = null;
        this.cb.change(this.state.doc, true);
        break;
      case 'mask-brush':
        this.cb.change(this.state.doc, true);
        break;
      case 'mask-line':
        g.p1 = p;
        this.applyMaskLine(g);
        break;
    }
  }

  /** A second finger arrived: undo whatever the first finger started. */
  private abortOne() {
    const g = this.gesture;
    if (g.kind === 'mask-brush' || g.kind === 'layer-move' || g.kind === 'layer-handle' || g.kind === 'crop-edge') {
      if (g.kind === 'mask-brush' || g.kind === 'crop-edge') this.cb.revert();
      else this.cb.change(this.state.doc, true);
      this.maskChanged();
    }
    if (g.kind === 'crop-pan') this.cb.change(this.state.doc, true);
    this.cropFrozen = null;
    this.gesture = { kind: 'none' };
  }

  private startTwo() {
    const [a, b] = this.two();
    const c0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d0 = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const s = this.state;
    if (this.isCrop) {
      this.gesture = { kind: 'pinch-crop', d0, crop: s.doc.geo.crop };
      return;
    }
    if (s.tool === 'layers') {
      const l = s.doc.layers.find((x) => x.id === s.selected);
      if (l) {
        this.gesture = {
          kind: 'pinch-layer',
          id: l.id,
          c0,
          d0,
          a0: Math.atan2(b.y - a.y, b.x - a.x),
          x: l.t.x,
          y: l.t.y,
          scale: l.t.scale,
          rotation: l.t.rotation,
        };
        return;
      }
    }
    this.gesture = { kind: 'pinch-view', c0, d0, zoom: this.zoom, panX: this.panX, panY: this.panY };
  }

  private moveTwo() {
    const [a, b] = this.two();
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const g = this.gesture;
    const doc = this.state.doc;
    if (g.kind === 'pinch-view') {
      const z = clamp((g.zoom * d) / g.d0, 0.5, 12);
      const k0 = this.fitScale() * g.zoom;
      const k1 = this.fitScale() * z;
      const ox = (g.c0.x - this.cw / 2 - g.panX) / k0;
      const oy = (g.c0.y - this.ch / 2 - g.panY) / k0;
      this.zoom = z;
      this.panX = c.x - this.cw / 2 - ox * k1;
      this.panY = c.y - this.ch / 2 - oy * k1;
    } else if (g.kind === 'pinch-layer') {
      const s = d / g.d0;
      const da = Math.atan2(b.y - a.y, b.x - a.x) - g.a0;
      const w0 = this.toWorld(g.c0);
      const w1 = this.toWorld(c);
      // rotate/scale the layer centre about the pinch centre, then follow the pinch centre
      const off = apply(chain(rotate(da), scale(s)), { x: g.x - w0.x, y: g.y - w0.y });
      this.cb.change(
        {
          ...doc,
          layers: doc.layers.map((x) =>
            x.id === g.id
              ? ({ ...x, t: { ...x.t, x: w1.x + off.x, y: w1.y + off.y, scale: clamp(g.scale * s, 1e-4, 1e4), rotation: g.rotation + da } } as Layer)
              : x,
          ),
        },
        false,
      );
    } else if (g.kind === 'pinch-crop') {
      const geo = doc.geo;
      const s = clamp(d / g.d0, 0.05, 20);
      const proposed = { ...g.crop, w: g.crop.w / s, h: g.crop.h / s };
      const minS = Math.max(16, Math.min(geo.worldW, geo.worldH) * 0.04);
      if (proposed.w < minS || proposed.h < minS) return;
      const crop = constrainCrop(geo.crop, proposed, deg(geo.angle), geo.worldW, geo.worldH);
      this.cb.change({ ...doc, geo: { ...geo, crop } }, false);
    }
  }

  private endTwo() {
    const g = this.gesture;
    if (g.kind === 'pinch-layer' || g.kind === 'pinch-crop') this.cb.change(this.state.doc, true);
    this.gesture = { kind: 'none' };
  }

  // ---------- masks ----------

  private ensureMask(): { mask: Mask; wfs: Mat } | null {
    const t = this.maskTarget();
    if (!t) {
      this.cb.notify('Masks work on photos. Select the base photo or a photo layer.');
      return null;
    }
    if (t.mask) return { mask: t.mask, wfs: t.wfs };
    const doc = this.state.doc;
    const src = t.layer ? t.layer.src : doc.base.src;
    const mask = createMask(src.width, src.height);
    const next: Doc = t.layer
      ? { ...doc, layers: doc.layers.map((l) => (l.id === t.layer!.id ? { ...(l as ImageLayer), mask } : l)) }
      : { ...doc, base: { ...doc.base, mask } };
    this.state = { ...this.state, doc: next };
    this.cb.change(next, false);
    return { mask, wfs: t.wfs };
  }

  /** screen px -> mask px, plus the brush radius in mask px. */
  private maskMapping(mask: Mask, wfs: Mat) {
    const m = chain(this.screenFromWorld(), wfs, scale(1 / mask.scale));
    const inv = invert(m);
    const pxPerMask = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    return { inv, pxPerMask };
  }

  private brush(mask: Mask, wfs: Mat): Brush {
    const ms = this.state.mask;
    const { pxPerMask } = this.maskMapping(mask, wfs);
    return { radius: (ms.size * this.dpr) / pxPerMask, hardness: ms.hardness, flow: ms.flow, mode: ms.mode };
  }

  private startMask(p: Pt) {
    const ms = this.state.mask;
    if (ms.tool === 'linear' || ms.tool === 'radial') {
      if (!this.maskTarget()) {
        this.cb.notify('Masks work on photos. Select the base photo or a photo layer.');
        return;
      }
      this.gesture = { kind: 'mask-line', p0: p, p1: p };
      return;
    }
    if (ms.tool === 'wand') return; // handled on tap release
    const t = this.ensureMask();
    if (!t) return;
    const { inv } = this.maskMapping(t.mask, t.wfs);
    const q = apply(inv, p);
    dab(t.mask, q.x, q.y, this.brush(t.mask, t.wfs));
    touch(t.mask);
    this.cursor = p;
    this.gesture = { kind: 'mask-brush', last: q, carry: 0, startedAt: performance.now() };
    this.maskChanged();
  }

  private moveBrush(g: Extract<Gesture, { kind: 'mask-brush' }>, p: Pt) {
    const t = this.maskTarget();
    if (!t?.mask) return;
    const { inv } = this.maskMapping(t.mask, t.wfs);
    const q = apply(inv, p);
    g.carry = strokeSegment(t.mask, g.last.x, g.last.y, q.x, q.y, this.brush(t.mask, t.wfs), g.carry);
    g.last = q;
    touch(t.mask);
    this.cursor = p;
    this.maskChanged();
  }

  private applyMaskLine(g: Extract<Gesture, { kind: 'mask-line' }>) {
    if (Math.hypot(g.p1.x - g.p0.x, g.p1.y - g.p0.y) < 6 * this.dpr) {
      this.schedule();
      return;
    }
    const t = this.ensureMask();
    if (!t) return;
    const { inv, pxPerMask } = this.maskMapping(t.mask, t.wfs);
    const a = apply(inv, g.p0);
    const b = apply(inv, g.p1);
    if (this.state.mask.tool === 'linear') linearGradient(t.mask, a.x, a.y, b.x, b.y);
    else {
      const r = Math.hypot(g.p1.x - g.p0.x, g.p1.y - g.p0.y) / pxPerMask;
      radialGradient(t.mask, a.x, a.y, r, this.state.mask.feather, this.state.mask.mode === 'hide');
    }
    touch(t.mask);
    this.maskChanged();
    this.cb.change(this.state.doc, true);
  }

  /** Magic-wand selection at a screen point (called on tap in wand mode). */
  wandAt(p: Pt) {
    const t0 = this.maskTarget();
    if (!t0) {
      this.cb.notify('Masks work on photos. Select the base photo or a photo layer.');
      return;
    }
    const t = this.ensureMask();
    if (!t) return;
    const doc = this.state.doc;
    const ms = this.state.mask;
    const layer = t0.layer;
    const src = layer ? layer.src : doc.base.src;
    const r = imageRaster('wand', src, layer ? layer.adjust : doc.base.adjust, layer ? layer.look : doc.base.look, null, {
      scale: 1,
      mode: 'preview',
    });
    const mw = t.mask.canvas.width;
    const mh = t.mask.canvas.height;
    const c = createCanvas(mw, mh);
    const cx = ctx2d(c, { willReadFrequently: true });
    cx.drawImage(r.canvas, 0, 0, mw, mh);
    r.temp.forEach(releaseCanvas);
    const px = cx.getImageData(0, 0, mw, mh).data;
    releaseCanvas(c);
    const { inv } = this.maskMapping(t.mask, t.wfs);
    const q = apply(inv, p);
    if (q.x < 0 || q.y < 0 || q.x >= mw || q.y >= mh) {
      this.cb.notify('Tap inside the selected photo');
      this.cb.revert();
      return;
    }
    const sel = softenSelection(colorSelect(px, mw, mh, q.x, q.y, ms.tolerance, ms.contiguous), mw, mh);
    writeAlpha(t.mask, applySelection(readAlpha(t.mask), sel, ms.mode === 'hide' ? 'hide' : 'keep'));
    touch(t.mask);
    this.maskChanged();
    this.cb.change(this.state.doc, true);
  }

  /** Expose tap handling for the wand (pointerup with no movement). */
  handleTap(p: Pt) {
    if (this.state.tool === 'mask' && this.state.mask.tool === 'wand') this.wandAt(p);
  }
}
