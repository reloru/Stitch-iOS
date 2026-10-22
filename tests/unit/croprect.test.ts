import { describe, it, expect } from 'vitest';
import { aspectRect, dragRect } from '../../src/core/croprect';

const none = { l: false, r: false, t: false, b: false };
const inside = (r: { x: number; y: number; w: number; h: number }, W: number, H: number) =>
  r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= W + 1e-9 && r.y + r.h <= H + 1e-9;

describe('crop rect drags', () => {
  it('moves and stays inside', () => {
    expect(dragRect({ x: 10, y: 10, w: 50, h: 50 }, none, 500, -500, 100, 100, null, 5)).toEqual({ x: 50, y: 0, w: 50, h: 50 });
  });
  it('drags an edge with a minimum size', () => {
    const r = dragRect({ x: 10, y: 10, w: 50, h: 50 }, { ...none, l: true }, 100, 0, 100, 100, null, 5);
    expect(r).toEqual({ x: 55, y: 10, w: 5, h: 50 });
  });
  it('keeps the aspect on a corner drag and anchors the opposite corner', () => {
    const r = dragRect({ x: 0, y: 0, w: 40, h: 40 }, { ...none, r: true, b: true }, 30, 5, 200, 100, 1, 5);
    expect(r.w).toBeCloseTo(r.h, 9);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBeCloseTo(70, 9);
  });
  it('shrinks instead of leaving the image when the aspect would overflow', () => {
    const r = dragRect({ x: 10, y: 10, w: 40, h: 40 }, { ...none, r: true }, 500, 0, 200, 100, 1, 5);
    expect(inside(r, 200, 100)).toBe(true);
    expect(r.w).toBeCloseTo(r.h, 9);
  });
  it('aspectRect is the largest box of that ratio', () => {
    expect(aspectRect(1, 200, 100)).toEqual({ x: 50, y: 0, w: 100, h: 100 });
    expect(aspectRect(4, 200, 100)).toEqual({ x: 0, y: 25, w: 200, h: 50 });
  });
});
