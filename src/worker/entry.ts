import { handleTileRequest } from './tiles.js';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);

    if (url.pathname.startsWith('/tiles/')) {
      try {
        const resp = await handleTileRequest(request, env, ctx);
        if (resp) return resp;
      } catch (err) {
        console.error('Tile error:', err);
        return new Response('Tile fetch failed', { status: 500 });
      }
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;
    const spaResponse = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
    return spaResponse.status !== 404 ? spaResponse : new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
