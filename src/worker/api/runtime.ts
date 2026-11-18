// Adapts the Workers runtime to the API (index.ts).
//
// The Yahoo endpoints run in a Durable Object placed in Japan, so Yahoo sees
// every request come from there instead of from the Cloudflare location
// nearest each client. China Railway (/api/v1/cr), relations and search never
// call Yahoo and read D1, so the Worker answers them itself, near the client
// and the nearest read replica — except /api/v1/cr/trainsets, which fetches
// 12306 and so runs in the object too. A Yahoo train's route is answered here
// too, once the object has given the train's stops.

import { DurableObject } from 'cloudflare:workers';

import { TRAINSET_PREFIX } from './cr.js';
import {
  type ApiResponse,
  ApiError,
  DataUnavailable,
  errorResponse,
  type Query,
  type Upstream,
  UpstreamTimeout,
  UpstreamUnavailable,
} from './core.js';
import { handleApi } from './index.js';
import { NORIKAE_PREFIX } from './norikae/handlers.js';
import { UA } from './norikae/timetable.js';
import { TRAIN_ROUTE, trainRoute, unavailable } from './train-route.js';

const UPSTREAM_TIMEOUT_MS = 15_000;

// A single named instance. The hint only applies when the object is first
// created and objects never move, so rename it to place a fresh one. The
// runtime takes "apac-ne" (north-east Asia), which workers-types does not list
const API_OBJECT = 'jp';
const API_LOCATION = { locationHint: 'apac-ne' } as unknown as DurableObjectNamespaceGetDurableObjectOptions;

async function fetchUpstream(url: string, cacheTtl: number): Promise<Upstream> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // Cache successful upstream responses at the edge; never cache errors
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': cacheTtl, '300-599': 0 } },
    });
    return { status: resp.status, text: await resp.text() };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'TimeoutError') throw new UpstreamTimeout();
    // Not only network errors: a connection lost mid-body surfaces from text()
    throw new UpstreamUnavailable(e instanceof Error ? e.message : String(e));
  }
}

function d1Query(binding: D1Database): Query {
  let session: D1DatabaseSession | null = null;
  return async (sql, params) => {
    try {
      // A session lets reads go to the nearest read replica
      session ??= binding.withSession('first-unconstrained');
      const result = await session
        .prepare(sql)
        .bind(...params)
        .all();
      return result.results as Record<string, unknown>[];
    } catch (e) {
      // Missing tables, D1 outages, ...: logged; the client only sees 503
      console.error(e);
      throw new DataUnavailable(e instanceof Error ? e.message : String(e));
    }
  };
}

function toResponse(resp: ApiResponse): Response {
  return new Response(resp.body || null, { status: resp.status, headers: resp.headers });
}

function unreachable(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  return toResponse(errorResponse(new ApiError(502, 'upstream_error', `could not reach the API in Japan: ${message}`)));
}

export class NorikaeApi extends DurableObject<Cloudflare.Env> {
  async fetch(request: Request): Promise<Response> {
    return toResponse(await handleApi(request.method, request.url, { fetch: fetchUpstream }));
  }
}

// A Yahoo train's route: its stops from the object, the rest from D1
async function yahooTrainRoute(stub: DurableObjectStub<NorikaeApi>, trainUrl: URL, env: Cloudflare.Env) {
  let resp: Response;
  try {
    resp = await stub.fetch(trainUrl.toString());
  } catch (e) {
    return unreachable(e);
  }
  if (resp.status !== 200) return resp;
  const train = await resp.json();
  if (!env.CR_DB) return toResponse(unavailable());
  return toResponse(await trainRoute(train as Parameters<typeof trainRoute>[0], d1Query(env.CR_DB)));
}

export async function handleApiRequest(request: Request, env: Cloudflare.Env): Promise<Response> {
  const url = new URL(request.url);
  const inJapan = url.pathname.startsWith(NORIKAE_PREFIX) || url.pathname.startsWith(TRAINSET_PREFIX);
  if (!inJapan) {
    const db = env.CR_DB ? d1Query(env.CR_DB) : null;
    return toResponse(await handleApi(request.method, url, { fetch: fetchUpstream, db }));
  }
  const stub = env.NORIKAE.get(env.NORIKAE.idFromName(API_OBJECT), API_LOCATION);
  const route = TRAIN_ROUTE.exec(url.pathname.replace(/\/+$/, ''));
  if (route && (request.method === 'GET' || request.method === 'HEAD')) {
    return yahooTrainRoute(stub, new URL(route[1], url), env);
  }
  try {
    return await stub.fetch(request);
  } catch (e) {
    // The runtime already retried what was safe to; API errors arrive as
    // responses, so this is only the object being unreachable or overloaded
    return unreachable(e);
  }
}
