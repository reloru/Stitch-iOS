import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { crc32, encodePng } from '../../src/core/png';

/** Minimal PNG decoder (8-bit RGB/RGBA, filters 0–4) to verify the encoder independently. */
function decode(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8;
  let w = 0;
  let h = 0;
  let ct = 0;
  const idat: Uint8Array[] = [];
  while (o < buf.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    const data = buf.subarray(o + 8, o + 8 + len);
    const crc = dv.getUint32(o + 8 + len);
    expect((crc32(buf.subarray(o + 4, o + 8 + len)) ^ 0xffffffff) >>> 0).toBe(crc);
    if (type === 'IHDR') {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
      ct = buf[o + 8 + 9];
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const z = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = z[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const raw = z[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let v: number;
      if (f === 0) v = raw;
      else if (f === 1) v = raw + a;
      else if (f === 2) v = raw + b;
      else if (f === 3) v = raw + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  return { w, h, ct, px: out };
}

function testImage(w: number, h: number) {
  const px = new Uint8ClampedArray(w * h * 4);
  let s = 1;
  for (let i = 0; i < px.length; i += 4) {
    const p = i / 4;
    const x = p % w;
    const y = (p - x) / w;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    px[i] = (x * 7) & 255;
    px[i + 1] = (y * 3) & 255;
    px[i + 2] = y % 40 < 20 ? s & 255 : 128;
    px[i + 3] = x < 5 ? 0 : 255;
  }
  return px;
}

describe('streaming PNG encoder', () => {
  it('round-trips RGBA across strip boundaries', async () => {
    const w = 37;
    const h = 101;
    const px = testImage(w, h);
    const blob = await encodePng(
      { width: w, height: h, stripHeight: 16, rows: (y, n) => px.subarray(y * w * 4, (y + n) * w * 4) },
      { alpha: true },
    );
    const d = decode(new Uint8Array(await blob.arrayBuffer()));
    expect(d.w).toBe(w);
    expect(d.h).toBe(h);
    expect(d.ct).toBe(6);
    expect(Buffer.from(d.px).equals(Buffer.from(px))).toBe(true);
  });

  it('writes RGB without alpha', async () => {
    const w = 64;
    const h = 40;
    const px = testImage(w, h);
    const blob = await encodePng({ width: w, height: h, stripHeight: 7, rows: (y, n) => px.subarray(y * w * 4, (y + n) * w * 4) }, { alpha: false });
    const d = decode(new Uint8Array(await blob.arrayBuffer()));
    expect(d.ct).toBe(2);
    for (let i = 0; i < w * h; i++) {
      expect(d.px[i * 3]).toBe(px[i * 4]);
      expect(d.px[i * 3 + 2]).toBe(px[i * 4 + 2]);
    }
  });

  it('splits large compressed data into multiple IDAT chunks', async () => {
    const w = 1024;
    const h = 600;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i += 65536) crypto.getRandomValues(px.subarray(i, i + 65536));
    const blob = await encodePng({ width: w, height: h, stripHeight: 256, rows: (y, n) => px.subarray(y * w * 4, (y + n) * w * 4) }, { alpha: true });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const text = Buffer.from(buf).toString('latin1');
    expect(text.split('IDAT').length - 1).toBeGreaterThan(1);
    const d = decode(buf);
    expect(Buffer.from(d.px).equals(Buffer.from(px))).toBe(true);
  });
});
