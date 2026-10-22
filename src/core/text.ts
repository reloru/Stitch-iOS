import { createCanvas, ctx2d } from './canvas';
import { FONTS, type TextLayer } from './doc';

let measureCtx: CanvasRenderingContext2D | null = null;

function fontString(l: TextLayer, px: number) {
  const f = FONTS.find((x) => x.id === l.font) ?? FONTS[0];
  return `${l.bold ? '700' : '400'} ${px}px ${f.css}`;
}

function layout(l: TextLayer, px: number, ctx: CanvasRenderingContext2D) {
  ctx.font = fontString(l, px);
  const lines = (l.text || ' ').split('\n');
  const widths = lines.map((s) => ctx.measureText(s || ' ').width);
  const lineH = px * 1.22;
  const pad = l.bg ? px * 0.38 : px * 0.18;
  const w = Math.ceil(Math.max(...widths) + pad * 2);
  const h = Math.ceil(lines.length * lineH + pad * 2 - px * 0.1);
  return { lines, widths, lineH, pad, w, h };
}

/** Size of the text box in world px at t.scale = 1. */
export function measureText(l: TextLayer): { w: number; h: number } {
  if (!measureCtx) measureCtx = ctx2d(createCanvas(4, 4));
  const k = 100 / l.size;
  const lay = layout(l, 100, measureCtx);
  return { w: lay.w / k, h: lay.h / k };
}

/** Rasterises a text layer. `pxPerUnit` = canvas px per world px of the unscaled box. */
export function rasterText(l: TextLayer, pxPerUnit: number): HTMLCanvasElement {
  const px = l.size * pxPerUnit;
  const probe = measureCtx ?? (measureCtx = ctx2d(createCanvas(4, 4)));
  const lay = layout(l, px, probe);
  const c = createCanvas(lay.w, lay.h);
  const ctx = ctx2d(c);
  if (l.bg) {
    ctx.fillStyle = l.bg;
    const r = Math.min(px * 0.35, lay.h / 2);
    ctx.beginPath();
    ctx.roundRect(0, 0, c.width, c.height, r);
    ctx.fill();
  }
  ctx.font = fontString(l, px);
  ctx.textBaseline = 'top';
  ctx.textAlign = l.align;
  ctx.fillStyle = l.color;
  if (l.shadow && !l.bg) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = px * 0.12;
    ctx.shadowOffsetY = px * 0.04;
  }
  const x = l.align === 'left' ? lay.pad : l.align === 'right' ? c.width - lay.pad : c.width / 2;
  lay.lines.forEach((s, i) => ctx.fillText(s, x, lay.pad + i * lay.lineH));
  return c;
}
