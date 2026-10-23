import { canvasLimits, canvasToBlob, createCanvas, ctx2d, decodeImage, disposeImage, downscale, fitScale, releaseCanvas } from './canvas';

/** Longest side of the editing proxy. Full resolution is decoded again only for export. */
export const PROXY_MAX = 2048;
const THUMB_MAX = 240;

let nextId = 1;
export const uid = (p = 'id') => `${p}${nextId++}${Math.random().toString(36).slice(2, 6)}`;

export interface SourceImage {
  id: string;
  name: string;
  blob: Blob;
  /** Size of the image as decoded (EXIF orientation applied), capped to the device canvas limit. */
  width: number;
  height: number;
  /** True if the original was larger than the device can render and `width/height` are downscaled. */
  capped: boolean;
  /** false when the file format cannot hold transparency (JPEG/HEIC) */
  alpha: boolean;
  /** ≤ PROXY_MAX canvas used for all interactive rendering. */
  proxy: HTMLCanvasElement;
  /** proxy.width / width */
  proxyScale: number;
  /** Small JPEG object URL for lists. */
  thumbUrl: string;
}

export async function loadSource(blob: Blob, name = 'Photo'): Promise<SourceImage> {
  const img = await decodeImage(blob);
  try {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) throw new Error('Empty image');
    const lim = canvasLimits();
    const cap = fitScale(nw, nh, lim.maxArea, lim.maxSide);
    const width = Math.round(nw * cap);
    const height = Math.round(nh * cap);
    const ps = Math.min(1, PROXY_MAX / Math.max(width, height));
    const proxy = downscale(img, nw, nh, width * ps, height * ps);
    const ts = Math.min(1, THUMB_MAX / Math.max(width, height));
    const thumbC = downscale(proxy, proxy.width, proxy.height, width * ts, height * ts);
    const thumbUrl = URL.createObjectURL(await canvasToBlob(thumbC, 'image/jpeg', 0.8));
    releaseCanvas(thumbC);
    return {
      id: uid('src'),
      name,
      blob,
      width,
      height,
      capped: cap < 1,
      alpha: !/^image\/(jpe?g|heic|heif)$/i.test(blob.type),
      proxy,
      proxyScale: proxy.width / width,
      thumbUrl,
    };
  } finally {
    disposeImage(img);
  }
}

/**
 * Creates a source from a canvas we rendered ourselves (a stitch or a merge). Always stored as PNG so merging and
 * stitching never add a generation of lossy compression; `alpha` records whether the result can be transparent.
 */
export async function sourceFromCanvas(c: HTMLCanvasElement, name: string, alpha = true): Promise<SourceImage> {
  const src = await loadSource(await canvasToBlob(c, 'image/png'), name);
  return { ...src, alpha };
}

/** Decodes the full-resolution image (capped to the device limit). Caller must release the returned canvas. */
export async function decodeFull(src: SourceImage): Promise<HTMLCanvasElement> {
  const img = await decodeImage(src.blob);
  try {
    const c = createCanvas(src.width, src.height);
    const ctx = ctx2d(c);
    if (img.naturalWidth === src.width && img.naturalHeight === src.height) ctx.drawImage(img, 0, 0);
    else ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, src.width, src.height);
    return c;
  } finally {
    disposeImage(img);
  }
}

export function disposeSource(src: SourceImage) {
  URL.revokeObjectURL(src.thumbUrl);
  releaseCanvas(src.proxy);
}
