import { DurableObject } from 'cloudflare:workers';
import { handleInpaint, handleRemoveBg, InpaintFailure } from './handler';

/** Errors cross the Durable Object boundary as plain messages, so their kind travels as a prefix. */
const FAIL = { start: 'INPAINT_START', input: 'INPAINT_INPUT', model: 'INPAINT_MODEL' } as const;

function failureFrom(e: unknown): InpaintFailure {
  const msg = String((e as Error)?.message ?? e);
  for (const [kind, prefix] of Object.entries(FAIL)) if (msg.includes(prefix)) return new InpaintFailure(kind as InpaintFailure['kind'], msg);
  return new InpaintFailure('model', msg);
}

interface Env {
  IMAGES: ImagesBinding;
  REMOVE_BG_LIMIT: RateLimit;
  INPAINT_LIMIT: RateLimit;
  INPAINTER: DurableObjectNamespace<Inpainter>;
}

/** Stop the container this long after its last request (it holds 12 GiB while awake). */
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
/** Cold starts pull the image and load the model; give up after about this long. */
const READY_TIMEOUT_MS = 150 * 1000;

/**
 * Owns the object-removal container (LaMa on CPU, see container/). One named instance serves every request; the
 * model runs one inference at a time, which is plenty for one person's edits.
 */
export class Inpainter extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container!;
    // the timeout does not survive a Durable Object restart
    if (container.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
  }

  async inpaint(image: ArrayBuffer, mask: ArrayBuffer): Promise<ArrayBuffer> {
    this.starting ??= this.startAndWait().finally(() => {
      this.starting = undefined;
    });
    try {
      await this.starting;
    } catch (e) {
      console.error('inpaint container did not start', e);
      throw new Error(`${FAIL.start}: container did not start`);
    }
    const body = new Uint8Array(image.byteLength + mask.byteLength);
    body.set(new Uint8Array(image), 0);
    body.set(new Uint8Array(mask), image.byteLength);
    const res = await this.ctx.container!.getTcpPort(8080).fetch('http://container/inpaint', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-image-length': String(image.byteLength) },
      body,
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('inpaint failed', res.status, detail);
      throw new Error(`${res.status === 400 ? FAIL.input : FAIL.model}: ${detail}`);
    }
    return res.arrayBuffer();
  }

  private async startAndWait(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) container.start({ enableInternet: false });
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const port = container.getTcpPort(8080);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const r = await port.fetch('http://container/health', { signal: AbortSignal.timeout(2000) });
        await r.body?.cancel();
        if (r.ok) return;
        lastError = new Error(`health ${r.status}`);
      } catch (e) {
        lastError = e;
      }
      await scheduler.wait(500);
    }
    throw new Error('container did not become ready', { cause: lastError });
  }
}

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/remove-bg') {
      return handleRemoveBg(req, {
        allow: async (key) => (await env.REMOVE_BG_LIMIT.limit({ key })).success,
        segment: async (bytes) => {
          const stream = new Response(bytes).body!;
          const out = await env.IMAGES.input(stream).transform({ segment: 'foreground' }).output({ format: 'image/png' });
          return out.response().arrayBuffer();
        },
      });
    }
    if (pathname === '/api/inpaint') {
      return handleInpaint(req, {
        allow: async (key) => (await env.INPAINT_LIMIT.limit({ key })).success,
        inpaint: async (image, mask) => {
          try {
            return await env.INPAINTER.getByName('lama').inpaint(image, mask);
          } catch (e) {
            throw failureFrom(e);
          }
        },
      });
    }
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  },
} satisfies ExportedHandler<Env>;
