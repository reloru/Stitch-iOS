import { describe, it, expect } from 'vitest';
import { flipH, flipV, newDoc, newTextLayer, placementMat, rotateCCW, rotateCW, setAngle, setAspect, worldToOutput, type Doc } from '../../src/core/doc';
import { apply, chain, cropFits, deg, type Mat } from '../../src/core/geometry';
import type { SourceImage } from '../../src/core/source';

const src = { id: 's', name: 'p', width: 400, height: 300 } as unknown as SourceImage;
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Where a source pixel of the base ends up in output space. */
const baseToOut = (d: Doc): Mat => chain(worldToOutput(d.geo), d.geo.orient);

function withLayer(d: Doc): Doc {
  const t = newTextLayer(d);
  return { ...d, layers: [{ ...t, t: { ...t.t, x: 300, y: 50, rotation: deg(20) } }] };
}

/** Output-space position of a point fixed on the layer (its local (5,0) offset from centre). */
function layerPointOut(d: Doc): { x: number; y: number } {
  const l = d.layers[0];
  const m = chain(worldToOutput(d.geo), placementMat(l.t, 10, 10));
  return apply(m, { x: 10, y: 5 });
}

describe('orientation ops', () => {
  it('rotateCW swaps world size and maps corners', () => {
    const d = rotateCW(newDoc(src));
    expect(d.geo.worldW).toBe(300);
    expect(d.geo.worldH).toBe(400);
    // source top-left (0,0) goes to world top-right (300, 0)
    const p = apply(d.geo.orient, { x: 0, y: 0 });
    close(p.x, 300);
    close(p.y, 0);
    expect(d.geo.crop.w).toBe(300);
    expect(d.geo.crop.h).toBe(400);
  });

  it('four CW rotations and CW+CCW are identities', () => {
    let d = newDoc(src);
    for (let i = 0; i < 4; i++) d = rotateCW(d);
    expect(d.geo.orient.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0, 1, 0, 0]);
    const e = rotateCCW(rotateCW(newDoc(src)));
    expect(e.geo.orient.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('flips mirror the base and keep layers attached to the image', () => {
    for (const op of [flipH, flipV, rotateCW]) {
      const d0 = withLayer(newDoc(src));
      const d1 = op(d0);
      // The layer point, expressed in base-source coordinates, must not change.
      const toSrc = (d: Doc) => {
        const out = layerPointOut(d);
        const inv = baseToOut(d);
        // solve inv * s = out
        const det = inv[0] * inv[3] - inv[1] * inv[2];
        const x = out.x - inv[4];
        const y = out.y - inv[5];
        return { x: (inv[3] * x - inv[2] * y) / det, y: (-inv[1] * x + inv[0] * y) / det };
      };
      const a = toSrc(d0);
      const b = toSrc(d1);
      close(a.x, b.x, 1e-6);
      close(a.y, b.y, 1e-6);
    }
  });

  it('straightening shrinks the crop to fit; aspect presets fit', () => {
    const d = setAngle(newDoc(src), 12);
    expect(cropFits(d.geo.crop, deg(12), d.geo.worldW, d.geo.worldH)).toBe(true);
    expect(d.geo.crop.w).toBeLessThan(400);
    const sq = setAspect(d, 1);
    close(sq.geo.crop.w, sq.geo.crop.h, 1e-6);
    expect(cropFits(sq.geo.crop, deg(12), 400, 300)).toBe(true);
  });
});
