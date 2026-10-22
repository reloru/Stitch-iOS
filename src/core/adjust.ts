/**
 * Colour adjustments shared by the WebGL path (src/core/gl.ts) and the CPU fallback below.
 * The GLSL in gl.ts mirrors `adjustPixel` step for step; keep the two in sync.
 */

export interface Adjust {
  exposure: number; // -100..100  (±2 stops)
  brightness: number; // -100..100 (midtone gamma)
  contrast: number; // -100..100
  highlights: number; // -100..100
  shadows: number; // -100..100
  saturation: number; // -100..100
  vibrance: number; // -100..100
  warmth: number; // -100..100
  tint: number; // -100..100 (positive = magenta)
  fade: number; // 0..100
  sharpen: number; // 0..100
}

export type AdjustKey = keyof Adjust;

export const ADJUST_DEFAULTS: Adjust = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  saturation: 0,
  vibrance: 0,
  warmth: 0,
  tint: 0,
  fade: 0,
  sharpen: 0,
};

export const ADJUST_UI: { key: AdjustKey; name: string; min: number; max: number }[] = [
  { key: 'exposure', name: 'Exposure', min: -100, max: 100 },
  { key: 'brightness', name: 'Brightness', min: -100, max: 100 },
  { key: 'contrast', name: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', name: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', name: 'Shadows', min: -100, max: 100 },
  { key: 'saturation', name: 'Saturation', min: -100, max: 100 },
  { key: 'vibrance', name: 'Vibrance', min: -100, max: 100 },
  { key: 'warmth', name: 'Warmth', min: -100, max: 100 },
  { key: 'tint', name: 'Tint', min: -100, max: 100 },
  { key: 'fade', name: 'Fade', min: 0, max: 100 },
  { key: 'sharpen', name: 'Sharpen', min: 0, max: 100 },
];

/** A filter "look": a 3×4 colour matrix (rows r, g, b; last column is an offset in 0..1 units). */
export interface FilterDef {
  id: string;
  name: string;
  m: number[];
}

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function sat(s: number): number[] {
  const lr = 0.2126 * (1 - s);
  const lg = 0.7152 * (1 - s);
  const lb = 0.0722 * (1 - s);
  return [lr + s, lg, lb, 0, lr, lg + s, lb, 0, lr, lg, lb + s, 0];
}

/** Compose two 3×4 matrices: apply b, then a. */
function mm(a: number[], b: number[]): number[] {
  const o = new Array(12).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += a[r * 4 + k] * b[k * 4 + c];
      if (c === 3) v += a[r * 4 + 3];
      o[r * 4 + c] = v;
    }
  }
  return o;
}

function contrastM(k: number, pivot = 0.5): number[] {
  const off = pivot * (1 - k);
  return [k, 0, 0, off, 0, k, 0, off, 0, 0, k, off];
}

function scaleM(r: number, g: number, b: number, or = 0, og = 0, ob = 0): number[] {
  return [r, 0, 0, or, 0, g, 0, og, 0, 0, b, ob];
}

const MONO = sat(0);
const SEPIA = [0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131, 0];

export const FILTERS: FilterDef[] = [
  { id: 'none', name: 'Original', m: ID },
  { id: 'vivid', name: 'Vivid', m: mm(contrastM(1.12), sat(1.35)) },
  { id: 'warm', name: 'Warm', m: mm(scaleM(1.08, 1.0, 0.88, 0.02, 0.01, 0), sat(1.08)) },
  { id: 'cool', name: 'Cool', m: mm(scaleM(0.9, 1.0, 1.1, 0, 0.005, 0.03), sat(1.02)) },
  { id: 'dramatic', name: 'Dramatic', m: mm(contrastM(1.35), sat(0.8)) },
  { id: 'fade', name: 'Faded', m: mm(scaleM(0.82, 0.82, 0.84, 0.1, 0.1, 0.1), sat(0.75)) },
  { id: 'chrome', name: 'Chrome', m: mm(contrastM(1.18), mm(scaleM(1.0, 1.02, 1.06), sat(1.2))) },
  { id: 'mono', name: 'Mono', m: MONO },
  { id: 'noir', name: 'Noir', m: mm(contrastM(1.45), MONO) },
  { id: 'silver', name: 'Silver', m: mm(scaleM(0.9, 0.9, 0.92, 0.08, 0.08, 0.09), MONO) },
  { id: 'sepia', name: 'Sepia', m: SEPIA },
  { id: 'teal', name: 'Teal & Orange', m: mm([1.12, -0.04, -0.08, 0.0, -0.02, 1.02, 0.0, 0.0, -0.08, 0.04, 1.1, 0.02], sat(1.1)) },
];

export function filterById(id: string): FilterDef {
  return FILTERS.find((f) => f.id === id) ?? FILTERS[0];
}

export interface Look {
  filter: string;
  strength: number; // 0..100
}

export const LOOK_DEFAULT: Look = { filter: 'none', strength: 100 };

export function isIdentity(a: Adjust, look: Look): boolean {
  if (look.filter !== 'none' && look.strength > 0) return false;
  for (const k of Object.keys(ADJUST_DEFAULTS) as AdjustKey[]) if (a[k] !== ADJUST_DEFAULTS[k]) return false;
  return true;
}

