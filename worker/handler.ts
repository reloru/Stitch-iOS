/**
 * POST /api/remove-bg — returns a PNG whose alpha channel isolates the photo's subject.
 * Pure request handling; the Cloudflare bindings are injected so this runs in unit tests under Node.
 */

export interface RemoveBgDeps {
  /** Runs background removal on image bytes and returns PNG bytes. Throws on failure. */
  segment(image: ArrayBuffer): Promise<ArrayBuffer>;
  /** true if the caller is within its rate limit */
  allow(key: string): Promise<boolean>;
}

export const MAX_BYTES = 8 * 1024 * 1024;

function json(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function handleRemoveBg(req: Request, deps: RemoveBgDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, 'method', 'Use POST');
  const origin = req.headers.get('origin');
  if (!origin || origin !== new URL(req.url).origin) return json(403, 'origin', 'Not allowed from this site');
  const type = req.headers.get('content-type') ?? '';
  if (!/^image\/(jpeg|png|webp)$/i.test(type.split(';')[0].trim())) return json(415, 'type', 'Send a JPEG, PNG or WebP image');
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) return json(413, 'size', 'Image is too large');

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await deps.allow(`remove-bg:${ip}`))) return json(429, 'rate', 'Too many requests — try again in a minute');

  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return json(400, 'empty', 'No image received');
  if (body.byteLength > MAX_BYTES) return json(413, 'size', 'Image is too large');

  try {
    const png = await deps.segment(body);
    return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes('9422')) return json(503, 'quota', 'The monthly background-removal limit has been reached');
    if (/94(12|20|23)/.test(msg)) return json(422, 'image', 'This image could not be processed');
    return json(502, 'upstream', 'Background removal failed — try again');
  }
}

/**
 * POST /api/inpaint — object removal. multipart/form-data with `image` (PNG/JPEG, the area around the object,
 * longest side ≤ 512) and `mask` (PNG, non-zero over the object). Returns an RGBA PNG to composite over the area.
 */
export interface InpaintDeps {
  /** Runs the model; resolves with PNG bytes or rejects with an InpaintFailure. */
  inpaint(image: ArrayBuffer, mask: ArrayBuffer): Promise<ArrayBuffer>;
  allow(key: string): Promise<boolean>;
}

/** Why the container could not produce a result: it did not start, or it rejected/failed the request. */
export class InpaintFailure extends Error {
  constructor(
    readonly kind: 'start' | 'input' | 'model',
    message: string,
  ) {
    super(message);
  }
}

export const INPAINT_MAX_IMAGE = 3 * 1024 * 1024;
export const INPAINT_MAX_MASK = 1024 * 1024;

export async function handleInpaint(req: Request, deps: InpaintDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, 'method', 'Use POST');
  const origin = req.headers.get('origin');
  if (!origin || origin !== new URL(req.url).origin) return json(403, 'origin', 'Not allowed from this site');
  if (!/^multipart\/form-data/i.test(req.headers.get('content-type') ?? '')) return json(415, 'type', 'Send multipart form data');
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > INPAINT_MAX_IMAGE + INPAINT_MAX_MASK + 64 * 1024) return json(413, 'size', 'Image is too large');

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await deps.allow(`inpaint:${ip}`))) return json(429, 'rate', 'Too many requests — try again in a minute');

  let image: unknown;
  let mask: unknown;
  try {
    const form = await req.formData();
    image = form.get('image');
    mask = form.get('mask');
  } catch {
    return json(400, 'form', 'Could not read the upload');
  }
  if (!(image instanceof File) || !(mask instanceof File)) return json(400, 'form', 'Send an image and a mask');
  if (!/^image\/(png|jpeg)$/i.test(image.type) || !/^image\/png$/i.test(mask.type)) return json(415, 'type', 'Send a PNG or JPEG image and a PNG mask');
  if (image.size === 0 || mask.size === 0) return json(400, 'empty', 'No image received');
  if (image.size > INPAINT_MAX_IMAGE || mask.size > INPAINT_MAX_MASK) return json(413, 'size', 'Image is too large');

  try {
    const png = await deps.inpaint(await image.arrayBuffer(), await mask.arrayBuffer());
    return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  } catch (e) {
    const kind = e instanceof InpaintFailure ? e.kind : 'model';
    if (kind === 'start') return json(503, 'starting', 'The eraser is still starting up — try again in a moment');
    if (kind === 'input') return json(422, 'image', 'This area could not be processed');
    return json(502, 'upstream', 'Removing the object failed — try again');
  }
}
