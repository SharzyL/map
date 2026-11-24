// China Railway JSON API (/api/v1/cr/*): station timetables and train
// schedules from the lulutong (路路通) data that the lltskb workflow prefills
// into D1 (lltskb/build_d1.py), trains' routes on OSM track, built by
// routing/cr_route.py and imported by routing/export_d1.py, and trainsets
// fetched live from 12306.
//
// Runtime-agnostic: the Worker entrypoint injects the query and fetch
// functions, so tests run this module against SQLite and fixtures.

import { withRanks } from './station-ranks.js';
import {
  ApiError,
  type ApiResponse,
  addDays,
  badRequest,
  CST_HOURS,
  DataUnavailable,
  daysBetween,
  type Fetcher,
  json,
  localTime,
  MAX_TEXT_LEN,
  notFound,
  Params,
  parseHours,
  parseDate,
  type Query,
  UpstreamTimeout,
  UpstreamUnavailable,
} from './core.js';

export const CR_PREFIX = '/api/v1/cr/';

// Data only changes when the lltskb workflow imports a new version
export const TTL = 3600;

const MAX_REFS = 10;
const MAX_RESULTS = 20;
const OPEN_ENDED = 20501231; // the data's "until further notice"
const OSM_REFS = /^[NWR]\d{1,12}(?:,[NWR]\d{1,12})*$/;
// D1 binds at most 100 parameters per query
const MAX_PARAMS = 90;

// Trainsets come live from 12306 (the endpoint lulutong's app uses), so they
// run in the Durable Object with the Yahoo API instead of at the edge with D1
export const TRAINSET_PREFIX = '/api/v1/cr/trainsets/';
const TRAINSET_URL =
  'https://mobile.12306.cn/wxxcx/openplatform-inner/miniprogram/wifiapps/' +
  'appFrontEnd/v2/lounge/open-smooth-common/trainStyleBatch/getCarDetail';
const TTL_TRAINSET = 600;
const TRAIN_NUMBER = /^[A-Z]{0,2}\d{1,5}$/;

function unavailable(): ApiError {
  return new ApiError(503, 'data_unavailable', 'China Railway data is temporarily unavailable');
}

