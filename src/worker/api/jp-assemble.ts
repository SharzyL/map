// A Japanese train's route (route-api.md, section 3) from the stored hops of
// routing/jp_store.py, without the graph. The tables are jp_store.py's; D1
// serves them as views of the imported version (routing/export_d1.py).

import type { Query, Row } from './core.js';
import { decodePolyline, encodePolyline, metres, sum, type LatLon } from './geo.js';

const LEG_DETOUR_RATIO = 2.0;
const LEG_DETOUR_SLACK_M = 2000;
const CANDIDATES = 8; // routes tried per leg
// A route made from a rule for the train, before type, name and direction
const RULE_SCORE = 8;
// D1 binds at most 100 parameters per query
const MAX_PARAMS = 90;

// The train as the API's train endpoint gives it
export interface Train {
  name: string;
  kind?: string | null;
  line?: string | null;
  timetable_line?: string | null;
  stops: { code: string | null; name: string }[];
}

type Point = [number, number]; // [lon, lat] on the track

interface Hop {
  length: number;
  ways: number[];
  partial: unknown[];
  line: string | null;
  start: Point;
  end: Point;
  highspeed: number;
}

interface Leg {
  from: number;
  to: number;
  method: 'line' | 'straight';
  length_m: number;
  ways: number[];
  partial: unknown[];
  route: number | null;
  line: LatLon[]; // overview points
  start: Point | null;
  end: Point | null;
}

// Line or service name without operator, kind and direction words
export function core(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[(（].*?[)）]/g, '')
    .replace(/^JR|^東京メトロ|^都営地下鉄|^都営/g, '')
    .replace(/特急|急行|快速|各駅停車|普通|外回り|内回り|本線|線|ライン|列車|\d+号|\s/g, '');
}

export function isShinkansen(text: string): boolean {
  return text.includes('新幹線');
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let k = 0; k < items.length; k += size) out.push(items.slice(k, k + size));
  return out;
}

// Rows of `sql` (with {marks} for an IN list) over all values, in chunks
async function rowsIn(db: Query, sql: string, values: readonly (string | number)[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const chunk of chunks(values, MAX_PARAMS)) {
    out.push(...(await db(sql.replace('{marks}', chunk.map(() => '?').join(',')), chunk)));
  }
  return out;
}

const range = (from: number, to: number, step = 1): number[] => {
  const out: number[] = [];
  for (let k = from; step > 0 ? k < to : k > to; k += step) out.push(k);
  return out;
};

// Hops from stop sa to stop sb on a route of n stops: [seq, reversed]
function hopSeqs(sa: number, sb: number, n: number, loop: boolean): [number, boolean][] {
  const forward = sa < sb ? range(sa, sb) : loop ? [...range(sa, n), ...range(0, sb)] : null;
  const backward =
    sb < sa ? range(sa - 1, sb - 1, -1) : loop ? [...range(sa - 1, -1, -1), ...range(n - 1, sb - 1, -1)] : null;
  const options: [number, boolean][][] = [];
  if (forward) options.push(forward.map((s) => [s, false]));
  if (backward) options.push(backward.map((s) => [s, true]));
  return options.reduce((best, o) => (o.length < best.length ? o : best));
}

const pairs = <T>(items: readonly T[]): [T, T][] => items.slice(1).map((b, k) => [items[k], b]);

