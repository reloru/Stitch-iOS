import { ctx2d } from '../core/canvas';
import { clamp, type Pt } from '../core/geometry';
import type { SourceImage } from '../core/source';
import { clampTrim, computeLayout, drawStitch, hitItem, type StitchLayout, type StitchSettings, type Trim } from '../core/stitch';

export interface StitchItem {
  id: string;
  src: SourceImage;
  trim: Trim;
}

export interface StitchViewState {
  items: StitchItem[];
  settings: StitchSettings;
  selected: number;
}

export interface StitchViewCallbacks {
  select(i: number): void;
  trim(i: number, t: Trim, commit: boolean): void;
  /** the user touched the picture (used to dismiss hints) */
  touched(): void;
}

type Edge = 'top' | 'bottom' | 'left' | 'right';

type Gesture =
  | { kind: 'pan'; start: Pt; ox: number; oy: number; moved: boolean }
  | { kind: 'pinch'; d0: number; c0: Pt; zoom: number; ox: number; oy: number }
  | { kind: 'trim'; index: number; edge: Edge; start: Pt; trim: Trim; srcPerScreen: number }
  | { kind: 'none' };

export function itemDims(items: StitchItem[]) {
  return items.map((it) => ({ w: it.src.width, h: it.src.height, trim: it.trim }));
}

