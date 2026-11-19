// Static assets from dist/, and the app's page for paths that are no file.
// Assets only answer GET and HEAD; anything else gets a 405 before the request
// reaches them. Scanners POST to /xmlrpc.php or /wp-json/batch/v1, and the
// page fetched for such a path used to copy the request's body, which looking
// for the asset had already read, so the Worker threw.
export async function serveAsset(request: Request, assets: Pick<Fetcher, 'fetch'>): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  }
  const asset = await assets.fetch(request);
  if (asset.status !== 404) return asset;
  const page = await assets.fetch(
    new Request(new URL('/', request.url), { method: request.method, headers: request.headers }),
  );
  return page.status !== 404 ? page : new Response('Not Found', { status: 404 });
}
