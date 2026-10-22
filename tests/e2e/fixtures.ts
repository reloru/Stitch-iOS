import { encodePng } from '../../src/core/png';

/** RGBA buffer helpers for generating test images without binary fixtures in the repo. */
function img(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      const i = (y * w + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  return px;
}

async function png(w: number, h: number, px: Uint8ClampedArray): Promise<Buffer> {
  const blob = await encodePng({ width: w, height: h, stripHeight: 256, rows: (y, n) => px.subarray(y * w * 4, (y + n) * w * 4) }, { alpha: true });
  return Buffer.from(await blob.arrayBuffer());
}

/** 1600×1200 photo: left half red, right half blue, green square in the middle. */
export async function photo(): Promise<Buffer> {
  const w = 1600;
  const h = 1200;
  return png(
    w,
    h,
    img(w, h, (x, y) => {
      if (x > 700 && x < 900 && y > 500 && y < 700) return [40, 200, 60, 255];
      return x < w / 2 ? [220, 40, 40, 255] : [40, 60, 220, 255];
    }),
  );
}

/** 400×400 overlay: opaque yellow disc on a transparent background. */
export async function overlay(): Promise<Buffer> {
  const w = 400;
  return png(
    w,
    w,
    img(w, w, (x, y) => (Math.hypot(x - 200, y - 200) < 180 ? [250, 220, 40, 255] : [0, 0, 0, 0])),
  );
}

const SW = 300;
const HEADER = 80;
const FOOTER = 60;
const CONTENT = 500;

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** A tall page of text-like blocks; three scrolling screenshots of it with a fixed header and footer. */
export async function screenshots(): Promise<{ files: Buffer[]; offsets: number[]; pageHeight: number; expected: Uint8ClampedArray }> {
  const H = 1600;
  const r = rng(7);
  const page = new Uint8ClampedArray(SW * H * 4).fill(250);
  for (let y = 0; y < H; y += 18) {
    let x = 12;
    while (x < SW - 30) {
      const len = 8 + Math.floor(r() * 40);
      const c = [Math.floor(r() * 120), Math.floor(r() * 120), Math.floor(r() * 200)];
      for (let yy = y + 4; yy < Math.min(H, y + 14); yy++)
        for (let xx = x; xx < Math.min(SW - 12, x + len); xx++) {
          const i = (yy * SW + xx) * 4;
          page[i] = c[0];
          page[i + 1] = c[1];
          page[i + 2] = c[2];
        }
      x += len + 6 + Math.floor(r() * 12);
    }
  }
  for (let i = 3; i < page.length; i += 4) page[i] = 255;
  const offsets = [0, 380, 820];
  /** One screen of height HEADER + contentH + FOOTER showing page rows [off, off + contentH). */
  const screen = (off: number, contentH: number) => {
    const h = HEADER + contentH + FOOTER;
    const px = new Uint8ClampedArray(SW * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < SW; x++) {
        const i = (y * SW + x) * 4;
        if (y < HEADER) px.set(x % 20 < 10 ? [30, 30, 40, 255] : [60, 60, 80, 255], i);
        else if (y >= HEADER + contentH) px.set(x % 16 < 8 ? [230, 230, 235, 255] : [200, 200, 210, 255], i);
        else px.set(page.subarray(((off + y - HEADER) * SW + x) * 4, ((off + y - HEADER) * SW + x) * 4 + 4), i);
      }
    return px;
  };
  const files: Buffer[] = [];
  for (const off of offsets) files.push(await png(SW, HEADER + CONTENT + FOOTER, screen(off, CONTENT)));
  const total = offsets[2] + CONTENT;
  return { files, offsets, pageHeight: total + HEADER + FOOTER, expected: screen(0, total) };
}

export const SHOT = { w: SW, header: HEADER, footer: FOOTER, content: CONTENT };
