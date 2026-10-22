import { describe, it, expect } from 'vitest';
import { ADJUST_DEFAULTS, adjustImageData, adjustPixel, FILTERS, isIdentity, LOOK_DEFAULT, uniforms } from '../../src/core/adjust';

const id = uniforms(ADJUST_DEFAULTS, LOOK_DEFAULT);

describe('adjustments', () => {
  it('defaults are an identity', () => {
    expect(isIdentity(ADJUST_DEFAULTS, LOOK_DEFAULT)).toBe(true);
    for (const v of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      const [r, g, b] = adjustPixel(v, 1 - v, v / 2, id);
      expect(r).toBeCloseTo(v, 6);
      expect(g).toBeCloseTo(1 - v, 6);
      expect(b).toBeCloseTo(v / 2, 6);
    }
  });

  it('exposure +100 doubles linear light twice (clamped)', () => {
    const u = uniforms({ ...ADJUST_DEFAULTS, exposure: 100 }, LOOK_DEFAULT);
    const v = 0.3;
    const expected = Math.min(1, Math.pow(Math.pow(v, 2.2) * 4, 1 / 2.2));
    expect(adjustPixel(v, v, v, u)[0]).toBeCloseTo(expected, 6);
  });

  it('saturation -100 and the mono filter give neutral grey', () => {
    const u = uniforms({ ...ADJUST_DEFAULTS, saturation: -100 }, LOOK_DEFAULT);
    const [r, g, b] = adjustPixel(0.8, 0.2, 0.4, u);
    expect(r).toBeCloseTo(g, 6);
    expect(g).toBeCloseTo(b, 6);
    const m = uniforms(ADJUST_DEFAULTS, { filter: 'mono', strength: 100 });
    const [r2, g2, b2] = adjustPixel(0.8, 0.2, 0.4, m);
    expect(r2).toBeCloseTo(g2, 6);
    expect(g2).toBeCloseTo(b2, 6);
  });

  it('contrast pushes values away from the midpoint; warmth shifts red/blue', () => {
    const u = uniforms({ ...ADJUST_DEFAULTS, contrast: 50 }, LOOK_DEFAULT);
    expect(adjustPixel(0.7, 0.7, 0.7, u)[0]).toBeGreaterThan(0.7);
    expect(adjustPixel(0.3, 0.3, 0.3, u)[0]).toBeLessThan(0.3);
    const w = uniforms({ ...ADJUST_DEFAULTS, warmth: 100 }, LOOK_DEFAULT);
    const [r, , b] = adjustPixel(0.5, 0.5, 0.5, w);
    expect(r).toBeGreaterThan(0.5);
    expect(b).toBeLessThan(0.5);
  });

  it('every filter keeps values in range and strength 0 is identity', () => {
    for (const f of FILTERS) {
      const u = uniforms(ADJUST_DEFAULTS, { filter: f.id, strength: 100 });
      for (const c of [0, 0.25, 0.5, 1]) for (const x of adjustPixel(c, 1 - c, c, u)) expect(x >= 0 && x <= 1).toBe(true);
      expect(isIdentity(ADJUST_DEFAULTS, { filter: f.id, strength: 0 })).toBe(true);
    }
  });

  it('CPU path leaves alpha untouched and sharpen increases local contrast', () => {
    const w = 3;
    const h = 1;
    const d = new Uint8ClampedArray([100, 100, 100, 255, 150, 150, 150, 128, 100, 100, 100, 255]);
    adjustImageData(d, w, h, { ...ADJUST_DEFAULTS, sharpen: 100 }, LOOK_DEFAULT);
    expect(d[7]).toBe(128);
    expect(d[4]).toBeGreaterThan(150);
  });
});
