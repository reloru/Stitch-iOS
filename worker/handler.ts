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