// Legs of one train, with the stations ({code: row}) and the routes used ({id: name})
async function assemble(
  train: Train,
  db: Query,
): Promise<{ legs: Leg[]; stations: Map<string, Row>; routeNames: Map<number, string> }> {
  const codes = train.stops.map((s) => s.code);
  const unique = [...new Set(codes.filter((c): c is string => !!c))].sort();
  const lineName = train.timetable_line || train.line || '';
  const at = new Map<string, Map<number, number>>();
  for (const r of await rowsIn(db, 'SELECT code, route_id, seq FROM jp_route_stops WHERE code IN ({marks})', unique)) {
    const code = r.code as string;
    if (!at.has(code)) at.set(code, new Map());
    at.get(code).set(r.route_id as number, r.seq as number);
  }
  const stationRows = await rowsIn(
    db,
    'SELECT code, lat, lon, elements FROM jp_stations WHERE code IN ({marks})',
    unique,
  );
  const stations = new Map(stationRows.map((r) => [r.code as string, r]));
  const legPairs = pairs(codes);
  const commons = legPairs.map(([a, b]) => {
    const ofB = at.get(b) ?? new Map();
    return new Set([...(at.get(a) ?? new Map()).keys()].filter((r) => ofB.has(r)));
  });
  const routeIds = [...new Set(commons.flatMap((c) => [...c]))].sort((x, y) => x - y);
  const routeRows = await rowsIn(
    db,
    'SELECT id, name, shinkansen, loop, stops, train FROM jp_routes WHERE id IN ({marks})',
    routeIds,
  );
  const routes = new Map(routeRows.map((r) => [r.id as number, r]));
  const shinkansen = isShinkansen(`${train.name} ${lineName}`);
  const wanted = [...new Set([core(lineName), core(train.name)])].filter(Boolean);
  const text = `${train.kind ?? ''} ${train.name}`;

  const named = (r: number) => {
    const c = core(routes.get(r).name as string);
    return !!c && wanted.some((w) => w.includes(c) || c.includes(w));
  };
  const patterns = new Map<string, RegExp>();
  // A route made from a rule for this train
  const ruled = (r: number) => {
    const pattern = routes.get(r).train as string | null;
    if (!pattern) return false;
    if (!patterns.has(pattern)) patterns.set(pattern, new RegExp(pattern));
    return patterns.get(pattern).test(text);
  };
  const seqsOf = (r: number, a: string, b: string) => {
    const route = routes.get(r);
    return hopSeqs(at.get(a).get(r), at.get(b).get(r), route.stops as number, !!route.loop);
  };
  const forward = (r: number, a: string, b: string) => +(at.get(a).get(r) < at.get(b).get(r));

  // Candidate routes per leg, best first (previous-leg continuity is applied
  // when picking, below)
  const cands = legPairs.map(([a, b], k) => {
    const score = (r: number) =>
      RULE_SCORE * +ruled(r) + 4 * +(!!routes.get(r).shinkansen === shinkansen) + 2 * +named(r) + forward(r, a, b);
    return [...commons[k]]
      .filter((r) => routes.has(r))
      .sort((x, y) => x - y)
      .map((r) => ({ r, score: score(r) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, CANDIDATES)
      .map((c) => c.r);
  });

  const needed = new Map<string, [number, number]>();
  legPairs.forEach(([a, b], k) => {
    for (const r of cands[k]) for (const [s] of seqsOf(r, a, b)) needed.set(`${r}:${s}`, [r, s]);
  });
  const need = [...needed.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const hopData = new Map<string, Hop>();
  for (const chunk of chunks(need, MAX_PARAMS / 2)) {
    const clause = chunk.map(() => '(route_id = ? AND seq = ?)').join(' OR ');
    const sql = `SELECT route_id, seq, length_m, ways, partial, line, start, end, highspeed FROM jp_hops WHERE ${clause}`;
    for (const r of await db(sql, chunk.flat())) {
      hopData.set(`${r.route_id}:${r.seq}`, {
        length: r.length_m as number,
        ways: JSON.parse(r.ways as string),
        partial: JSON.parse(r.partial as string),
        line: r.line as string | null,
        start: JSON.parse(r.start as string),
        end: JSON.parse(r.end as string),
        highspeed: r.highspeed as number,
      });
    }
  }

  const legs: Leg[] = [];
  let prev: number | null = null;
  legPairs.forEach(([a, b], k) => {
    const leg: Leg = {
      from: k,
      to: k + 1,
      method: 'straight',
      length_m: 0,
      ways: [],
      partial: [],
      route: null,
      line: [],
      start: null,
      end: null,
    };
    const sa = stations.get(a);
    const sb = stations.get(b);
    const straight = sa && sb ? metres(sa.lat as number, sa.lon as number, sb.lat as number, sb.lon as number) : null;
    // Score each candidate on the hops it would use: a route mapped over both
    // conventional and 新幹線 track (かもめ: リレー and 西九州新幹線) is 新幹線
    // only where its hops are
    let best: { score: number; length: number; r: number; seqs: [number, boolean][]; parts: Hop[] } | null = null;
    for (const r of cands[k]) {
      const seqs = seqsOf(r, a, b);
      const parts = seqs.map(([s]) => hopData.get(`${r}:${s}`));
      if (!parts.every(Boolean)) continue;
      const length = sum(parts.map((p) => p.length));
      // Tighter than for a whole path: a leg between consecutive stops that
      // runs twice the straight distance overshoots a stop listed out of order
      // and comes back
      if (straight !== null && length > straight * LEG_DETOUR_RATIO + LEG_DETOUR_SLACK_M) continue;
      const hsShare = length ? sum(parts.map((p) => p.length * p.highspeed)) / length : 0;
      // Only 新幹線 trains run on 新幹線 track (they also run on conventional
      // lines: こまち, つばさ); a conventional train is better drawn straight
      // than on the 山陽新幹線 because only こだま stops at both 姫路 and 岡山.
      // A few metres of it at a station are no sign
      if (!shinkansen && hsShare >= 0.5 && hsShare * length >= 1000) continue;
      const score =
        RULE_SCORE * +ruled(r) +
        4 * +(hsShare >= 0.5 === shinkansen) +
        2 * +named(r) +
        forward(r, a, b) +
        +(r === prev);
      if (!best || score > best.score || (score === best.score && length < best.length)) {
        best = { score, length, r, seqs, parts };
      }
    }
    if (best) {
      const { length, r, seqs, parts } = best;
      Object.assign(leg, { method: 'line', length_m: length, route: r });
      parts.forEach((p, i) => {
        const back = seqs[i][1];
        leg.ways.push(...(back ? [...p.ways].reverse() : p.ways));
        leg.partial.push(...p.partial);
        const pts = p.line ? decodePolyline(p.line) : [];
        leg.line.push(...(back ? pts.reverse() : pts));
      });
      const first = parts[0];
      const last = parts[parts.length - 1];
      leg.start = seqs[0][1] ? first.end : first.start;
      leg.end = seqs[seqs.length - 1][1] ? last.start : last.end;
      prev = r;
    }
    legs.push(leg);
  });
  return { legs, stations, routeNames: new Map([...routes].map(([r, row]) => [r, row.name as string])) };
}

const samePoint = (p: LatLon, q: LatLon) => p[0] === q[0] && p[1] === q[1];

// The route-api.md route of one train; the data version is read from
// jp_version unless given
export async function route(train: Train, db: Query, version?: string | null): Promise<Record<string, unknown>> {
  if (version === undefined) {
    const rows = await db('SELECT version FROM jp_version', []);
    version = rows.length ? (rows[0].version as string) : null;
  }
  const { legs, stations, routeNames } = await assemble(train, db);
  const names = train.stops.map((s) => s.name);
  const codes = train.stops.map((s) => s.code);
  const ways: number[] = [];
  const seen = new Set<number>();
  const partial: unknown[] = [];
  let pieces: LatLon[][] = [];
  for (const x of legs) {
    for (const w of x.ways) {
      if (!seen.has(w)) {
        seen.add(w);
        ways.push(w);
      }
    }
    partial.push(...x.partial);
    const last = pieces[pieces.length - 1];
    if (x.method === 'straight' || !x.line.length) pieces.push([]);
    else if (last?.length) last.push(...(samePoint(last[last.length - 1], x.line[0]) ? x.line.slice(1) : x.line));
    else pieces.push([...x.line]);
  }
  pieces = pieces.filter((p) => p.length >= 2);
  const pts = pieces.flat();
  const stops = names.map((n, k) => {
    // Where the route meets the stop: the start of its leg out, else the end
    // of its leg in, else the station
    const onTrack = (k < legs.length ? legs[k].start : null) || (k ? legs[k - 1].end : null);
    const st = stations.get(codes[k]);
    return {
      name: n,
      position: onTrack || (st ? [st.lon, st.lat] : null),
      elements: st ? JSON.parse(st.elements as string) : [],
    };
  });
  const outLegs = legs.map((x) => {
    const leg: Record<string, unknown> = {
      from: names[x.from],
      to: names[x.to],
      line: x.route === null ? null : (routeNames.get(x.route) ?? null),
      method: x.method,
    };
    if (x.method === 'straight') {
      const ends = [stations.get(codes[x.from]), stations.get(codes[x.to])];
      if (ends.every(Boolean)) leg.straight = encodePolyline(ends.map((e) => [e.lat as number, e.lon as number]));
    }
    return leg;
  });
  // [west, south, east, north]; a loop, since a long train has too many points to spread
  let bbox: number[] | null = null;
  for (const [lat, lon] of pts) {
    if (!bbox) bbox = [lon, lat, lon, lat];
    else bbox = [Math.min(bbox[0], lon), Math.min(bbox[1], lat), Math.max(bbox[2], lon), Math.max(bbox[3], lat)];
  }
  return {
    data_version: version,
    bbox,
    ways,
    partial,
    overview: pieces.map((p) => encodePolyline(p)),
    stops,
    legs: outLegs,
  };
}
