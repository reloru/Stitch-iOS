/** 2D affine matrix [a, b, c, d, e, f] mapping (x, y) -> (a*x + c*y + e, b*x + d*y + f) (same layout as DOMMatrix / canvas setTransform). */
export type Mat = [number, number, number, number, number, number];

export interface Pt {
  x: number;
  y: number;
}

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 ∘ m2: apply m2 first, then m1. */
export function mul(m1: Mat, m2: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function chain(...ms: Mat[]): Mat {
  return ms.reduce((acc, m) => mul(acc, m), IDENTITY);
}

export function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

export function apply(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotate(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

export const deg = (d: number) => (d * Math.PI) / 180;

/** Orientation of the base image: an exact quarter-turn/flip matrix from source pixels to "world" pixels. */
export interface Orientation {
  m: Mat;
  w: number;
  h: number;
}

export function orientIdentity(w: number, h: number): Orientation {
  return { m: IDENTITY, w, h };
}

/** World-space mapping for a clockwise quarter turn of a w×h world. */
export function rotCWMat(w: number, h: number): { m: Mat; w: number; h: number } {
  // (x, y) -> (h - y, x)
  void w;
  return { m: [0, 1, -1, 0, h, 0], w: h, h: w };
}

export function rotCCWMat(w: number, h: number): { m: Mat; w: number; h: number } {
  // (x, y) -> (y, w - x)
  return { m: [0, -1, 1, 0, 0, w], w: h, h: w };
}

export function flipHMat(w: number, h: number): { m: Mat; w: number; h: number } {
  return { m: [-1, 0, 0, 1, w, 0], w, h };
}

export function flipVMat(w: number, h: number): { m: Mat; w: number; h: number } {
  return { m: [1, 0, 0, -1, 0, h], w, h };
}

/** Crop rectangle: an axis-aligned w×h box in the straightened frame, centred on (cx, cy) in world coords. */
export interface Crop {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Corners of the crop box expressed in world coordinates (the image is rotated by `angleRad` under the box). */
export function cropCorners(crop: Crop, angleRad: number): Pt[] {
  const r = rotate(-angleRad);
  const hw = crop.w / 2;
  const hh = crop.h / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((p) => {
    const q = apply(r, p);
    return { x: q.x + crop.cx, y: q.y + crop.cy };
  });
}

const EPS = 1e-6;

export function cropFits(crop: Crop, angleRad: number, W: number, H: number): boolean {
  if (crop.w < 1 || crop.h < 1) return false;
  return cropCorners(crop, angleRad).every(
    (p) => p.x >= -EPS * W - 1e-6 && p.x <= W * (1 + EPS) + 1e-6 && p.y >= -EPS * H - 1e-6 && p.y <= H * (1 + EPS) + 1e-6,
  );
}

/** Largest factor s (≤ maxS) so that the crop scaled by s about its centre fits inside the W×H world. Centre must be inside. */
export function maxCropScale(crop: Crop, angleRad: number, W: number, H: number, maxS = Infinity): number {
  const r = rotate(-angleRad);
  let s = maxS;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const d = apply(r, { x: (sx * crop.w) / 2, y: (sy * crop.h) / 2 });
    if (d.x > 1e-9) s = Math.min(s, (W - crop.cx) / d.x);
    if (d.x < -1e-9) s = Math.min(s, crop.cx / -d.x);
    if (d.y > 1e-9) s = Math.min(s, (H - crop.cy) / d.y);
    if (d.y < -1e-9) s = Math.min(s, crop.cy / -d.y);
  }
  return Math.max(0, s);
}

/** Shrink (never grow) the crop about its centre until it fits; the centre is clamped into the world first. */
export function fitCrop(crop: Crop, angleRad: number, W: number, H: number): Crop {
  const c = { ...crop, cx: clamp(crop.cx, 0, W), cy: clamp(crop.cy, 0, H) };
  const s = maxCropScale(c, angleRad, W, H, 1);
  return { cx: c.cx, cy: c.cy, w: c.w * s, h: c.h * s };
}

/** Largest crop with the given aspect (w/h) centred at (cx, cy). */
export function largestCrop(aspect: number, angleRad: number, W: number, H: number, cx = W / 2, cy = H / 2): Crop {
  const unit: Crop = { cx, cy, w: aspect, h: 1 };
  const s = maxCropScale(unit, angleRad, W, H);
  return { cx, cy, w: aspect * s, h: s };
}

/**
 * Move from a valid crop towards a proposed one, stopping at the last valid point (binary search on the
 * straight-line interpolation). Keeps interactive drags glued to the image edge instead of jumping.
 */
export function constrainCrop(valid: Crop, proposed: Crop, angleRad: number, W: number, H: number): Crop {
  if (cropFits(proposed, angleRad, W, H)) return proposed;
  let lo = 0;
  let hi = 1;
  const lerp = (t: number): Crop => ({
    cx: valid.cx + (proposed.cx - valid.cx) * t,
    cy: valid.cy + (proposed.cy - valid.cy) * t,
    w: valid.w + (proposed.w - valid.w) * t,
    h: valid.h + (proposed.h - valid.h) * t,
  });
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cropFits(lerp(mid), angleRad, W, H)) lo = mid;
    else hi = mid;
  }
  return lerp(lo);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Decompose the rotation angle of a similarity transform. */
export function matAngle(m: Mat): number {
  return Math.atan2(m[1], m[0]);
}

export function matIsMirrored(m: Mat): boolean {
  return m[0] * m[3] - m[1] * m[2] < 0;
}

/** Point-in-convex-polygon (polygon in either winding). */
export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-12) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