/** Effective filter matrix after mixing with identity by strength. */
export function lookMatrix(look: Look): number[] {
  const f = filterById(look.filter).m;
  const t = Math.max(0, Math.min(1, look.strength / 100));
  return f.map((v, i) => ID[i] + (v - ID[i]) * t);
}

/** Uniform values derived from the UI ranges, shared by GL and CPU paths. */
export interface AdjustUniforms {
  m: number[];
  exposureMul: number;
  gamma: number;
  contrast: number;
  highlights: number;
  shadows: number;
  saturation: number;
  vibrance: number;
  warm: number;
  tint: number;
  fade: number;
  sharpen: number;
}

export function uniforms(a: Adjust, look: Look): AdjustUniforms {
  const c = a.contrast / 100;
  return {
    m: lookMatrix(look),
    exposureMul: Math.pow(2, (a.exposure / 100) * 2),
    gamma: Math.pow(2, (-a.brightness / 100) * 0.8),
    contrast: c >= 0 ? 1 + c * 1.2 : 1 + c * 0.8,
    highlights: (a.highlights / 100) * 0.35,
    shadows: (a.shadows / 100) * 0.35,
    saturation: 1 + a.saturation / 100,
    vibrance: a.vibrance / 100,
    warm: a.warmth / 100,
    tint: a.tint / 100,
    fade: a.fade / 100,
    sharpen: (a.sharpen / 100) * 1.5,
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Per-pixel colour pipeline on straight (non-premultiplied) 0..1 RGB. Sharpening is applied by the caller. */
export function adjustPixel(r: number, g: number, b: number, u: AdjustUniforms): [number, number, number] {
  const m = u.m;
  let R = m[0] * r + m[1] * g + m[2] * b + m[3];
  let G = m[4] * r + m[5] * g + m[6] * b + m[7];
  let B = m[8] * r + m[9] * g + m[10] * b + m[11];
  R = clamp01(R);
  G = clamp01(G);
  B = clamp01(B);

  // exposure in (approximately) linear light
  if (u.exposureMul !== 1) {
    R = Math.pow(Math.pow(R, 2.2) * u.exposureMul, 1 / 2.2);
    G = Math.pow(Math.pow(G, 2.2) * u.exposureMul, 1 / 2.2);
    B = Math.pow(Math.pow(B, 2.2) * u.exposureMul, 1 / 2.2);
    R = clamp01(R);
    G = clamp01(G);
    B = clamp01(B);
  }
  if (u.gamma !== 1) {
    R = Math.pow(R, u.gamma);
    G = Math.pow(G, u.gamma);
    B = Math.pow(B, u.gamma);
  }
  R = (R - 0.5) * u.contrast + 0.5;
  G = (G - 0.5) * u.contrast + 0.5;
  B = (B - 0.5) * u.contrast + 0.5;

  let l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const d = u.shadows * (1 - smoothstep(0, 0.55, l)) + u.highlights * smoothstep(0.45, 1, l);
  R += d;
  G += d;
  B += d;

  R *= 1 + 0.18 * u.warm;
  B *= 1 - 0.18 * u.warm;
  G *= 1 - 0.15 * u.tint;

  l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const mx = Math.max(R, G, B);
  const mn = Math.min(R, G, B);
  const vf = 1 + u.vibrance * (1 - clamp01(mx - mn)) * 1.2;
  const k = u.saturation * vf;
  R = l + (R - l) * k;
  G = l + (G - l) * k;
  B = l + (B - l) * k;

  if (u.fade > 0) {
    R += (R * 0.82 + 0.12 - R) * u.fade;
    G += (G * 0.82 + 0.12 - G) * u.fade;
    B += (B * 0.82 + 0.12 - B) * u.fade;
  }
  return [clamp01(R), clamp01(G), clamp01(B)];
}

/** CPU fallback for when WebGL is unavailable or the context was lost. Operates in place on RGBA bytes. */
export function adjustImageData(data: Uint8ClampedArray, w: number, h: number, a: Adjust, look: Look, sharpenTexel = 1): void {
  const u = uniforms(a, look);
  const src = u.sharpen > 0 ? new Uint8ClampedArray(data) : data;
  const st = Math.max(1, Math.round(sharpenTexel));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = src[i] / 255;
      let g = src[i + 1] / 255;
      let b = src[i + 2] / 255;
      if (u.sharpen > 0) {
        const xl = Math.max(0, x - st);
        const xr = Math.min(w - 1, x + st);
        const yu = Math.max(0, y - st);
        const yd = Math.min(h - 1, y + st);
        const n = [(y * w + xl) * 4, (y * w + xr) * 4, (yu * w + x) * 4, (yd * w + x) * 4];
        const avg = (o: number) => (src[n[0] + o] + src[n[1] + o] + src[n[2] + o] + src[n[3] + o]) / (4 * 255);
        r = clamp01(r + u.sharpen * (r - avg(0)));
        g = clamp01(g + u.sharpen * (g - avg(1)));
        b = clamp01(b + u.sharpen * (b - avg(2)));
      }
      const [R, G, B] = adjustPixel(r, g, b, u);
      data[i] = Math.round(R * 255);
      data[i + 1] = Math.round(G * 255);
      data[i + 2] = Math.round(B * 255);
    }
  }
}
