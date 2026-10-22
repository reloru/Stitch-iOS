import { describe, it, expect } from 'vitest';
import { clampTrim, computeLayout, hitItem, NO_TRIM, STITCH_DEFAULTS } from '../../src/core/stitch';

describe('stitch layout', () => {
  it('vertical: common width, stacked with gap and padding', () => {
    const l = computeLayout(
      [
        { w: 1000, h: 500, trim: NO_TRIM },
        { w: 500, h: 500, trim: { ...NO_TRIM, top: 100 } },
      ],
      { ...STITCH_DEFAULTS, gap: 10, padding: 5 },
    );
    expect(l.width).toBe(1010);
    expect(l.placed[0]).toMatchObject({ dx: 5, dy: 5, dw: 1000, dh: 500 });
    expect(l.placed[1]).toMatchObject({ sy: 100, sh: 400, dy: 515, dw: 1000, dh: 800 });
    expect(l.height).toBe(5 + 500 + 10 + 800 + 5);
    expect(hitItem(l, 50, 600)).toBe(1);
    expect(hitItem(l, 50, 510)).toBe(-1);
  });

  it('horizontal: common height', () => {
    const l = computeLayout(
      [
        { w: 400, h: 300, trim: NO_TRIM },
        { w: 300, h: 600, trim: NO_TRIM },
      ],
      { ...STITCH_DEFAULTS, layout: 'horizontal' },
    );
    expect(l.height).toBe(600);
    expect(l.placed[0]).toMatchObject({ dw: 800, dh: 600, dx: 0 });
    expect(l.placed[1]).toMatchObject({ dw: 300, dx: 800 });
    expect(l.width).toBe(1100);
  });

  it('grid: covers square cells with centre crop', () => {
    const l = computeLayout(
      [
        { w: 400, h: 200, trim: NO_TRIM },
        { w: 200, h: 400, trim: NO_TRIM },
        { w: 300, h: 300, trim: NO_TRIM },
      ],
      { ...STITCH_DEFAULTS, layout: 'grid', columns: 2, cellAspect: 1, gap: 4 },
    );
    expect(l.width).toBe(400 * 2 + 4);
    expect(l.height).toBe(400 * 2 + 4);
    expect(l.placed[0]).toMatchObject({ sx: 100, sy: 0, sw: 200, sh: 200 });
    expect(l.placed[1]).toMatchObject({ sx: 0, sy: 100, sw: 200, sh: 200, dx: 404 });
    expect(l.placed[2]).toMatchObject({ dx: 0, dy: 404 });
  });

  it('clampTrim keeps a minimum strip', () => {
    const t = clampTrim({ top: 600, bottom: 600, left: -5, right: 0 }, 100, 1000, 16);
    expect(t.left).toBe(0);
    expect(t.top + t.bottom).toBe(1000 - 16);
  });
});
