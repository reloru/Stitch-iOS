import { canvasToBlob, createCanvas, ctx2d, decodeImage, disposeImage, releaseCanvas } from './canvas';
import { createMask, readAlpha, touch, writeAlpha, type Mask } from './mask';
import type { SourceImage } from './source';

export class RemoveBgError extends Error {}

/**
 * Sends the photo (its ≤2048 px editing proxy, as JPEG) to /api/remove-bg and returns the subject's alpha at
 * mask resolution for `mask` (or a new mask for `src`). The returned PNG may differ in size; it is scaled.
 */
export async function subjectAlpha(src: SourceImage, maskW: number, maskH: number): Promise<Uint8Array> {
  const jpeg = await canvasToBlob(src.proxy, 'image/jpeg', 0.92);
  let res: Response;
  try {
    res = await fetch('/api/remove-bg', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
  } catch {
    throw new RemoveBgError('Removing the background needs an internet connection');
  }
  if (!res.ok) {
    let msg = 'Background removal failed — try again';
    try {
      const j = (await res.json()) as { message?: string };
      if (j.message) msg = j.message;
    } catch {
      /* not JSON */
    }
    throw new RemoveBgError(msg);
  }
  const img = await decodeImage(await res.blob());
  const c = createCanvas(maskW, maskH);
  try {
    const ctx = ctx2d(c, { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, maskW, maskH);
    const d = ctx.getImageData(0, 0, maskW, maskH).data;
    const a = new Uint8Array(maskW * maskH);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
    return a;
  } finally {
    releaseCanvas(c);
    disposeImage(img);
  }
}

/** Applies the subject alpha to a layer's mask (creating one if needed), keeping earlier mask edits. */
export async function removeBackground(src: SourceImage, existing: Mask | null): Promise<Mask> {
  const mask = existing ?? createMask(src.width, src.height);
  const alpha = await subjectAlpha(src, mask.canvas.width, mask.canvas.height);
  const cur = readAlpha(mask);
  for (let i = 0; i < cur.length; i++) cur[i] = Math.round((cur[i] * alpha[i]) / 255);
  writeAlpha(mask, cur);
  touch(mask);
  return mask;
}
