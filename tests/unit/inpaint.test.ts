import { describe, expect, it } from 'vitest';
import { alphaBounds, MODEL_SIZE, planCrop } from '../../src/core/inpaint';

describe('alphaBounds', () => {
  it('finds the painted area and ignores faint brush noise', () => {
    const w = 10;
    const a = new Uint8Array(w * 6);
    a[2 * w + 3] = 255;
    a[4 * w + 7] = 40;
    a[5 * w + 9] = 5; // below the threshold
    expect(alphaBounds(a, w, 6)).toEqual({ x0: 3, y0: 2, x1: 8, y1: 5 });
    expect(alphaBounds(new Uint8Array(60), w, 6)).toBeNull();
  });
});

describe('planCrop', () => {
  it('sends a small object with a 512 px square around it at native resolution', () => {
    const c = planCrop({ x0: 1000, y0: 800, x1: 1200, y1: 950 }, 4032, 3024);
    expect([c.w, c.h, c.sendW, c.sendH]).toEqual([512, 512, 512, 512]);
    // centred on the object
    expect(c.x + c.w / 2).toBeCloseTo(1100, 0);
    expect(c.y + c.h / 2).toBeCloseTo(875, 0);
  });

  it('scales a large object down to the model size with a margin around it', () => {
    const c = planCrop({ x0: 1000, y0: 500, x1: 2200, y1: 2500 }, 4032, 3024);
    expect(c.w).toBe(c.h);
    expect(c.w).toBeGreaterThanOrEqual(2000 + 2 * 400);
    expect(Math.max(c.sendW, c.sendH)).toBe(MODEL_SIZE);
    expect(c.x).toBeLessThanOrEqual(1000);
    expect(c.x + c.w).toBeGreaterThanOrEqual(2200);
  });

  it('shifts the square inside the image at the edges', () => {
    const c = planCrop({ x0: 0, y0: 2950, x1: 60, y1: 3024 }, 4032, 3024);
    expect(c.x).toBe(0);
    expect(c.y + c.h).toBe(3024);
    expect(c.y).toBeGreaterThanOrEqual(0);
  });

  it('uses a small image whole', () => {
    const c = planCrop({ x0: 100, y0: 50, x1: 150, y1: 90 }, 300, 200);
    expect(c).toEqual({ x: 0, y: 0, w: 300, h: 200, sendW: 300, sendH: 200 });
  });
});
