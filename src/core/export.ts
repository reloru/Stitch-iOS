import { canvasLimits, canvasToBlob, createCanvas, ctx2d, fitScale, releaseCanvas } from './canvas';
import { outputSize, type Doc } from './doc';
import { releaseGL } from './gl';
import { encodePng } from './png';
import { renderDoc } from './render';
import { decodeFull, type SourceImage } from './source';
import { computeLayout, drawStitch, type StitchLayout, type StitchSettings } from './stitch';

export type Format = 'jpeg' | 'png';

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  name: string;
  /** set when the result is smaller than requested because of the device canvas limit */
  limited: boolean;
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Output size for an editor export at `scale` (1 = full resolution), after applying the device limit. */
export function docExportSize(doc: Doc, scale: number): { w: number; h: number; s: number; limited: boolean } {
  const lim = canvasLimits();
  const { w, h } = outputSize(doc);
  const cap = fitScale(w, h, lim.maxArea, lim.maxSide);
  const s = Math.min(scale, cap);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), s, limited: cap < scale };
}

export async function exportDoc(doc: Doc, format: Format, quality: number, scale: number): Promise<ExportResult> {
  const size = docExportSize(doc, scale);
  const s = size.s;
  // Decode full resolution only where the proxy would be upscaled.
  const needs = new Map<SourceImage, number>();
  needs.set(doc.base.src, s);
  for (const l of doc.layers) if (l.kind === 'image' && !l.hidden) needs.set(l.src, Math.max(needs.get(l.src) ?? 0, s * l.t.scale));
  const full = new Map<SourceImage, HTMLCanvasElement>();
  try {
    for (const [src, need] of needs) if (need > src.proxyScale * 1.01) full.set(src, await decodeFull(src));
    const c = createCanvas(size.w, size.h);
    try {
      renderDoc(ctx2d(c), doc, { scale: s, mode: 'export', full, forceBackground: format === 'jpeg' ? '#ffffff' : undefined });
      for (const f of full.values()) releaseCanvas(f);
      full.clear();
      releaseGL();
      const blob = await canvasToBlob(c, format === 'jpeg' ? 'image/jpeg' : 'image/png', quality);
      return { blob, width: size.w, height: size.h, name: `stitch-${stamp()}.${format === 'jpeg' ? 'jpg' : 'png'}`, limited: size.limited };
    } finally {
      releaseCanvas(c);
    }
  } finally {
    for (const f of full.values()) releaseCanvas(f);
    releaseGL();
  }
}

// ---------- stitch ----------

export interface StitchExportPlan {
  layout: StitchLayout;
  /** final output size and scale (relative to the layout) */
  w: number;
  h: number;
  s: number;
  /** true if the full-size image exceeds a single canvas and must be written in strips (PNG only) */
  tiled: boolean;
  /** true if the result had to be scaled down */
  limited: boolean;
}

export function planStitchExport(
  items: { w: number; h: number; trim: import('./stitch').Trim }[],
  settings: StitchSettings,
  scale: number,
  allowTiles: boolean,
): StitchExportPlan {
  const layout = computeLayout(items, settings);
  const lim = canvasLimits();
  const W = layout.width * scale;
  const H = layout.height * scale;
  let s = scale;
  if (allowTiles) {
    // Strips need the full width in one canvas; cap total size at ~250 MP so the PNG stays practical.
    s *= Math.min(1, lim.maxSide / W, Math.sqrt(250_000_000 / (W * H)));
  } else {
    s *= fitScale(W, H, lim.maxArea, lim.maxSide);
  }
  const w = Math.max(1, Math.round(layout.width * s));
  const h = Math.max(1, Math.round(layout.height * s));
  const tiled = w * h > lim.maxArea || h > lim.maxSide;
  return { layout, w, h, s, tiled, limited: s < scale - 1e-9 };
}

