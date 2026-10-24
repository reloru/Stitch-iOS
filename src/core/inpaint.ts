import { canvasToBlob, createCanvas, ctx2d, decodeImage, disposeImage, releaseCanvas } from './canvas';
import { readAlpha, type Mask } from './mask';
import { decodeFull, type SourceImage } from './source';

/** The model's fixed input size (container/server.py). */
export const MODEL_SIZE = 512;

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Crop sent to the model: a rectangle in source px, and the size it is sent at (longest side ≤ MODEL_SIZE). */
export interface InpaintCrop {
  x: number;
  y: number;
  w: number;
  h: number;
  sendW: number;
  sendH: number;
}

/** Bounding box of the non-zero pixels of an alpha map, or null if it is empty. */
export function alphaBounds(alpha: Uint8Array, w: number, h: number, threshold = 8): Box | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

function place(center: number, size: number, limit: number): number {
  return Math.max(0, Math.min(limit - size, Math.round(center - size / 2)));
}

/**
 * Chooses the area around the object to send. The model sees MODEL_SIZE px, so:
 * - if the object plus a margin fits, send a MODEL_SIZE square around it at native resolution (no resampling, the
 *   most context for free);
 * - otherwise send a square of the object plus a margin, scaled down to MODEL_SIZE (larger objects come back softer).
 * Near the image edges the square is shifted inside; images smaller than the square are used whole.
 */
export function planCrop(box: Box, imageW: number, imageH: number): InpaintCrop {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const big = Math.max(bw, bh);
  const margin = Math.max(24, Math.round(big * 0.2));
  const side = Math.max(MODEL_SIZE, big + 2 * margin);
  const w = Math.min(side, imageW);
  const h = Math.min(side, imageH);
  const x = place((box.x0 + box.x1) / 2, w, imageW);
  const y = place((box.y0 + box.y1) / 2, h, imageH);
  const k = Math.min(1, MODEL_SIZE / Math.max(w, h));
  return { x, y, w, h, sendW: Math.max(8, Math.round(w * k)), sendH: Math.max(8, Math.round(h * k)) };
}

export class InpaintError extends Error {}

async function post(image: Blob, mask: Blob): Promise<Blob> {
  const form = new FormData();
  form.set('image', image, 'image.png');
  form.set('mask', mask, 'mask.png');
  let res: Response;
  try {
    res = await fetch('/api/inpaint', { method: 'POST', body: form });
  } catch {
    throw new InpaintError('Removing objects needs an internet connection');
  }
  if (!res.ok) {
    let msg = 'Removing the object failed — try again';
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) msg = j.message;
    } catch {
      /* not JSON */
    }
    throw new InpaintError(msg);
  }
  return res.blob();
}

/**
 * Removes what `selection` covers from the photo: sends the area around it to /api/inpaint and composites the result
 * through its alpha at full resolution, so pixels away from the selection stay exactly as they were.
 * Returns a new full-resolution canvas (caller releases it).
 */
export async function removeObject(src: SourceImage, selection: Mask): Promise<HTMLCanvasElement> {
  const sel = selection.canvas;
  const b = alphaBounds(readAlpha(selection), sel.width, sel.height);
  if (!b) throw new InpaintError('Paint over what you want to remove first');
  const k = selection.scale;
  const box = { x0: Math.floor(b.x0 / k), y0: Math.floor(b.y0 / k), x1: Math.ceil(b.x1 / k), y1: Math.ceil(b.y1 / k) };
  const c = planCrop(box, src.width, src.height);

  const full = await decodeFull(src);
  const temps: HTMLCanvasElement[] = [];
  let patch: HTMLImageElement | null = null;
  try {
    const input = createCanvas(c.sendW, c.sendH);
    temps.push(input);
    ctx2d(input).drawImage(full, c.x, c.y, c.w, c.h, 0, 0, c.sendW, c.sendH);
    // mask as grey levels: the selection's alpha over black
    const mask = createCanvas(c.sendW, c.sendH);
    temps.push(mask);
    const mx = ctx2d(mask);
    mx.fillStyle = '#000';
    mx.fillRect(0, 0, c.sendW, c.sendH);
    mx.drawImage(sel, c.x * k, c.y * k, c.w * k, c.h * k, 0, 0, c.sendW, c.sendH);
    const out = await post(await canvasToBlob(input, 'image/png'), await canvasToBlob(mask, 'image/png'));

    patch = await decodeImage(out);
    const ctx = ctx2d(full);
    ctx.drawImage(patch, 0, 0, patch.naturalWidth, patch.naturalHeight, c.x, c.y, c.w, c.h);
    return full;
  } catch (e) {
    releaseCanvas(full);
    throw e;
  } finally {
    temps.forEach(releaseCanvas);
    if (patch) disposeImage(patch);
  }
}
