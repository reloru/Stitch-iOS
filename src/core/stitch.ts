/** Stitch layout (pure). All sizes are in source / output pixels at full resolution. */

export interface Trim {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const NO_TRIM: Trim = { top: 0, bottom: 0, left: 0, right: 0 };

export type LayoutKind = 'vertical' | 'horizontal' | 'grid';

export interface StitchSettings {
  layout: LayoutKind;
  columns: number;
  /** grid cell aspect (w/h); null = aspect of the first photo */
  cellAspect: number | null;
  gap: number;
  padding: number;
  radius: number;
  background: string;
  /** cap on the common width (vertical) / height (horizontal) / cell width (grid), in px */
  maxSize: number;
}

export const STITCH_DEFAULTS: StitchSettings = {
  layout: 'vertical',
  columns: 2,
  cellAspect: 1,
  gap: 0,
  padding: 0,
  radius: 0,
  background: '#ffffff',
  maxSize: 4096,
};

export interface ItemDims {
  w: number;
  h: number;
  trim: Trim;
}

export interface Placed {
  index: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface StitchLayout {
  width: number;
  height: number;
  placed: Placed[];
}

export function cropped(d: ItemDims): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, d.trim.left);
  const y = Math.max(0, d.trim.top);
  const w = Math.max(1, d.w - d.trim.left - d.trim.right);
  const h = Math.max(1, d.h - d.trim.top - d.trim.bottom);
  return { x, y, w, h };
}

/** Clamps a trim so at least `minKeep` px remain on each axis. */
export function clampTrim(t: Trim, w: number, h: number, minKeep = 16): Trim {
  const c = (v: number) => Math.max(0, Math.round(v));
  let { top, bottom, left, right } = { top: c(t.top), bottom: c(t.bottom), left: c(t.left), right: c(t.right) };
  if (top + bottom > h - minKeep) {
    const over = top + bottom - (h - minKeep);
    const tb = top + bottom || 1;
    top -= Math.ceil((over * top) / tb);
    bottom = Math.max(0, h - minKeep - top);
  }
  if (left + right > w - minKeep) {
    const over = left + right - (w - minKeep);
    const lr = left + right || 1;
    left -= Math.ceil((over * left) / lr);
    right = Math.max(0, w - minKeep - left);
  }
  return { top: Math.max(0, top), bottom: Math.max(0, bottom), left: Math.max(0, left), right: Math.max(0, right) };
}

export function computeLayout(items: ItemDims[], s: StitchSettings): StitchLayout {
  const n = items.length;
  if (n === 0) return { width: 1, height: 1, placed: [] };
  const crops = items.map(cropped);
  const pad = Math.max(0, s.padding);
  const gap = Math.max(0, s.gap);
  const placed: Placed[] = [];

  if (s.layout === 'vertical') {
    const W = Math.min(s.maxSize, Math.max(...crops.map((c) => c.w)));
    let y = pad;
    crops.forEach((c, i) => {
      const dh = Math.round((c.h * W) / c.w);
      placed.push({ index: i, sx: c.x, sy: c.y, sw: c.w, sh: c.h, dx: pad, dy: y, dw: W, dh });
      y += dh + (i < n - 1 ? gap : 0);
    });
    return { width: W + pad * 2, height: y + pad, placed };
  }

  if (s.layout === 'horizontal') {
    const H = Math.min(s.maxSize, Math.max(...crops.map((c) => c.h)));
    let x = pad;
    crops.forEach((c, i) => {
      const dw = Math.round((c.w * H) / c.h);
      placed.push({ index: i, sx: c.x, sy: c.y, sw: c.w, sh: c.h, dx: x, dy: pad, dw, dh: H });
      x += dw + (i < n - 1 ? gap : 0);
    });
    return { width: x + pad, height: H + pad * 2, placed };
  }

  // grid: uniform cells, each photo covers its cell (centre crop)
  const cols = Math.max(1, Math.min(s.columns, n));
  const rows = Math.ceil(n / cols);
  const aspect = s.cellAspect ?? crops[0].w / crops[0].h;
  const cellW = Math.round(Math.min(s.maxSize / cols, Math.max(...crops.map((c) => c.w))));
  const cellH = Math.max(1, Math.round(cellW / aspect));
  crops.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const f = Math.max(cellW / c.w, cellH / c.h);
    const sw = cellW / f;
    const sh = cellH / f;
    placed.push({
      index: i,
      sx: c.x + (c.w - sw) / 2,
      sy: c.y + (c.h - sh) / 2,
      sw,
      sh,
      dx: pad + col * (cellW + gap),
      dy: pad + row * (cellH + gap),
      dw: cellW,
      dh: cellH,
    });
  });
  return { width: pad * 2 + cols * cellW + (cols - 1) * gap, height: pad * 2 + rows * cellH + (rows - 1) * gap, placed };
}

/** Index of the placed item under an output-space point. */
export function hitItem(layout: StitchLayout, x: number, y: number): number {
  for (const p of layout.placed) if (x >= p.dx && x < p.dx + p.dw && y >= p.dy && y < p.dy + p.dh) return p.index;
  return -1;
}

/** Draws the part of the layout that intersects the canvas, given output->canvas `scale` and an output-space origin. */
export function drawStitch(
  ctx: CanvasRenderingContext2D,
  layout: StitchLayout,
  s: StitchSettings,
  pixels: (index: number) => { img: CanvasImageSource; k: number } | null,
  view: { scale: number; ox: number; oy: number },
  canvasW: number,
  canvasH: number,
  transparent = false,
) {
  const { scale: sc, ox, oy } = view;
  ctx.save();
  ctx.setTransform(sc, 0, 0, sc, -ox * sc, -oy * sc);
  if (!transparent) {
    ctx.fillStyle = s.background;
    ctx.fillRect(0, 0, layout.width, layout.height);
  }
  const vx0 = ox;
  const vy0 = oy;
  const vx1 = ox + canvasW / sc;
  const vy1 = oy + canvasH / sc;
  for (const p of layout.placed) {
    if (p.dx > vx1 || p.dy > vy1 || p.dx + p.dw < vx0 || p.dy + p.dh < vy0) continue;
    const px = pixels(p.index);
    if (!px) continue;
    ctx.save();
    if (s.radius > 0) {
      ctx.beginPath();
      ctx.roundRect(p.dx, p.dy, p.dw, p.dh, Math.min(s.radius, p.dw / 2, p.dh / 2));
      ctx.clip();
    }
    ctx.drawImage(px.img, p.sx * px.k, p.sy * px.k, p.sw * px.k, p.sh * px.k, p.dx, p.dy, p.dw, p.dh);
    ctx.restore();
  }
  ctx.restore();
}
