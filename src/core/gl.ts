import { adjustImageData, uniforms, type Adjust, type Look } from './adjust';
import { createCanvas, ctx2d } from './canvas';

const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Mirrors adjustPixel() in adjust.ts.
const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform mat3 u_m;
uniform vec3 u_off;
uniform float u_exposure, u_gamma, u_contrast, u_highlights, u_shadows, u_saturation, u_vibrance, u_warm, u_tint, u_fade, u_sharpen;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec4 src = texture(u_tex, v_uv);
  vec3 c = src.rgb;
  if (u_sharpen > 0.0) {
    vec3 n = texture(u_tex, v_uv + vec2(u_texel.x, 0.0)).rgb + texture(u_tex, v_uv - vec2(u_texel.x, 0.0)).rgb
           + texture(u_tex, v_uv + vec2(0.0, u_texel.y)).rgb + texture(u_tex, v_uv - vec2(0.0, u_texel.y)).rgb;
    c = clamp(c + u_sharpen * (c - n * 0.25), 0.0, 1.0);
  }
  c = clamp(u_m * c + u_off, 0.0, 1.0);
  if (u_exposure != 1.0) c = clamp(pow(pow(c, vec3(2.2)) * u_exposure, vec3(1.0 / 2.2)), 0.0, 1.0);
  if (u_gamma != 1.0) c = pow(c, vec3(u_gamma));
  c = (c - 0.5) * u_contrast + 0.5;
  float l = dot(c, LUMA);
  c += u_shadows * (1.0 - smoothstep(0.0, 0.55, l)) + u_highlights * smoothstep(0.45, 1.0, l);
  c.r *= 1.0 + 0.18 * u_warm;
  c.b *= 1.0 - 0.18 * u_warm;
  c.g *= 1.0 - 0.15 * u_tint;
  l = dot(c, LUMA);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float vf = 1.0 + u_vibrance * (1.0 - clamp(mx - mn, 0.0, 1.0)) * 1.2;
  c = l + (c - l) * (u_saturation * vf);
  if (u_fade > 0.0) c += (c * 0.82 + 0.12 - c) * u_fade;
  c = clamp(c, 0.0, 1.0);
  outColor = vec4(c * src.a, src.a);
}`;

type Src = HTMLCanvasElement | HTMLImageElement | ImageBitmap | OffscreenCanvas;

function dims(s: Src): [number, number] {
  if (s instanceof HTMLImageElement) return [s.naturalWidth, s.naturalHeight];
  return [s.width, s.height];
}

class GLAdjuster {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext | null = null;
  prog: WebGLProgram | null = null;
  tex: WebGLTexture | null = null;
  texSrc: Src | null = null;
  loc: Record<string, WebGLUniformLocation | null> = {};
  maxTex = 4096;
  lost = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.texSrc = null;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
    });
    this.init();
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(p, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    for (const n of [
      'u_tex',
      'u_texel',
      'u_m',
      'u_off',
      'u_exposure',
      'u_gamma',
      'u_contrast',
      'u_highlights',
      'u_shadows',
      'u_saturation',
      'u_vibrance',
      'u_warm',
      'u_tint',
      'u_fade',
      'u_sharpen',
    ])
      this.loc[n] = gl.getUniformLocation(p, n);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 16384);
    this.gl = gl;
    this.prog = p;
    this.texSrc = null;
  }

  get ok() {
    return !!this.gl && !this.lost && !this.gl.isContextLost();
  }

  /** Renders `src` with the adjustments into the shared GL canvas and returns it. Copy it before the next call. */
  render(src: Src, a: Adjust, look: Look, sharpenTexel: number): HTMLCanvasElement {
    const gl = this.gl!;
    const [w, h] = dims(src);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.texSrc !== src) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      this.texSrc = src;
    }
    const u = uniforms(a, look);
    const m = u.m;
    // column-major mat3 from the row-major 3×4 matrix
    gl.uniformMatrix3fv(this.loc.u_m, false, [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]);
    gl.uniform3f(this.loc.u_off, m[3], m[7], m[11]);
    gl.uniform1i(this.loc.u_tex, 0);
    gl.uniform2f(this.loc.u_texel, sharpenTexel / w, sharpenTexel / h);
    gl.uniform1f(this.loc.u_exposure, u.exposureMul);
    gl.uniform1f(this.loc.u_gamma, u.gamma);
    gl.uniform1f(this.loc.u_contrast, u.contrast);
    gl.uniform1f(this.loc.u_highlights, u.highlights);
    gl.uniform1f(this.loc.u_shadows, u.shadows);
    gl.uniform1f(this.loc.u_saturation, u.saturation);
    gl.uniform1f(this.loc.u_vibrance, u.vibrance);
    gl.uniform1f(this.loc.u_warm, u.warm);
    gl.uniform1f(this.loc.u_tint, u.tint);
    gl.uniform1f(this.loc.u_fade, u.fade);
    gl.uniform1f(this.loc.u_sharpen, u.sharpen);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }

  /** Drop the uploaded texture (frees GPU memory after a full-resolution export). */
  release() {
    if (!this.ok) return;
    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texSrc = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

let shared: GLAdjuster | null = null;
let glFailed = false;

type Hooks = { __stitchForceCPU?: boolean; __stitchGL?: boolean };

function adjuster(): GLAdjuster | null {
  if (glFailed) return null;
  if (!shared) {
    // Test hook: e2e tests force the CPU path to compare it with the shader.
    if ((globalThis as Hooks).__stitchForceCPU) {
      glFailed = true;
      return null;
    }
    try {
      shared = new GLAdjuster();
      if (!shared.gl) {
        glFailed = true;
        shared = null;
      } else (globalThis as Hooks).__stitchGL = true;
    } catch (e) {
      console.warn('WebGL adjustments unavailable, using CPU fallback', e);
      glFailed = true;
      shared = null;
    }
  }
  return shared && shared.ok ? shared : null;
}

export function glAvailable(): boolean {
  return adjuster() !== null;
}

export function releaseGL() {
  shared?.release();
}

/**
 * Returns a new 2D canvas containing `src` with adjustments applied, at the source's size.
 * `sharpenTexel` is the sharpen sample offset in source pixels (smaller sources use < 1 so the
 * preview matches the full-resolution result roughly).
 */
export function renderAdjusted(src: Src, a: Adjust, look: Look, sharpenTexel = 1, into?: HTMLCanvasElement): HTMLCanvasElement {
  const [w, h] = dims(src);
  const out = into ?? createCanvas(w, h);
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  const ctx = ctx2d(out);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  const gl = adjuster();
  if (gl && w <= gl.maxTex && h <= gl.maxTex) {
    try {
      ctx.drawImage(gl.render(src, a, look, sharpenTexel), 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      return out;
    } catch {
      /* fall through to CPU */
    }
  }
  ctx.drawImage(src as CanvasImageSource, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const id = ctx.getImageData(0, 0, w, h);
  adjustImageData(id.data, w, h, a, look, sharpenTexel);
  ctx.putImageData(id, 0, 0);
  return out;
}
