import { describe, it, expect } from 'vitest';
import { analyzePair, autoTrims, type Gray } from '../../src/core/autostitch';

const W = 180;

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** A tall "page": text-like rows of random blocks, with some blank bands. */
function page(h: number, blankBands: [number, number][] = []): Uint8Array {
  const r = rng(42);
  const d = new Uint8Array(W * h).fill(245);
  for (let y = 0; y < h; y += 14) {
    if (blankBands.some(([a, b]) => y >= a && y < b)) continue;
    let x = 8;
    while (x < W - 20) {
      const len = 6 + Math.floor(r() * 30);
      const shade = 20 + Math.floor(r() * 80);
      for (let yy = y + 3; yy < Math.min(h, y + 11); yy++) for (let xx = x; xx < Math.min(W - 8, x + len); xx++) d[yy * W + xx] = shade;
      x += len + 4 + Math.floor(r() * 10);
    }
  }
  return d;
}

function band(h: number, value: number, stripe = false): Uint8Array {
  const d = new Uint8Array(W * h).fill(value);
  if (stripe) for (let x = 0; x < W; x += 9) for (let y = 0; y < h; y++) d[y * W + x] = 255 - value;
  return d;
}

/** Screenshot = header + page[off, off + contentH) + footer. */
function shot(p: Uint8Array, off: number, contentH: number, header: Uint8Array, footer: Uint8Array): Gray {
  const hh = header.length / W;
  const fh = footer.length / W;
  const h = hh + contentH + fh;
  const data = new Uint8Array(W * h);
  data.set(header, 0);
  data.set(p.subarray(off * W, (off + contentH) * W), hh * W);
  data.set(footer, (hh + contentH) * W);
  return { w: W, h, data };
}

/** Rebuild the stitched image from trims and compare with the original page. */
function stitched(images: Gray[], trims: { top: number; bottom: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  images.forEach((g, i) => parts.push(g.data.subarray(trims[i].top * W, (g.h - trims[i].bottom) * W)));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

describe('auto stitch', () => {
  const header = band(60, 30, true);
  const footer = band(50, 200, true);
  const content = 690;

  it('finds header, footer and scroll distance', () => {
    const p = page(3000);
    const a = shot(p, 0, content, header, footer);
    const b = shot(p, 500, content, header, footer);
    const r = analyzePair(a, b);
    expect(r.found).toBe(true);
    // coincidentally identical blank rows may extend the header slightly; trims stay exact (next test)
    expect(r.header).toBeGreaterThanOrEqual(60);
    expect(r.header).toBeLessThan(70);
    expect(r.footer).toBe(50);
    expect(r.shift).toBe(500);
  });

  it('reconstructs the page exactly from three screenshots', () => {
    const p = page(3000, [[900, 980]]);
    const offs = [0, 500, 1100];
    const imgs = offs.map((o) => shot(p, o, content, header, footer));
    const { trims, failed } = autoTrims(imgs);
    expect(failed).toEqual([]);
    const out = stitched(imgs, trims);
    const expected = new Uint8Array([...header, ...p.subarray(0, (1100 + content) * W), ...footer]);
    expect(out.length).toBe(expected.length);
    expect(Buffer.from(out).equals(Buffer.from(expected))).toBe(true);
  });

  it('does not false-match when the overlap is blank', () => {
    const p = page(3000, [[400, 1200]]);
    // overlap region (rows 500..690 of the page) is entirely blank
    const a = shot(p, 0, content, header, footer);
    const b = shot(p, 500, content, header, footer);
    const r = analyzePair(a, b);
    expect(r.found).toBe(false);
    const { trims, failed } = autoTrims([a, b]);
    expect(failed).toEqual([0]);
    expect(trims[1].top).toBeGreaterThanOrEqual(60); // repeated header still removed
    expect(trims[1].top).toBeLessThan(70);
    // identical blank rows above the footer count as footer here; only whitespace is affected
    expect(trims[0].bottom).toBeGreaterThanOrEqual(50);
  });

  it('rejects different widths', () => {
    const r = analyzePair({ w: 10, h: 10, data: new Uint8Array(100) }, { w: 12, h: 10, data: new Uint8Array(120) });
    expect(r.found).toBe(false);
  });
});
