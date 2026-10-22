import { describe, it, expect } from 'vitest';
import {
  apply,
  chain,
  constrainCrop,
  cropCorners,
  cropFits,
  deg,
  fitCrop,
  invert,
  largestCrop,
  maxCropScale,
  mul,
  pointInPoly,
  rotate,
  scale,
  translate,
} from '../../src/core/geometry';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('matrices', () => {
  it('composes right-to-left and inverts', () => {
    const m = chain(translate(10, 5), rotate(deg(30)), scale(2));
    const p = apply(m, { x: 3, y: -4 });
    const back = apply(invert(m), p);
    close(back.x, 3);
    close(back.y, -4);
    const manual = apply(translate(10, 5), apply(rotate(deg(30)), apply(scale(2), { x: 3, y: -4 })));
    close(p.x, manual.x);
    close(p.y, manual.y);
    expect(mul(translate(1, 2), translate(3, 4))).toEqual([1, 0, 0, 1, 4, 6]);
  });
});

describe('crop fitting', () => {
  const W = 4000;
  const H = 3000;
  it('full crop fits at angle 0 but not when straightened', () => {
    const full = { cx: W / 2, cy: H / 2, w: W, h: H };
    expect(cropFits(full, 0, W, H)).toBe(true);
    expect(cropFits(full, deg(5), W, H)).toBe(false);
  });

  it('fitCrop shrinks to the exact boundary', () => {
    const a = deg(10);
    const fitted = fitCrop({ cx: W / 2, cy: H / 2, w: W, h: H }, a, W, H);
    expect(cropFits(fitted, a, W, H)).toBe(true);
    expect(cropFits({ ...fitted, w: fitted.w * 1.001, h: fitted.h * 1.001 }, a, W, H)).toBe(false);
    close(fitted.w / fitted.h, W / H, 1e-9);
    // analytic: for a centred W×H box rotated by a inside W×H, scale = 1 / (cos a + (W/H) sin a) when W > H
    close(fitted.h, H / (Math.cos(a) + (W / H) * Math.sin(a)), 1e-6);
  });

  it('largestCrop respects aspect and fits', () => {
    const c = largestCrop(1, deg(-7), W, H);
    close(c.w, c.h);
    expect(cropFits(c, deg(-7), W, H)).toBe(true);
    expect(maxCropScale(c, deg(-7), W, H)).toBeCloseTo(1, 6);
  });

  it('constrainCrop stops at the edge', () => {
    const valid = { cx: 2000, cy: 1500, w: 1000, h: 1000 };
    const proposed = { cx: 5000, cy: 1500, w: 1000, h: 1000 };
    const r = constrainCrop(valid, proposed, 0, W, H);
    close(r.cx, 3500, 1e-2);
    expect(cropFits(r, 0, W, H)).toBe(true);
  });

  it('corners are in world space', () => {
    const cs = cropCorners({ cx: 100, cy: 100, w: 20, h: 10 }, 0);
    expect(cs[0]).toEqual({ x: 90, y: 95 });
    expect(pointInPoly({ x: 100, y: 100 }, cs)).toBe(true);
    expect(pointInPoly({ x: 120, y: 100 }, cs)).toBe(false);
  });
});
