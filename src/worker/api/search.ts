// Search API (/api/v1/search?q=): China Railway train numbers, each with its
// origin and terminus, and stations in China and Japan (station-search.ts).
//
// Answered from memory, from indexes the build prepares and the Worker bundles
// rather than reads from D1 (vite.config.js `build-data/`): the train numbers
// `build_d1.py --search` writes (cr-search.json), with the numbers each train is
// found by already sorted, so an isolate's first search only parses it and
// any prefix is a bisection; the stations likewise (station-search.ts). The
// tests get the fixtures' (fixtures/build-data/).

import trainsJson from 'build-data/cr-search.json?raw';
import { type ApiResponse, json, notFound, Params } from './core.js';
import { iso, TTL } from './cr.js';
import { stationHit, stationIndex } from './station-search.js';

export const SEARCH_PATH = '/api/v1/search';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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

// As build_d1.py writes it: the trains by number, and the numbers each is
// found by (its own and each half without the period letter: Z156/Z157B is
// found by Z156/Z157B, Z156 and Z157), sorted, each with its train's index
interface TrainIndexFile {
  version: string;
  trains: SearchTrain[];
  keys: string[];
  owners: number[];
}

class SearchIndex {
  readonly version: string;
  readonly trains: SearchTrain[];
  readonly keys: string[];
  readonly owners: number[];

  constructor(data: TrainIndexFile) {
    this.version = data.version;
    this.trains = data.trains;
    this.keys = data.keys;
    this.owners = data.owners;
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

function trainIndex(): SearchIndex {
  if (index === null) {
    index = new SearchIndex(JSON.parse(trainsJson) as TrainIndexFile);
  }
  return index;
}

// What could start a train number: a digit early on (G1, 4651, DJ5), or a
// lone letter
const TRAIN_START = /^[A-Z]{0,2}\d|^[A-Z]$/;
const TYPES = ['all', 'train', 'station'];

function answer(q: Params): ApiResponse {
  const text = q.text('q', true);
  // Full-width and lower-case input, spaces anywhere: ｇ １ is G1
  const query = text.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  const limit = q.integer('limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
  const type = q.choice('type', TYPES, 'all');
  const trains = type === 'train' || (type === 'all' && TRAIN_START.test(query)) ? trainIndex() : null;
  const stations = type === 'train' ? null : stationIndex();
  const results = [
    ...(trains?.find(query, limit) ?? []).map(([code, origin, dest, start, end]) => ({
      type: 'cr_train',
      train: code,
      origin,
      destination: dest,
      service: { from: iso(start), to: iso(end) },
    })),
    ...(stations?.find(text, limit) ?? []).map(stationHit),
  ];
  return json(
    200,
    { data_version: trains?.version ?? null, stations_version: stations?.version ?? null, query, results },
    TTL,
  );
}

export function dispatchSearch(path: string, search: URLSearchParams): ApiResponse {
  if (path !== SEARCH_PATH) throw notFound(path);
  return answer(new Params(search, ['q', 'limit', 'type']));
}