// Path segments arrive percent-encoded; a malformed one stays as it is
function unquote(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ymd(iso: string): number {
  return +iso.replaceAll('-', '');
}

function ymdIso(value: number): string {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(Math.floor(value / 10000), 4)}-${pad(Math.floor(value / 100) % 100, 2)}-${pad(value % 100, 2)}`;
}

export function iso(value: number): string | null {
  return value >= OPEN_ENDED ? null : ymdIso(value);
}

// Whether a train leaves its origin on `day`: inside its service dates, and
// on a set bit of `mask` counting days back from the last service day
export function runs(start: number, end: number, period: number, mask: number, day: string): boolean {
  if (!(start <= ymd(day) && ymd(day) <= end)) return false;
  if (period <= 1) return true;
  const bit = daysBetween(day, ymdIso(end)) % period;
  // Not >>: masks may hold more than 32 bits
  return Math.floor(mask / 2 ** bit) % 2 === 1;
}

// 下行 for an odd train number, 上行 for an even one
function bound(number: string | null): string | null {
  const m = /(\d+)\D*$/.exec(number ?? '');
  if (!m) return null;
  return +m[1] % 2 ? '下行' : '上行';
}

// [first day, last day, model, coupled, depot, description]
type Stock = [number, number, string, boolean | number, string, string];

// The rolling stock a train runs with on `day` (yyyymmdd): the latest
// assignment covering it
function rollingStock(stock: Stock[], day: number) {
  let latest: Stock | null = null;
  for (const s of stock) {
    if (s[0] <= day && day <= s[1] && (!latest || s[0] > latest[0])) latest = s;
  }
  if (!latest) return null;
  const [, , model, coupled, depot, text] = latest;
  return { model: model || null, coupled: Boolean(coupled), depot: depot || null, description: text };
}

// {station} is a name or OSM refs (N123,W456) → SQL naming the station, params
function stationSql(raw: string): [string, string[]] {
  const value = unquote(raw);
  if (OSM_REFS.test(value)) {
    const refs = value.split(',');
    if (refs.length > MAX_REFS) throw badRequest(`at most ${MAX_REFS} OSM refs`);
    const marks = refs.map(() => '?').join(',');
    return [`(SELECT station FROM cr_osm WHERE ref IN (${marks}) LIMIT 1)`, refs];
  }
  if ([...value].length > MAX_TEXT_LEN) throw badRequest(`station must be at most ${MAX_TEXT_LEN} characters`);
  return ['?', [value]];
}

// ── Handlers ────────────────────────────────────────────

async function getStations(q: Params, db: Query): Promise<ApiResponse> {
  const text = q.text('q', true);
  const key = text.toLowerCase();
  // LEFT JOINs from cr_version so there is a row (with the version) even
  // when nothing matches
  const rows = await db(
    'SELECT v.version, s.name, s.telecode, s.pinyin FROM cr_version v' +
      ' LEFT JOIN cr_lookup l ON l.key >= ? AND l.key < ?' +
      ' LEFT JOIN cr_stations s ON s.name = l.station' +
      ' GROUP BY s.name ORDER BY s.name = ? DESC, s.trains DESC LIMIT ?',
    [key, key + '\u{10ffff}', text, MAX_RESULTS],
  );
  const results = rows
    .filter((r) => r.name)
    .map((r) => ({ name: r.name, telecode: r.telecode, pinyin: r.pinyin || null }));
  return json(200, { data_version: rows[0].version, results }, TTL);
}

// [train, arrival, departure, day offset, origin, destination, platform,
//  start, end, period, mask, arrival number, departure number, line in, line out]
type TimetableEntry = [
  string,
  string | null,
  string | null,
  number,
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  ...(string | null)[],
];

async function getTimetable(q: Params, station: string, db: Query, today: string): Promise<ApiResponse> {
  const dateParam = q.get('date');
  const day = dateParam ? parseDate(dateParam) : today;
  const hoursParam = q.get('hours');
  const hours = hoursParam ? parseHours(hoursParam) : null;
  const [where, params] = stationSql(station);
  const rows = await db(
    'SELECT v.version, s.name, s.telecode, t.body FROM cr_version v' +
      ` LEFT JOIN cr_stations s ON s.name = ${where}` +
      ' LEFT JOIN cr_timetables t ON t.station = s.name ORDER BY t.part',
    params,
  );
  if (!rows[0].name) throw new ApiError(404, 'not_found', `no China Railway station ${unquote(station)}`);

  const trains = [];
  for (const row of rows) {
    for (const entry of JSON.parse(String(row.body)) as TimetableEntry[]) {
      const [code, arr, dep, offset, origin, dest, platform, start, end, period, mask] = entry;
      // Rows imported before the numbers and lines were added lack them
      const [nIn = null, nOut = null, lIn = null, lOut = null] = entry.slice(11) as (string | null)[];
      if (!runs(start, end, period, mask, addDays(day, -offset))) continue;
      if (hours) {
        const hour = +(dep || arr).slice(0, 2);
        if (!(hours[0] <= hour && hour <= hours[1])) continue;
      }
      trains.push({
        train: code,
        arrival: arr,
        departure: dep,
        origin,
        destination: dest,
        day: offset + 1,
        platform: platform || null,
        arrival_number: nIn,
        departure_number: nOut,
        bound: bound(nOut || nIn),
        line: dep ? lOut : lIn,
        line_in: lIn,
        line_out: lOut,
      });
    }
  }
  return json(
    200,
    {
      data_version: rows[0].version,
      station: { name: rows[0].name, telecode: rows[0].telecode },
      date: day,
      trains,
    },
    TTL,
  );
}

function trainName(code: string): string {
  const name = unquote(code).toUpperCase();
  if ([...name].length > MAX_TEXT_LEN) throw badRequest(`train must be at most ${MAX_TEXT_LEN} characters`);
  return name;
}

interface StationOsm {
  elements: unknown;
  position: [unknown, unknown];
}

// Stations' OSM elements and positions, imported with the routes; none until
// they are, rather than failing the timetable
async function stationOsm(names: string[], db: Query): Promise<Map<string, StationOsm>> {
  const found = new Map<string, StationOsm>();
  const unique = [...new Set(names)].sort();
  try {
    for (let k = 0; k < unique.length; k += MAX_PARAMS) {
      const chunk = unique.slice(k, k + MAX_PARAMS);
      const marks = chunk.map(() => '?').join(',');
      const rows = await db(
        `SELECT station, elements, lon, lat FROM route_cr_stations WHERE station IN (${marks})`,
        chunk,
      );
      for (const r of rows) {
        found.set(String(r.station), { elements: JSON.parse(String(r.elements)), position: [r.lon, r.lat] });
      }
    }
  } catch (e) {
    if (e instanceof DataUnavailable) return new Map();
    throw e;
  }
  return found;
}

// [station, telecode, arrival, departure, day offset, km, platform,
//  arrival number, departure number]
type TrainStop = [string, string, string | null, string | null, number, number, string, ...(string | null)[]];

interface StoredTrain {
  train: string;
  start: number;
  end: number;
  period: number;
  mask: number;
  stops: TrainStop[];
  stock?: Stock[];
  lines?: [string, [string, number][]][];
}

async function getTrain(q: Params, code: string, db: Query, today: string): Promise<ApiResponse> {
  const dateParam = q.get('date');
  const day = dateParam ? parseDate(dateParam) : today;
  const name = trainName(code);
  const rows = await db('SELECT v.version, t.body FROM cr_version v LEFT JOIN cr_trains t ON t.code = ?', [name]);
  if (!rows[0].body) throw new ApiError(404, 'not_found', `no China Railway train ${name}`);

  const found = JSON.parse(String(rows[0].body)) as StoredTrain[];
  const osm = await stationOsm(
    found.flatMap((t) => t.stops.map((s) => s[0])),
    db,
  );
  const trains = found.map((t) => {
    // Outside its service the train runs with the stock of its nearest day
    const served = Math.min(Math.max(ymd(day), t.start), t.end);
    return {
      train: t.train,
      service: { from: iso(t.start), to: iso(t.end) },
      runs: runs(t.start, t.end, t.period, t.mask, day),
      rolling_stock: rollingStock(t.stock ?? [], served),
      lines: (t.lines ?? []).map(([line, stations]) => ({
        name: line,
        stations: stations.map(([st, km]) => ({ name: st, km })),
      })),
      stops: t.stops.map(([st, tel, arr, dep, offset, km, platform, ...numbers]) => {
        const [nIn = null, nOut = null] = numbers;
        return {
          name: st,
          telecode: tel || null,
          arrival: arr,
          departure: dep,
          day: offset + 1,
          km,
          platform: platform || null,
          elements: osm.get(st)?.elements ?? null,
          position: osm.get(st)?.position ?? null,
          arrival_number: nIn,
          departure_number: nOut,
          bound: bound(nOut || nIn),
        };
      }),
    };
  });
  return json(200, { data_version: rows[0].version, train: name, date: day, trains }, TTL);
}

// zlib-compressed, base64-encoded text → the text
async function inflate(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).text();
}

// The route of the train number's run on the date: the one running that day,
// else the one in service then, else the first
async function getRoute(q: Params, code: string, db: Query, today: string): Promise<ApiResponse> {
  const dateParam = q.get('date');
  const day = dateParam ? parseDate(dateParam) : today;
  const name = trainName(code);
  const rows = await db('SELECT body FROM cr_trains WHERE code = ?', [name]);
  if (!rows.length || !rows[0].body) throw new ApiError(404, 'not_found', `no China Railway train ${name}`);
  const found = JSON.parse(String(rows[0].body)) as StoredTrain[];
  const date = ymd(day);
  const run = (
    found.find((t) => runs(t.start, t.end, t.period, t.mask, day)) ??
    found.find((t) => t.start <= date && date <= t.end) ??
    found[0]
  ).train;
  const parts = await db('SELECT body FROM route_cr_runs WHERE run = ? ORDER BY part', [run]);
  if (!parts.length) throw new ApiError(404, 'not_found', `no route for China Railway train ${run}`);
  // Stored as the response itself, compressed; its stops take their ranks here
  const body = JSON.parse(await inflate(parts.map((p) => String(p.body)).join(''))) as { stops?: unknown };
  if (Array.isArray(body.stops)) body.stops = await withRanks(body.stops as Array<{ elements?: unknown }>, db);
  return json(200, body, TTL);
}

// '8辆' → 8, '208.95m' → 208.95
function leadingNumber(value: string | null | undefined): number | null {
  const m = /^\d+(?:\.\d+)?/.exec(value ?? '');
  return m ? +m[0] : null;
}

interface CarDetail {
  carCode?: string;
  trainStyle?: string;
  carType?: string;
  carInfo?: { pictureName: string; pictureValue?: string }[];
  coachPicList?: { pictureName: string; picOrder: number }[];
}

function parseTrainset(text: string) {
  const content = (JSON.parse(text) as { content: { status?: unknown; data?: CarDetail } }).content;
  if (typeof content !== 'object' || content === null) throw new TypeError('no content');
  if (content.status !== 0) {
    throw new ApiError(502, 'upstream_error', `12306 answered status ${content.status ?? 'None'}`);
  }
  const data = content.data;
  if (!data) return null;
  // A Map keeps 12306's order, which an object would not for numeric names
  const info = new Map<string, string | null>();
  for (const i of data.carInfo || []) {
    if (typeof i.pictureName !== 'string') throw new TypeError('carInfo without a name');
    info.set(i.pictureName, i.pictureValue || null);
  }
  const coaches = [...(data.coachPicList || [])].sort((a, b) => a.picOrder - b.picOrder);
  return {
    id: data.carCode || null,
    model: data.trainStyle || null,
    brand: data.carType || null,
    cars: leadingNumber(info.get('列车编组')),
    length_m: leadingNumber(info.get('列车长度')),
    capacity: leadingNumber(info.get('列车定员')),
    max_speed_kmh: leadingNumber(info.get('最高时速')),
    details: [...info].map(([k, v]) => ({ name: k, value: v })),
    coaches: coaches.map((c) => {
      if (typeof c.pictureName !== 'string') throw new TypeError('coach without a name');
      return c.pictureName;
    }),
  };
}

async function getTrainset(q: Params, code: string, fetch: Fetcher, today: string): Promise<ApiResponse> {
  const dateParam = q.get('date');
  const day = dateParam ? parseDate(dateParam) : today;
  // 12306 knows a train by one plain number: Z156/Z157B → Z156
  const name = unquote(code)
    .toUpperCase()
    .split('/')[0]
    .replace(/(?<=\d)[A-Z]+$/, '');
  if (!TRAIN_NUMBER.test(name)) throw badRequest('train must be a train number such as G1');
  const query = new URLSearchParams({ trainCode: name, runningDay: String(ymd(day)), reqType: 'form', carCode: name });
  const url = `${TRAINSET_URL}?${query}`;
  let upstream;
  try {
    upstream = await fetch(url, TTL_TRAINSET);
  } catch (e) {
    if (e instanceof UpstreamTimeout) throw new ApiError(504, 'upstream_timeout', '12306 did not respond in time');
    if (e instanceof UpstreamUnavailable)
      throw new ApiError(502, 'upstream_error', `could not reach 12306: ${e.message}`);
    throw e;
  }
  if (!(200 <= upstream.status && upstream.status < 300)) {
    throw new ApiError(502, 'upstream_error', `12306 returned HTTP ${upstream.status}`);
  }
  let trainset;
  try {
    trainset = parseTrainset(upstream.text);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, 'upstream_parse_error', "could not parse 12306's trainset answer");
  }
  return json(200, { source_url: url, train: name, date: day, trainset }, TTL_TRAINSET);
}

// ── Dispatch ────────────────────────────────────────────

type Endpoint = 'stations' | 'timetable' | 'train' | 'route' | 'trainset';

const PATHS: [Endpoint, RegExp][] = [
  ['stations', /^\/api\/v1\/cr\/stations$/],
  ['timetable', /^\/api\/v1\/cr\/stations\/([^/]+)\/timetable$/],
  ['train', /^\/api\/v1\/cr\/trains\/([^/]+)$/],
  ['route', /^\/api\/v1\/cr\/trains\/([^/]+)\/route$/],
  ['trainset', /^\/api\/v1\/cr\/trainsets\/([^/]+)$/],
];
const PARAMS: Record<Endpoint, string[]> = {
  stations: ['q'],
  timetable: ['date', 'hours'],
  train: ['date'],
  route: ['date'],
  trainset: ['date'],
};

export async function dispatchCr(
  path: string,
  search: URLSearchParams,
  db: Query | null,
  fetch: Fetcher,
  now: Date,
): Promise<ApiResponse> {
  for (const [name, pattern] of PATHS) {
    const m = pattern.exec(path);
    if (!m) continue;
    const q = new Params(search, PARAMS[name]);
    const today = localTime(now, CST_HOURS).date;
    if (name === 'trainset') return getTrainset(q, m[1], fetch, today);
    if (db === null) throw unavailable();
    try {
      if (name === 'stations') return await getStations(q, db);
      if (name === 'timetable') return await getTimetable(q, m[1], db, today);
      if (name === 'route') return await getRoute(q, m[1], db, today);
      return await getTrain(q, m[1], db, today);
    } catch (e) {
      if (e instanceof DataUnavailable) throw unavailable();
      throw e;
    }
  }
  throw notFound(path);
}
