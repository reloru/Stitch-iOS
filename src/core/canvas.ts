export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', opts) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas is too large for this device');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Frees the backing store immediately. iOS Safari counts canvas memory per page, so release big canvases early. */
export function releaseCanvas(c: HTMLCanvasElement | null | undefined) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

export interface CanvasLimits {
  maxArea: number;
  maxSide: number;
}

/** iOS Safari's documented-in-practice cap is 4096×4096 px; we never go above it even where larger canvases work. */
export const AREA_CEILING = 16_777_216;
const SIDE_CANDIDATES = [16384, 8192, 4096];
const AREA_CANDIDATES = [AREA_CEILING, 8_388_608, 4_194_304];

let cached: CanvasLimits | null = null;

function canDraw(w: number, h: number): boolean {
  const c = document.createElement('canvas');
  try {
    c.width = w;
    c.height = h;
    if (c.width !== w || c.height !== h) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(w - 1, h - 1, 1, 1);
    const d = ctx.getImageData(w - 1, h - 1, 1, 1).data;
    return d[0] === 255 && d[3] === 255;
  } catch {
    return false;
  } finally {
    releaseCanvas(c);
  }
}

/** Probes the largest canvas this browser will actually draw into (silently-blank canvases fail the read-back). */
export function canvasLimits(): CanvasLimits {
  if (cached) return cached;
  let maxSide = 2048;
  for (const s of SIDE_CANDIDATES) {
    if (canDraw(s, 1) && canDraw(1, s)) {
      maxSide = s;
      break;
    }
  }
  let maxArea = 2048 * 2048;
  for (const a of AREA_CANDIDATES) {
    const side = Math.floor(Math.sqrt(a));
    if (side <= maxSide && canDraw(side, side)) {
      maxArea = side * side;
      break;
    }
  }
  cached = { maxArea, maxSide };
  return cached;
}

/** Scale factor (≤ 1) that makes a w×h image fit the given area and side limits. */
export function fitScale(w: number, h: number, maxArea: number, maxSide: number): number {
  return Math.min(1, Math.sqrt(maxArea / (w * h)), maxSide / w, maxSide / h);
}

/**
 * High-quality downscale: halves repeatedly before the final draw, which avoids the aliasing a single
 * large-ratio drawImage produces in Safari.
 */
export function downscale(src: CanvasImageSource, sw: number, sh: number, tw: number, th: number): HTMLCanvasElement {
  tw = Math.max(1, Math.round(tw));
  th = Math.max(1, Math.round(th));
  let cur: CanvasImageSource = src;
  let cw = sw;
  let ch = sh;
  const temps: HTMLCanvasElement[] = [];
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.round(cw / 2);
    const nh = Math.round(ch / 2);
    const c = createCanvas(nw, nh);
    ctx2d(c).drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    temps.push(c);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = createCanvas(tw, th);
  ctx2d(out).drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
  temps.forEach(releaseCanvas);
  return out;
}

export function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

/** Decodes an image Blob with EXIF orientation applied (the <img> path is the most reliable one in Safari, incl. HEIC). */
export async function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('This file could not be opened as an image');
  }
  // The object URL must stay valid while the element is drawn; callers drop the element when done.
  (img as HTMLImageElement & { _url?: string })._url = url;
  return img;
}

export function disposeImage(img: HTMLImageElement) {
  const url = (img as HTMLImageElement & { _url?: string })._url;
  if (url) URL.revokeObjectURL(url);
  img.removeAttribute('src');
}

export function checkerPattern(ctx: CanvasRenderingContext2D, size = 12): CanvasPattern | string {
  const c = createCanvas(size * 2, size * 2);
  const x = ctx2d(c);
  x.fillStyle = '#2a2a2a';
  x.fillRect(0, 0, size * 2, size * 2);
  x.fillStyle = '#3a3a3a';
  x.fillRect(0, 0, size, size);
  x.fillRect(size, size, size, size);
  return ctx.createPattern(c, 'repeat') ?? '#333';
}
