// Routes of Yahoo trains on OSM track (route-api.md, section 3):
// /api/v1/norikae/stations/{code}/timetables/{gid}/trains/{train_id}/route.
//
// The Worker gets the train's stops from the API in Japan as for the train
// itself, then assembles the route from the stored hops of
// routing/jp_store.py in D1 (jp-assemble.ts), near the client.

import { ApiError, DataUnavailable, errorResponse, json, type ApiResponse, type Query } from './core.js';
import { route, type Train } from './jp-assemble.js';
import { withRanks } from './station-ranks.js';

// The train's own path, and /route
export const TRAIN_ROUTE = /^(\/api\/v1\/norikae\/stations\/[^/]+\/timetables\/[^/]+\/trains\/[^/]+)\/route$/;

// As long as the train itself is cached
const TTL = 3600;

export function unavailable(): ApiResponse {
  return errorResponse(new ApiError(503, 'data_unavailable', 'route data is temporarily unavailable'));
}

// The route of a train as the API's train endpoint gives it
export async function trainRoute(train: Train, db: Query): Promise<ApiResponse> {
  let body: Record<string, unknown>;
  try {
    body = await route(train, db);
    body.stops = await withRanks(body.stops as Array<{ elements?: unknown }>, db);
  } catch (e) {
    if (e instanceof DataUnavailable) return unavailable();
    throw e;
  }
  return json(200, body, TTL);
}