export class StitchView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = Math.min(3, window.devicePixelRatio || 1);
  private cw = 1;
  private ch = 1;
  private state: StitchViewState;
  private layout: StitchLayout = { width: 1, height: 1, placed: [] };
  private zoom = 1;
  /** output-space point at the top-left of the canvas */
  private ox = 0;
  private oy = 0;
  private pointers = new Map<number, Pt>();
  private gesture: Gesture = { kind: 'none' };
  private raf = 0;
  private ro: ResizeObserver;
  private lastLayoutKey = '';

  constructor(
    host: HTMLElement,
    state: StitchViewState,
    private cb: StitchViewCallbacks,
  ) {
    this.state = state;
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('data-testid', 'stitch-canvas');
    host.appendChild(this.canvas);
    this.ctx = ctx2d(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onCancel);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    this.relayout(true);
    this.resize();
  }

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  update(s: StitchViewState) {
    this.state = s;
    this.relayout(false);
    this.schedule();
  }

  private relayout(force: boolean) {
    this.layout = computeLayout(itemDims(this.state.items), this.state.settings);
    const s = this.state.settings;
    const key = `${this.state.items.map((i) => i.id).join(',')}|${s.layout}|${s.columns}|${s.cellAspect}`;
    if (force || key !== this.lastLayoutKey) {
      this.lastLayoutKey = key;
      this.fit();
    } else this.clampPan();
  }

  private resize() {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.cw = Math.max(1, Math.round(r.width * this.dpr));
    this.ch = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.width = this.cw;
    this.canvas.height = this.ch;
    this.fit();
    this.draw();
  }

  private baseScale(): number {
    const m = 12 * this.dpr;
    const L = this.layout;
    const fitW = (this.cw - 2 * m) / L.width;
    const fitAll = Math.min(fitW, (this.ch - 2 * m) / L.height);
    // tall vertical stitches fit the width and scroll; everything else fits entirely
    return this.state.settings.layout === 'vertical' ? fitW : fitAll;
  }

  private get k() {
    return this.baseScale() * this.zoom;
  }

  fit() {
    this.zoom = 1;
    const k = this.k;
    const L = this.layout;
    this.ox = -(this.cw / k - L.width) / 2;
    this.oy = L.height * k < this.ch ? -(this.ch / k - L.height) / 2 : -12 * this.dpr / k;
    this.schedule();
  }

  private clampPan() {
    const k = this.k;
    const L = this.layout;
    const viewW = this.cw / k;
    const viewH = this.ch / k;
    const pad = (24 * this.dpr) / k;
    if (L.width <= viewW) this.ox = -(viewW - L.width) / 2;
    else this.ox = clamp(this.ox, -pad, L.width - viewW + pad);
    if (L.height <= viewH) this.oy = -(viewH - L.height) / 2;
    else this.oy = clamp(this.oy, -pad, L.height - viewH + pad);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private toOut(p: Pt): Pt {
    return { x: p.x / this.k + this.ox, y: p.y / this.k + this.oy };
  }

  private toScreen(p: Pt): Pt {
    return { x: (p.x - this.ox) * this.k, y: (p.y - this.oy) * this.k };
  }

  draw() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050507';
    ctx.fillRect(0, 0, this.cw, this.ch);
    const items = this.state.items;
    if (!items.length) return;
    drawStitch(
      ctx,
      this.layout,
      this.state.settings,
      (i) => ({ img: items[i].src.proxy, k: items[i].src.proxyScale }),
      { scale: this.k, ox: this.ox, oy: this.oy },
      this.cw,
      this.ch,
    );
    const sel = this.layout.placed.find((p) => p.index === this.state.selected);
    if (!sel) return;
    const a = this.toScreen({ x: sel.dx, y: sel.dy });
    const b = this.toScreen({ x: sel.dx + sel.dw, y: sel.dy + sel.dh });
    const d = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#ffb35c';
    ctx.lineWidth = 2 * d;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    for (const e of this.edges()) {
      const h = this.handleRect(sel, e);
      ctx.fillStyle = '#ffb35c';
      ctx.beginPath();
      ctx.roundRect(h.x, h.y, h.w, h.h, 4 * d);
      ctx.fill();
    }
  }

  private edges(): Edge[] {
    const l = this.state.settings.layout;
    if (l === 'vertical') return ['top', 'bottom'];
    if (l === 'horizontal') return ['left', 'right'];
    return [];
  }

  private handleRect(p: StitchLayout['placed'][number], e: Edge) {
    const d = this.dpr;
    const a = this.toScreen({ x: p.dx, y: p.dy });
    const b = this.toScreen({ x: p.dx + p.dw, y: p.dy + p.dh });
    const long = 56 * d;
    const thick = 10 * d;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    if (e === 'top') return { x: cx - long / 2, y: a.y - thick / 2, w: long, h: thick };
    if (e === 'bottom') return { x: cx - long / 2, y: b.y - thick / 2, w: long, h: thick };
    if (e === 'left') return { x: a.x - thick / 2, y: cy - long / 2, w: thick, h: long };
    return { x: b.x - thick / 2, y: cy - long / 2, w: thick, h: long };
  }

  private pt(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * this.dpr, y: (e.clientY - r.top) * this.dpr };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const r = this.canvas.getBoundingClientRect();
      this.zoomAbout({ x: (e.clientX - r.left) * this.dpr, y: (e.clientY - r.top) * this.dpr }, this.zoom * Math.exp(-e.deltaY * 0.01));
    } else {
      this.ox += (e.deltaX * this.dpr) / this.k;
      this.oy += (e.deltaY * this.dpr) / this.k;
      this.clampPan();
    }
    this.schedule();
  };

  private zoomAbout(p: Pt, z: number) {
    const o = this.toOut(p);
    this.zoom = clamp(z, 0.3, 10);
    this.ox = o.x - p.x / this.k;
    this.oy = o.y - p.y / this.k;
    this.clampPan();
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.cb.touched();
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      if (this.gesture.kind === 'trim') this.cb.trim(this.gesture.index, this.gesture.trim, false);
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: 'pinch',
        d0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        zoom: this.zoom,
        ox: this.ox,
        oy: this.oy,
      };
      return;
    }
    if (this.pointers.size !== 1) return;
    const sel = this.layout.placed.find((q) => q.index === this.state.selected);
    if (sel) {
      for (const edge of this.edges()) {
        const h = this.handleRect(sel, edge);
        const tol = 18 * this.dpr;
        if (p.x > h.x - tol && p.x < h.x + h.w + tol && p.y > h.y - tol && p.y < h.y + h.h + tol) {
          const vertical = edge === 'top' || edge === 'bottom';
          const srcPerScreen = vertical ? sel.sh / sel.dh / this.k : sel.sw / sel.dw / this.k;
          this.gesture = { kind: 'trim', index: sel.index, edge, start: p, trim: this.state.items[sel.index].trim, srcPerScreen };
          return;
        }
      }
    }
    this.gesture = { kind: 'pan', start: p, ox: this.ox, oy: this.oy, moved: false };
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (g.kind === 'pan') {
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 6 * this.dpr) g.moved = true;
      this.ox = g.ox - (p.x - g.start.x) / this.k;
      this.oy = g.oy - (p.y - g.start.y) / this.k;
      this.clampPan();
    } else if (g.kind === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k0 = this.baseScale() * g.zoom;
      const o = { x: g.c0.x / k0 + g.ox, y: g.c0.y / k0 + g.oy };
      this.zoom = clamp((g.zoom * d) / g.d0, 0.3, 10);
      this.ox = o.x - c.x / this.k;
      this.oy = o.y - c.y / this.k;
      this.clampPan();
    } else if (g.kind === 'trim') {
      const it = this.state.items[g.index];
      const dy = (p.y - g.start.y) * g.srcPerScreen;
      const dx = (p.x - g.start.x) * g.srcPerScreen;
      const t = { ...g.trim };
      if (g.edge === 'top') t.top += dy;
      if (g.edge === 'bottom') t.bottom -= dy;
      if (g.edge === 'left') t.left += dx;
      if (g.edge === 'right') t.right -= dx;
      this.cb.trim(g.index, clampTrim(t, it.src.width, it.src.height), false);
    }
    this.schedule();
  };

  /** The system took the touch (e.g. an edge swipe): put a half-dragged trim back and never treat it as a tap. */
  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (g.kind === 'trim') this.cb.trim(g.index, g.trim, false);
    this.gesture = { kind: 'none' };
    this.schedule();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.pointers.get(e.pointerId)!;
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (this.pointers.size === 0) {
      if (g.kind === 'pan' && !g.moved) {
        const o = this.toOut(p);
        const i = hitItem(this.layout, o.x, o.y);
        this.cb.select(i === this.state.selected ? -1 : i);
      }
      if (g.kind === 'trim') this.cb.trim(g.index, this.state.items[g.index].trim, true);
      this.gesture = { kind: 'none' };
    } else if (this.pointers.size === 1) {
      const [q] = this.pointers.values();
      this.gesture = { kind: 'pan', start: q, ox: this.ox, oy: this.oy, moved: true };
    }
    this.schedule();
  };
}
