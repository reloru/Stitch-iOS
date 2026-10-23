import { useEffect, useRef, useState } from 'preact/hooks';
import { checkerPattern, createCanvas, ctx2d, releaseCanvas } from '../core/canvas';
import { aspectRect, dragRect, type Edges } from '../core/croprect';
import type { ImageLayer, Rect } from '../core/doc';
import { Scroller, Sheet } from '../ui/common';

const ASPECTS: { name: string; v: number | null | 'orig' }[] = [
  { name: 'Free', v: null },
  { name: 'Original', v: 'orig' },
  { name: 'Square', v: 1 },
  { name: '4:5', v: 4 / 5 },
  { name: '3:4', v: 3 / 4 },
  { name: '16:9', v: 16 / 9 },
  { name: '9:16', v: 9 / 16 },
];

/** Crops a photo overlay. Works in the layer's full source pixels; the mask (cut-out) is shown applied. */
export function CropSheet(props: { layer: ImageLayer; onDone: (r: Rect | null) => void; onClose: () => void }) {
  const { layer } = props;
  const W = layer.src.width;
  const H = layer.src.height;
  const [rect, setRect] = useState<Rect>(layer.crop ?? { x: 0, y: 0, w: W, h: H });
  const [aspect, setAspect] = useState<number | null>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const canvas = canvasRef.current!;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const ctx = ctx2d(canvas);
    // the overlay as it looks in the picture (mask applied), at proxy resolution
    const p = layer.src.proxy;
    const img = createCanvas(p.width, p.height);
    const ix = ctx2d(img);
    ix.drawImage(p, 0, 0);
    if (layer.mask) {
      ix.globalCompositeOperation = 'destination-in';
      ix.drawImage(layer.mask.canvas, 0, 0, img.width, img.height);
    }
    let checker: CanvasPattern | string | null = null;
    let view = { f: 1, ox: 0, oy: 0 };

    const layout = () => {
      const r = host.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      const m = 22 * dpr;
      const f = Math.min((canvas.width - 2 * m) / W, (canvas.height - 2 * m) / H);
      view = { f, ox: (canvas.width - W * f) / 2, oy: (canvas.height - H * f) / 2 };
      checker = null;
      draw();
    };
    const draw = () => {
      const { f, ox, oy } = view;
      const r = rectRef.current;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#050507';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!checker) checker = checkerPattern(ctx, 8 * dpr);
      ctx.fillStyle = checker;
      ctx.fillRect(ox, oy, W * f, H * f);
      ctx.drawImage(img, ox, oy, W * f, H * f);
      const x = ox + r.x * f;
      const y = oy + r.y * f;
      const w = r.w * f;
      const h = r.h * f;
      ctx.fillStyle = 'rgba(5,5,7,0.62)';
      ctx.beginPath();
      ctx.rect(ox, oy, W * f, H * f);
      ctx.rect(x, y, w, h);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 4 * dpr;
      const L = Math.min(20 * dpr, w / 3, h / 3);
      ctx.beginPath();
      for (const [cx, cy, sx, sy] of [
        [x, y, 1, 1],
        [x + w, y, -1, 1],
        [x + w, y + h, -1, -1],
        [x, y + h, 1, -1],
      ]) {
        ctx.moveTo(cx, cy + sy * L);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * L, cy);
      }
      ctx.stroke();
    };

    let drag: { id: number; sx: number; sy: number; r0: Rect; e: Edges } | null = null;
    const pt = (e: PointerEvent) => {
      const b = canvas.getBoundingClientRect();
      return { x: (e.clientX - b.left) * dpr, y: (e.clientY - b.top) * dpr };
    };
    const down = (e: PointerEvent) => {
      if (drag) return;
      canvas.setPointerCapture(e.pointerId);
      const q = pt(e);
      const { f, ox, oy } = view;
      const r = rectRef.current;
      const x0 = ox + r.x * f;
      const y0 = oy + r.y * f;
      const x1 = x0 + r.w * f;
      const y1 = y0 + r.h * f;
      const tol = 24 * dpr;
      const inY = q.y > y0 - tol && q.y < y1 + tol;
      const inX = q.x > x0 - tol && q.x < x1 + tol;
      const nl = Math.abs(q.x - x0) < tol && inY;
      const nr = Math.abs(q.x - x1) < tol && inY;
      const nt = Math.abs(q.y - y0) < tol && inX;
      const nb = Math.abs(q.y - y1) < tol && inX;
      drag = { id: e.pointerId, sx: q.x, sy: q.y, r0: r, e: { l: nl && !nr, r: nr, t: nt && !nb, b: nb } };
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const q = pt(e);
      const minS = Math.max(8, Math.min(W, H) * 0.04);
      const next = dragRect(drag.r0, drag.e, (q.x - drag.sx) / view.f, (q.y - drag.sy) / view.f, W, H, aspectRef.current, minS);
      rectRef.current = next;
      setRect(next);
      draw();
    };
    const up = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) drag = null;
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    (canvas as HTMLCanvasElement & { _redraw?: () => void })._redraw = draw;
    return () => {
      ro.disconnect();
      releaseCanvas(img);
    };
  }, []);

  useEffect(() => {
    (canvasRef.current as (HTMLCanvasElement & { _redraw?: () => void }) | null)?._redraw?.();
  }, [rect]);

  const pick = (v: number | null | 'orig') => {
    const a = v === 'orig' ? W / H : v;
    setAspect(a);
    if (a) {
      const r = rectRef.current;
      setRect(aspectRect(a, W, H, r.x + r.w / 2, r.y + r.h / 2));
    }
  };

  return (
    <Sheet title="Crop overlay" onClose={props.onClose} keep>
      <div class="crop-stage" ref={hostRef}>
        <canvas ref={canvasRef} data-testid="layer-crop-canvas" />
      </div>
      <Scroller>
        {ASPECTS.map((a) => {
          const v = a.v === 'orig' ? W / H : a.v;
          const on = v === null ? aspect === null : aspect !== null && Math.abs(aspect - v) < 1e-6;
          return (
            <button key={a.name} class={'chip' + (on ? ' on' : '')} onClick={() => pick(a.v)}>
              {a.name}
            </button>
          );
        })}
      </Scroller>
      <p class="note" data-testid="layer-crop-size">
        {Math.round(rect.w)} × {Math.round(rect.h)} px
      </p>
      <div class="actions">
        <button
          class="btn"
          onClick={() => {
            setAspect(null);
            setRect({ x: 0, y: 0, w: W, h: H });
          }}
        >
          Reset
        </button>
        <button class="btn primary" data-testid="layer-crop-done" onClick={() => props.onDone(rect)}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
