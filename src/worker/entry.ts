import { handleApiRequest } from './api/runtime.js';
import { serveAsset } from './assets.js';
import { handleBuildDashboardRequest } from './build-dashboard.js';
import { handleTileRequest } from './tiles.js';

export { NorikaeApi } from './api/runtime.js';

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

    // The doc (/api/v1/doc.md) is a static asset, served before the Worker runs
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return handleApiRequest(request, env);

    // The build dashboard's page is a static asset; its data comes from the bucket
    if (url.pathname.startsWith('/build-dashboard/')) {
      const resp = await handleBuildDashboardRequest(request, env);
      if (resp) return resp;
    }

    if (url.pathname.startsWith('/tiles/')) {
      try {
        const resp = await handleTileRequest(request, env, ctx);
        if (resp) return resp;
      } catch (err) {
        console.error('Tile error:', err);
        return new Response('Tile fetch failed', { status: 500 });
      }
    }

    return serveAsset(request, env.ASSETS);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
