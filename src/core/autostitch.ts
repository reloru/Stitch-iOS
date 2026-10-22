/**
 * Automatic overlap detection for scrolling screenshots (pure; runs on luminance arrays).
 *
 * For consecutive screenshots A and B of the same screen size:
 *  1. header = rows identical at the top of both (status bar, nav bar), footer = identical rows at the bottom.
 *  2. Find the scroll distance D such that B's content row y equals A's content row y + D, using only rows of B
 *     that carry vertical detail (flat rows match anything and would make blank areas false-match).
 *  3. Trims: A keeps rows [.., h - footer), B starts at row (h - footer - D).
 */

export interface Gray {
  w: number;
  h: number;
  data: Uint8Array;
}

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (rgba[j] * 54 + rgba[j + 1] * 183 + rgba[j + 2] * 19) >> 8;
  return { w, h, data };
}

const COLS = 32;

/** Per-row signature: mean luminance of COLS horizontal buckets. */
export function signatures(g: Gray): Float32Array {
  const sig = new Float32Array(g.h * COLS);
  const bw = g.w / COLS;
  for (let y = 0; y < g.h; y++) {
    const row = y * g.w;
    for (let c = 0; c < COLS; c++) {
      const x0 = Math.floor(c * bw);
      const x1 = Math.max(x0 + 1, Math.floor((c + 1) * bw));
      let s = 0;
      for (let x = x0; x < x1; x++) s += g.data[row + x];
      sig[y * COLS + c] = s / (x1 - x0);
    }
  }
  return sig;
}

function rowDiff(a: Float32Array, ra: number, b: Float32Array, rb: number): number {
  let s = 0;
  const oa = ra * COLS;
  const ob = rb * COLS;
  for (let c = 0; c < COLS; c++) s += Math.abs(a[oa + c] - b[ob + c]);
  return s / COLS;
}

export interface PairResult {
  header: number;
  footer: number;
  /** scroll distance D in px (B row y == A row y + D) */
  shift: number;
  found: boolean;
  score: number;
}

const SAME = 1.5;

export function analyzePair(a: Gray, b: Gray): PairResult {
  if (a.w !== b.w) return { header: 0, footer: 0, shift: 0, found: false, score: Infinity };
  const sa = signatures(a);
  const sb = signatures(b);
  const minH = Math.min(a.h, b.h);
  const cap = Math.floor(minH * 0.45);

  let header = 0;
  while (header < cap && rowDiff(sa, header, sb, header) < SAME) header++;
  let footer = 0;
  while (footer < cap && rowDiff(sa, a.h - 1 - footer, sb, b.h - 1 - footer) < SAME) footer++;

  const aEnd = a.h - footer; // exclusive
  const bEnd = b.h - footer;
  const contentA = aEnd - header;
  const contentB = bEnd - header;
  const minOverlap = Math.max(24, Math.round(minH * 0.03));
  if (contentA < minOverlap || contentB < minOverlap) return { header, footer, shift: 0, found: false, score: Infinity };

  // edges in B (relative to header): row j differs from row j + 1. Each edge is scored as the pair (j, j + 1),
  // so a shifted comparison cannot match by pairing a flat row with another flat row.
  const informative: number[] = [];
  for (let j = 0; j < contentB - 1; j++) {
    const y = header + j;
    if (rowDiff(sb, y, sb, y + 1) > 2.5) informative.push(j);
  }
  const edgeDiff = (d: number, j: number) =>
    (rowDiff(sa, header + d + j, sb, header + j) + rowDiff(sa, header + d + j + 1, sb, header + j + 1)) / 2;

  let best = Infinity;
  let bestD = -1;
  for (let d = 1; d <= contentA - minOverlap; d++) {
    const L = Math.min(contentA - d, contentB);
    // informative rows inside the overlap [0, L)
    let count = 0;
    let sum = 0;
    const step = Math.max(1, Math.floor(informative.length / 400));
    for (let k = 0; k < informative.length; k += step) {
      const j = informative[k];
      if (j + 1 >= L) break;
      sum += edgeDiff(d, j);
      count++;
      if (sum / count > best * 4 + 20 && count > 8) break; // hopeless, bail early
    }
    if (count < 6) continue;
    const score = sum / count;
    if (score < best - 1e-6) {
      best = score;
      bestD = d;
    }
  }
  if (bestD < 0) return { header, footer, shift: 0, found: false, score: Infinity };

  // exact score on every informative row for the winner
  const L = Math.min(contentA - bestD, contentB);
  let sum = 0;
  let count = 0;
  for (const j of informative) {
    if (j + 1 >= L) break;
    sum += edgeDiff(bestD, j);
    count++;
  }
  const score = count ? sum / count : Infinity;
  return { header, footer, shift: bestD, found: count >= 6 && score < 6, score };
}

export interface AutoTrim {
  top: number;
  bottom: number;
}

/**
 * Computes top/bottom trims for a sequence of screenshots. Returns one entry per image plus the indices of
 * pairs where no overlap was found (those still get the repeated header/footer removed).
 */
export function autoTrims(images: Gray[]): { trims: AutoTrim[]; failed: number[] } {
  const trims: AutoTrim[] = images.map(() => ({ top: 0, bottom: 0 }));
  const failed: number[] = [];
  for (let i = 0; i + 1 < images.length; i++) {
    const a = images[i];
    const b = images[i + 1];
    const r = analyzePair(a, b);
    trims[i].bottom = r.footer;
    if (r.found) trims[i + 1].top = a.h - r.footer - r.shift;
    else {
      trims[i + 1].top = r.header;
      failed.push(i);
    }
  }
  return { trims, failed };
}
