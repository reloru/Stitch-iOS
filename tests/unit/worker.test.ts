import { describe, it, expect } from 'vitest';
import { handleRemoveBg, MAX_BYTES, type RemoveBgDeps } from '../../worker/handler';

const URL_ = 'https://stitch.example.dev/api/remove-bg';
const okDeps = (calls: string[] = []): RemoveBgDeps => ({
  allow: async (k) => (calls.push('allow:' + k), true),
  segment: async (b) => (calls.push('segment:' + b.byteLength), new Uint8Array([137, 80, 78, 71]).buffer),
});

function req(init: { method?: string; origin?: string | null; type?: string; body?: Uint8Array<ArrayBuffer>; ip?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': init.type ?? 'image/jpeg', 'cf-connecting-ip': init.ip ?? '1.2.3.4' };
  if (init.origin !== null) headers.origin = init.origin ?? 'https://stitch.example.dev';
  const method = init.method ?? 'POST';
  return new Request(URL_, { method, headers, body: method === 'GET' ? undefined : new Blob([init.body ?? new Uint8Array([1, 2, 3])]) });
}

describe('remove-bg handler', () => {
  it('passes the image through to segmentation and returns PNG without caching', async () => {
    const calls: string[] = [];
    const r = await handleRemoveBg(req(), okDeps(calls));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual(['allow:remove-bg:1.2.3.4', 'segment:3']);
  });

  it('rejects wrong method, foreign or missing origin, and non-image types before doing work', async () => {
    const calls: string[] = [];
    expect((await handleRemoveBg(req({ method: 'GET' }), okDeps(calls))).status).toBe(405);
    expect((await handleRemoveBg(req({ origin: 'https://evil.example' }), okDeps(calls))).status).toBe(403);
    expect((await handleRemoveBg(req({ origin: null }), okDeps(calls))).status).toBe(403);
    expect((await handleRemoveBg(req({ type: 'text/html' }), okDeps(calls))).status).toBe(415);
    expect(calls).toEqual([]);
  });

  it('rejects empty and oversized bodies', async () => {
    expect((await handleRemoveBg(req({ body: new Uint8Array(0) }), okDeps())).status).toBe(400);
    expect((await handleRemoveBg(req({ body: new Uint8Array(MAX_BYTES + 1) }), okDeps())).status).toBe(413);
  });

  it('returns 429 when the rate limit is hit', async () => {
    const r = await handleRemoveBg(req(), { ...okDeps(), allow: async () => false });
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe('rate');
  });

  it('maps Images errors to friendly messages', async () => {
    const fail = (m: string): RemoveBgDeps => ({ ...okDeps(), segment: async () => Promise.reject(new Error(m)) });
    const quota = await handleRemoveBg(req(), fail('IMAGES_TRANSFORM_ERROR 9422: limit'));
    expect(quota.status).toBe(503);
    expect((await quota.json()).error).toBe('quota');
    expect((await handleRemoveBg(req(), fail('IMAGES_TRANSFORM_ERROR 9412: not an image'))).status).toBe(422);
    expect((await handleRemoveBg(req(), fail('boom'))).status).toBe(502);
  });
});