export async function exportStitch(
  sources: SourceImage[],
  plan: StitchExportPlan,
  settings: StitchSettings,
  format: Format,
  quality: number,
  onProgress?: (f: number) => void,
): Promise<ExportResult> {
  const { layout, s } = plan;
  // Full-resolution pixels are needed only where the proxy would be upscaled.
  const decoded = new Map<number, { img: HTMLCanvasElement; k: number }>();
  const needFull = (i: number) => {
    const p = layout.placed.find((q) => q.index === i)!;
    return (p.dw * s) / p.sw > sources[i].proxyScale * 1.01;
  };
  const pixels = (i: number) => decoded.get(i) ?? { img: sources[i].proxy, k: sources[i].proxyScale };
  const ensure = async (y0: number, y1: number) => {
    for (const p of layout.placed) {
      const visible = p.dy * s < y1 && (p.dy + p.dh) * s > y0;
      if (visible && !decoded.has(p.index) && needFull(p.index)) {
        const img = await decodeFull(sources[p.index]);
        decoded.set(p.index, { img, k: img.width / sources[p.index].width });
      }
      if (!visible && (p.dy + p.dh) * s <= y0 && decoded.has(p.index)) {
        releaseCanvas(decoded.get(p.index)!.img);
        decoded.delete(p.index);
      }
    }
  };
  const name = `stitch-${stamp()}.${format === 'jpeg' && !plan.tiled ? 'jpg' : 'png'}`;
  try {
    if (!plan.tiled) {
      await ensure(0, plan.h);
      const c = createCanvas(plan.w, plan.h);
      try {
        const ctx = ctx2d(c);
        drawStitch(ctx, layout, settings, pixels, { scale: s, ox: 0, oy: 0 }, plan.w, plan.h);
        onProgress?.(0.9);
        const blob = await canvasToBlob(c, format === 'jpeg' ? 'image/jpeg' : 'image/png', quality);
        return { blob, width: plan.w, height: plan.h, name, limited: plan.limited };
      } finally {
        releaseCanvas(c);
      }
    }
    const lim = canvasLimits();
    const stripH = Math.max(1, Math.min(2048, Math.floor(lim.maxArea / plan.w)));
    const strip = createCanvas(plan.w, stripH);
    const ctx = ctx2d(strip, { willReadFrequently: true });
    try {
      const blob = await encodePng(
        {
          width: plan.w,
          height: plan.h,
          stripHeight: stripH,
          rows: async (y, n) => {
            await ensure(y, y + n);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, plan.w, stripH);
            drawStitch(ctx, layout, settings, pixels, { scale: s, ox: 0, oy: y / s }, plan.w, n);
            return ctx.getImageData(0, 0, plan.w, n).data;
          },
        },
        { alpha: false, onProgress },
      );
      return { blob, width: plan.w, height: plan.h, name, limited: plan.limited };
    } finally {
      releaseCanvas(strip);
    }
  } finally {
    for (const d of decoded.values()) releaseCanvas(d.img);
  }
}

/** Renders the stitch into one canvas no bigger than the device limit (for sending to the editor). */
export async function renderStitchForEditor(
  sources: SourceImage[],
  items: { w: number; h: number; trim: import('./stitch').Trim }[],
  settings: StitchSettings,
): Promise<{ canvas: HTMLCanvasElement; limited: boolean }> {
  const plan = planStitchExport(items, settings, 1, false);
  const decoded = new Map<number, { img: HTMLCanvasElement; k: number }>();
  try {
    for (const p of plan.layout.placed) {
      if ((p.dw * plan.s) / p.sw > sources[p.index].proxyScale * 1.01) {
        const img = await decodeFull(sources[p.index]);
        decoded.set(p.index, { img, k: img.width / sources[p.index].width });
      }
    }
    const c = createCanvas(plan.w, plan.h);
    drawStitch(
      ctx2d(c),
      plan.layout,
      settings,
      (i) => decoded.get(i) ?? { img: sources[i].proxy, k: sources[i].proxyScale },
      { scale: plan.s, ox: 0, oy: 0 },
      plan.w,
      plan.h,
    );
    return { canvas: c, limited: plan.limited };
  } finally {
    for (const d of decoded.values()) releaseCanvas(d.img);
  }
}
