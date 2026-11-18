// Search API (/api/v1/search?q=): China Railway train numbers for now, each
// with its origin and terminus.
//
// Answered from memory: the cr_search table that lltskb/build_d1.py prefills
// is loaded once per isolate and kept until the data version changes, so a
// search reads one row (the version) and any prefix is a bisection.
//
// Runtime-agnostic: the Worker entrypoint injects the query function, so tests
// run this module against SQLite.

import { ApiError, type ApiResponse, DataUnavailable, json, notFound, Params, type Query } from './core.js';
import { iso, TTL } from './cr.js';

export const SEARCH_PATH = '/api/v1/search';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function unavailable(): ApiError {
  return new ApiError(503, 'data_unavailable', 'search data is temporarily unavailable');
}

// [train, origin, terminus, first day, last day]
type SearchTrain = [string, string, string, number, number];

// Rank of a matching key: exact first, then the shortest numbers, then by key
type Rank = [boolean, number, string];

function compare<T extends string | number | boolean>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRanks(a: Rank, b: Rank): number {
  return compare(a[0], b[0]) || compare(a[1], b[1]) || compare(a[2], b[2]);
}

// The first index whose key is not below `key`
function lowerBound(keys: string[], key: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class SearchIndex {
  readonly keys: string[];
  readonly owners: number[];

  constructor(
    readonly version: string,
    readonly trains: SearchTrain[],
  ) {
    // Each train under its full number and each half without the period
    // letter: Z156/Z157B is found by Z156/Z157B, Z156 and Z157
    const entries: [string, number][] = [];
    trains.forEach((t, i) => {
      for (const k of new Set([t[0], ...t[0].replace(/(?<=\d)[A-Z]+$/, '').split('/')])) entries.push([k, i]);
    });
    entries.sort((a, b) => compare(a[0], b[0]) || a[1] - b[1]);
    this.keys = entries.map(([k]) => k);
    this.owners = entries.map(([, i]) => i);
  }

  // Trains with a number starting with query: exact first, then the shortest
  // numbers (G1, G10 … G19, G100 …)
  find(query: string, limit: number): SearchTrain[] {
    const lo = lowerBound(this.keys, query);
    const hi = lowerBound(this.keys, query + '￿');
    const best = new Map<number, Rank>();
    for (let j = lo; j < hi; j++) {
      const k = this.keys[j];
      const i = this.owners[j];
      const rank: Rank = [k !== query, [...k].length, k];
      const known = best.get(i);
      if (!known || compareRanks(rank, known) < 0) best.set(i, rank);
    }
    const order = [...best.keys()].sort(
      (a, b) => compareRanks(best.get(a), best.get(b)) || compare(this.trains[a][0], this.trains[b][0]),
    );
    return order.slice(0, limit).map((i) => this.trains[i]);
  }
}

let index: SearchIndex | null = null;

async function load(db: Query): Promise<SearchIndex> {
  const rows = await db('SELECT version FROM cr_version', []);
  const version = String(rows[0].version);
  if (index === null || index.version !== version) {
    const parts = await db('SELECT body FROM cr_search ORDER BY part', []);
    if (!parts.length) throw new DataUnavailable('no search index');
    index = new SearchIndex(
      version,
      parts.flatMap((p) => JSON.parse(String(p.body)) as SearchTrain[]),
    );
  }
  return index;
}

async function searchTrains(q: Params, db: Query): Promise<ApiResponse> {
  const text = q.text('q', true);
  // Full-width and lower-case input, spaces anywhere: ｇ １ is G1
  const query = text.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  const limit = q.integer('limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
  const found = await load(db);
  const results = found.find(query, limit).map(([code, origin, dest, start, end]) => ({
    type: 'cr_train',
    train: code,
    origin,
    destination: dest,
    service: { from: iso(start), to: iso(end) },
  }));
  return json(200, { data_version: found.version, query, results }, TTL);
}

export async function dispatchSearch(path: string, search: URLSearchParams, db: Query | null): Promise<ApiResponse> {
  if (path !== SEARCH_PATH) throw notFound(path);
  const q = new Params(search, ['q', 'limit']);
  if (db === null) throw unavailable();
  try {
    return await searchTrains(q, db);
  } catch (e) {
    if (e instanceof DataUnavailable) throw unavailable();
    throw e;
  }
}
