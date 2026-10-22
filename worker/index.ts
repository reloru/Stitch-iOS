import { handleRemoveBg } from './handler';

interface Env {
  IMAGES: ImagesBinding;
  REMOVE_BG_LIMIT: RateLimit;
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
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  },
} satisfies ExportedHandler<Env>;
