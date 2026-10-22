/**
 * Streaming PNG encoder. Rows are supplied in strips, so images larger than the browser's maximum canvas
 * (e.g. a long stitched screenshot) can be written without ever holding the whole image in a canvas.
 * Uses CompressionStream('deflate'), which produces the zlib stream PNG's IDAT expects (RFC 1950).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff;
  dv.setUint32(8 + data.length, crc >>> 0);
  return out;
}

export interface StripSource {
  width: number;
  height: number;
  /** Return RGBA bytes for rows [y, y + rows). */
  rows(y: number, rows: number): Promise<Uint8ClampedArray> | Uint8ClampedArray;
  /** Rows requested per call. */
  stripHeight: number;
}

/** Picks the cheapest of None/Sub/Up per row (minimum sum of absolute signed differences heuristic). */
function filterRow(cur: Uint8ClampedArray, prev: Uint8ClampedArray | null, bpp: number, out: Uint8Array, o: number): void {
  const n = cur.length;
  let sNone = 0;
  let sSub = 0;
  let sUp = 0;
  for (let i = 0; i < n; i++) {
    const v = cur[i];
    sNone += v < 128 ? v : 256 - v;
    const s = (v - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
    sSub += s < 128 ? s : 256 - s;
    const u = (v - (prev ? prev[i] : 0)) & 0xff;
    sUp += u < 128 ? u : 256 - u;
  }
  if (sSub <= sNone && sSub <= sUp) {
    out[o] = 1;
    for (let i = 0; i < n; i++) out[o + 1 + i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
  } else if (sUp <= sNone && prev) {
    out[o] = 2;
    for (let i = 0; i < n; i++) out[o + 1 + i] = (cur[i] - prev[i]) & 0xff;
  } else {
    out[o] = 0;
    out.set(cur, o + 1);
  }
}

export async function encodePng(src: StripSource, opts: { alpha: boolean; onProgress?: (f: number) => void } = { alpha: true }): Promise<Blob> {
  const { width: w, height: h } = src;
  const bpp = opts.alpha ? 4 : 3;
  const rowBytes = w * bpp;

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const compressed: Uint8Array[] = [];
  const reading = (async () => {
    const reader = cs.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      compressed.push(value);
    }
  })();

  let prev: Uint8ClampedArray | null = null;
  for (let y = 0; y < h; y += src.stripHeight) {
    const rows = Math.min(src.stripHeight, h - y);
    const rgba = await src.rows(y, rows);
    const buf = new Uint8Array(rows * (rowBytes + 1));
    for (let r = 0; r < rows; r++) {
      let cur: Uint8ClampedArray;
      if (bpp === 4) cur = rgba.subarray(r * w * 4, (r + 1) * w * 4);
      else {
        cur = new Uint8ClampedArray(rowBytes);
        const base = r * w * 4;
        for (let x = 0, j = 0; x < w; x++, j += 3) {
          cur[j] = rgba[base + x * 4];
          cur[j + 1] = rgba[base + x * 4 + 1];
          cur[j + 2] = rgba[base + x * 4 + 2];
        }
      }
      filterRow(cur, prev, bpp, buf, r * (rowBytes + 1));
      prev = bpp === 4 ? cur.slice() : cur;
    }
    await writer.write(buf);
    opts.onProgress?.(Math.min(1, (y + rows) / h));
  }
  await writer.close();
  await reading;

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opts.alpha ? 6 : 2; // RGBA or RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  // Re-chunk IDAT into ≤ 1 MiB pieces.
  const MAX = 1 << 20;
  let pending: Uint8Array[] = [];
  let pendingLen = 0;
  const flush = () => {
    if (!pendingLen) return;
    const data = new Uint8Array(pendingLen);
    let o = 0;
    for (const p of pending) (data.set(p, o), (o += p.length));
    parts.push(chunk('IDAT', data));
    pending = [];
    pendingLen = 0;
  };
  for (const c of compressed) {
    let off = 0;
    while (off < c.length) {
      const take = Math.min(MAX - pendingLen, c.length - off);
      pending.push(c.subarray(off, off + take));
      pendingLen += take;
      off += take;
      if (pendingLen >= MAX) flush();
    }
  }
  flush();
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}
