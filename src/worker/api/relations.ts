// Railway relation API (/api/v1/relations/{id}): what the map highlights and
// shows in its route panel for an OSM route, line or route master, or one of
// Japan's official lines, from the railway extract that
// osm/build_relations.py prefills into D1.
//
// Runtime-agnostic: the Worker entrypoint injects the query function, so tests
// run this module against SQLite.

import { ApiError, type ApiResponse, badRequest, DataUnavailable, json, notFound, Params, type Query } from './core.js';

export const RELATIONS_PREFIX = '/api/v1/relations/';

// One data version's answers never change, and versions come weekly at most
const TTL = 86400;

// An OSM relation id, or jp- and 10 hex digits for an official line in Japan
const RELATION_ID = /^(?:\d{1,12}|jp-[0-9a-f]{10})$/;

function unavailable(): ApiError {
  return new ApiError(503, 'data_unavailable', 'railway relation data is temporarily unavailable');
}

async function getRelation(relationId: string, db: Query): Promise<ApiResponse> {
  if (!RELATION_ID.test(relationId)) {
    throw badRequest('relation id must be an OSM relation id or jp- and 10 hex digits');
  }
  const rows = await db(
    'SELECT v.version, r.body FROM osm_version v LEFT JOIN osm_relations r ON r.id = ? ORDER BY r.part',
    [relationId],
  );
  if (!rows[0].body) throw new ApiError(404, 'not_found', `no railway relation ${relationId}`);
  const body = JSON.parse(rows.map((r) => String(r.body)).join('')) as Record<string, unknown>;
  return json(200, { data_version: rows[0].version, ...body }, TTL);
}

const RELATION = /^\/api\/v1\/relations\/([^/]+)$/;

export async function dispatchRelations(path: string, search: URLSearchParams, db: Query | null): Promise<ApiResponse> {
  const m = RELATION.exec(path);
  if (!m) throw notFound(path);
  new Params(search, []);
  if (db === null) throw unavailable();
  try {
    return await getRelation(m[1], db);
  } catch (e) {
    if (e instanceof DataUnavailable) throw unavailable();
    throw e;
  }
}
