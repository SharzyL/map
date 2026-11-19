import { describe, expect, it } from 'vitest';
import { serveAsset } from './assets.js';

// Assets holding the app's page and one file, reading each request's body as
// the real binding may
function assets() {
  const fetched: string[] = [];
  const binding = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      await request.arrayBuffer();
      const { pathname } = new URL(request.url);
      fetched.push(`${request.method} ${pathname}`);
      if (pathname === '/') return new Response('page');
      if (pathname === '/app.js') return new Response('script');
      return new Response('nothing here', { status: 404 });
    },
  };
  return { binding, fetched };
}

describe('serveAsset', () => {
  it('serves a file, and the page for paths that are no file', async () => {
    const { binding } = assets();
    expect(await (await serveAsset(new Request('https://map.test/app.js'), binding)).text()).toBe('script');
    const page = await serveAsset(new Request('https://map.test/some/view'), binding);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('page');
  });

  it('turns other methods away before reading their body', async () => {
    const { binding, fetched } = assets();
    for (const path of ['/xmlrpc.php', '/wp-json/batch/v1', '/']) {
      const request = new Request(`https://map.test${path}`, { method: 'POST', body: '<?xml version="1.0"?>' });
      const response = await serveAsset(request, binding);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
      expect(request.bodyUsed).toBe(false);
    }
    expect(fetched).toEqual([]);
  });

  it('answers HEAD for the page too', async () => {
    const { binding, fetched } = assets();
    const response = await serveAsset(new Request('https://map.test/wp-login.php', { method: 'HEAD' }), binding);
    expect(response.status).toBe(200);
    expect(fetched).toEqual(['HEAD /wp-login.php', 'HEAD /']);
  });
});
