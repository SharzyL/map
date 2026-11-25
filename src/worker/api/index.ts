// The API under /api/v1: routing, the index and errors. Japanese routes and
// timetables from Yahoo! 乗換案内 are under /api/v1/norikae, China Railway under
// /api/v1/cr, and what serves both at the root. Runtime-agnostic: the Worker
// (runtime.ts) injects the upstream fetch and the D1 query.

import { ANITABI_PREFIX, dispatchAnitabi } from './anitabi.js';
import { CR_PREFIX, dispatchCr } from './cr.js';
import {
  API_PREFIX,
  ApiError,
  type ApiResponse,
  DOC_PATH,
  errorResponse,
  type Fetcher,
  json,
  notFound,
  type Query,
} from './core.js';
import { dispatchNorikae, NORIKAE_PREFIX } from './norikae/handlers.js';
import { dispatchRelations, RELATIONS_PREFIX } from './relations.js';
import { dispatchSearch, SEARCH_PATH } from './search.js';

const ENDPOINTS = [
  '/norikae/routes',
  '/norikae/stations',
  '/norikae/stations/{code}/status',
  '/norikae/stations/{code}/timetables',
  '/norikae/stations/{code}/timetables/{gid}',
  '/norikae/stations/{code}/timetables/{gid}/status',
  '/norikae/stations/{code}/timetables/{gid}/trains/{train_id}',
  '/norikae/stations/{code}/timetables/{gid}/trains/{train_id}/route',
  '/cr/stations',
  '/cr/stations/{station}/timetable',
  '/cr/trains/{train}',
  '/cr/trains/{train}/route',
  '/cr/trainsets/{train}',
  '/relations/{id}',
  '/search',
  '/anitabi/{file}',
].map((path) => API_PREFIX + path);

function index(): ApiResponse {
  return json(200, { name: 'atlas-realm', doc: DOC_PATH, endpoints: ENDPOINTS }, 3600);
}

export interface Context {
  fetch: Fetcher;
  // D1, where the Worker has it; China Railway, relations and search answer 503 without
  db?: Query | null;
  now?: Date;
}

async function dispatch(url: URL, ctx: Context): Promise<ApiResponse> {
  const path = url.pathname.replace(/\/+$/, '');
  const now = ctx.now ?? new Date();
  const db = ctx.db ?? null;
  if (path === API_PREFIX) return index();
  if (path.startsWith(NORIKAE_PREFIX)) return dispatchNorikae(path, url.searchParams, ctx.fetch, now);
  if (path.startsWith(CR_PREFIX)) return dispatchCr(path, url.searchParams, db, ctx.fetch, now);
  if (path.startsWith(RELATIONS_PREFIX)) return dispatchRelations(path, url.searchParams, db);
  if (path === SEARCH_PATH) return dispatchSearch(path, url.searchParams, db);
  if (path.startsWith(ANITABI_PREFIX)) return dispatchAnitabi(path, url.searchParams, ctx.fetch);
  throw notFound(path);
}

export async function handleApi(method: string, url: string | URL, ctx: Context): Promise<ApiResponse> {
  if (method === 'OPTIONS') {
    return {
      status: 204,
      body: '',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-max-age': '86400',
      },
    };
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const resp = errorResponse(new ApiError(405, 'method_not_allowed', 'only GET is supported'));
    resp.headers.allow = 'GET, HEAD, OPTIONS';
    return resp;
  }

  let resp: ApiResponse;
  try {
    resp = await dispatch(new URL(url), ctx);
  } catch (e) {
    if (e instanceof ApiError) {
      resp = errorResponse(e);
    } else {
      // Last-resort guard, logged to Workers logs
      console.error(e);
      resp = errorResponse(new ApiError(500, 'internal_error', 'internal error'));
    }
  }
  if (method === 'HEAD') resp.body = '';
  return resp;
}
