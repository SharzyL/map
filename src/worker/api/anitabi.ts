// anitabi's anime pilgrimage spots (/api/v1/anitabi/*), passed through from
// www.anitabi.cn, which sends no CORS headers, so the map cannot read its files
// itself. The files are what anitabi's own map loads (src/anitabi.ts reads
// them the same way): g.json, the index of every work and the position of its
// spots; g0.json, g1.json, ..., the spots' details, a few hundred works each;
// users.csv, contributors' names. They are passed on as they come.
//
// Runtime-agnostic: the Worker injects the upstream fetch.

import {
  ApiError,
  type ApiResponse,
  badRequest,
  type Fetcher,
  notFound,
  Params,
  type Upstream,
  UpstreamTimeout,
  UpstreamUnavailable,
} from './core.js';

export const ANITABI_PREFIX = '/api/v1/anitabi/';
export const ANITABI_UPSTREAM = 'https://www.anitabi.cn/d/';

// anitabi's `d` changes every 24 minutes and every file asked for carries it,
// so an hour at the edge and in the browser never serves a stale index with
// fresh chunks for long.
const TTL = 3600;

const FILE = /^\/api\/v1\/anitabi\/(g\d{0,2}\.json|users\.csv)$/;
const KEY = /^[0-9a-z]{1,10}$/;

async function fetchFile(fetch: Fetcher, url: string): Promise<Upstream> {
  try {
    return await fetch(url, TTL);
  } catch (e) {
    if (e instanceof UpstreamTimeout) throw new ApiError(504, 'upstream_timeout', 'anitabi did not respond in time');
    if (e instanceof UpstreamUnavailable) {
      throw new ApiError(502, 'upstream_error', `could not reach anitabi: ${e.message}`);
    }
    throw e;
  }
}

export async function dispatchAnitabi(path: string, search: URLSearchParams, fetch: Fetcher): Promise<ApiResponse> {
  const m = FILE.exec(path);
  if (!m) throw notFound(path);
  const file = m[1];
  const key = new Params(search, ['d']).get('d');
  if (key !== null && !KEY.test(key)) throw badRequest('d must be up to 10 lower-case letters and digits');

  const url = `${ANITABI_UPSTREAM}${file}${key ? `?d=${key}` : ''}`;
  const upstream = await fetchFile(fetch, url);
  if (upstream.status === 404) throw new ApiError(404, 'not_found', `anitabi has no ${file}`);
  if (!(200 <= upstream.status && upstream.status < 300)) {
    throw new ApiError(502, 'upstream_error', `anitabi returned HTTP ${upstream.status}`);
  }
  // A file anitabi does not have (a chunk past the last) comes back as its
  // app's HTML page, with 200.
  const isJson = file.endsWith('.json');
  const body = upstream.text.trimStart();
  if (body.startsWith('<') || (isJson && !body.startsWith('['))) {
    throw new ApiError(404, 'not_found', `anitabi has no ${file}`);
  }
  return {
    status: 200,
    body: upstream.text,
    headers: {
      'content-type': isJson ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${TTL}`,
    },
  };
}
