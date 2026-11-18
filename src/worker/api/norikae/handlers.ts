// Japanese routes, stations, timetables and trains (/api/v1/norikae), scraped
// from Yahoo! 乗換案内. Runs in the Durable Object placed in Japan (runtime.ts),
// so Yahoo sees every request come from there.

import {
  API_PREFIX,
  ApiError,
  type ApiResponse,
  badRequest,
  type Fetcher,
  JST_HOURS,
  json,
  localTime,
  MAX_TEXT_LEN,
  notFound,
  Params,
  parseHours,
  parseDate,
  UpstreamTimeout,
  UpstreamUnavailable,
} from '../core.js';
import { JP } from '../osm-stations.js';
import * as routes from './routes.js';
import * as timetable from './timetable.js';

export const NORIKAE_PREFIX = `${API_PREFIX}/norikae/`;

// Upstream + client cache lifetimes (seconds)
const TTL_ROUTES = 300;
const TTL_SEARCH = 86400;
const TTL_LINES = 86400;
const TTL_TIMETABLE = 3600;
// Without ?day=, Yahoo serves "today's" schedule — keep short so it rolls over
const TTL_TIMETABLE_TODAY = 600;
const TTL_TRAIN = 3600;

const MAX_VIA = 3;
const MAX_PAGE = 20;

const TIME_TYPES: Record<string, string> = {
  departure: 'departure',
  arrival: 'arrival',
  first: 'first_train',
  last: 'last_train',
  unspecified: 'unspecified',
};
const EXCLUDES = new Set(['shinkansen', 'express', 'airline', 'highway_bus', 'local_bus', 'ferry']);
const DAY_PARAMS: Record<string, string> = { weekday: '1', saturday: '2', holiday: '4' };
const STATION_TYPES = ['station', 'bus', 'all'];

function parseTime(value: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m || +m[1] > 23 || +m[2] > 59) throw badRequest('time must be HH:MM (00:00–23:59)');
  return [+m[1], +m[2]];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// ── Upstream access ─────────────────────────────────────

async function get(fetch: Fetcher, url: string, ttl: number, missing: string): Promise<string> {
  let upstream;
  try {
    upstream = await fetch(url, ttl);
  } catch (e) {
    if (e instanceof UpstreamTimeout) throw new ApiError(504, 'upstream_timeout', 'Yahoo did not respond in time');
    if (e instanceof UpstreamUnavailable)
      throw new ApiError(502, 'upstream_error', `could not reach Yahoo: ${e.message}`);
    throw e;
  }
  if (upstream.status === 404) throw new ApiError(404, 'not_found', missing);
  // Yahoo answers input it won't take (e.g. a search with < & / ' " \) with an
  // empty 400: that is the caller's request, not an outage
  if (upstream.status === 400) throw new ApiError(400, 'bad_request', 'Yahoo rejected the request');
  // Yahoo answers 403 to some regions. The API runs in Japan to avoid that, but
  // Durable Object placement is best effort
  if (upstream.status === 403) {
    throw new ApiError(503, 'region_unavailable', 'API not available in your region temporarily');
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    throw new ApiError(502, 'upstream_error', `Yahoo returned HTTP ${upstream.status}`);
  }
  return upstream.text;
}

function parseFailed(what: string): ApiError {
  return new ApiError(502, 'upstream_parse_error', `could not parse Yahoo ${what} page`);
}

// A parser throws on a page it does not understand
function parse<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch {
    throw parseFailed(what);
  }
}

// ── OSM references ──────────────────────────────────────

type Place = Record<string, unknown>;

function withOsm<T extends Place>(place: T, key = 'code') {
  const code = place[key];
  const match = typeof code === 'string' ? JP.get(code) : undefined;
  if (!match) return { ...place, osm: [] as string[], lat: null as number | null, lon: null as number | null };
  return { ...place, osm: match.osm, lat: match.lat, lon: match.lon };
}

function routeWithOsm(route: routes.Route) {
  const legs = route.legs.map((leg) => ({
    ...leg,
    from: withOsm(leg.from as unknown as Place, 'id'),
    to: withOsm(leg.to as unknown as Place, 'id'),
    stops: leg.stops.map((s) => withOsm(s as unknown as Place, 'id')),
  }));
  return { ...route, legs };
}

// ── Handlers ────────────────────────────────────────────

const ROUTE_PARAMS = [
  'from',
  'to',
  'via',
  'date',
  'time',
  'time_type',
  'sort',
  'ticket',
  'seat',
  'walk',
  'exclude',
  'page',
];

async function getRoutes(q: Params, fetch: Fetcher, now: Date): Promise<ApiResponse> {
  const origin = q.text('from', true);
  const dest = q.text('to', true);
  const via = q.all('via');
  if (via.length > MAX_VIA) throw badRequest(`at most ${MAX_VIA} via stations`);
  if (via.some((v) => [...v].length > MAX_TEXT_LEN)) throw badRequest(`via must be at most ${MAX_TEXT_LEN} characters`);

  const japan = localTime(now, JST_HOURS);
  const dateParam = q.get('date');
  const day = dateParam ? parseDate(dateParam) : japan.date;
  const timeType = q.choice('time_type', Object.keys(TIME_TYPES), 'departure');
  const timeParam = q.get('time');
  if (timeParam && timeType !== 'departure' && timeType !== 'arrival') {
    throw badRequest('time is only valid with time_type=departure|arrival');
  }
  const [hour, minute] = timeParam ? parseTime(timeParam) : [japan.hour, japan.minute];

  const excludes = new Set<string>();
  for (const raw of q.all('exclude').join(',').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    if (item === 'bus') {
      excludes.add('highway_bus');
      excludes.add('local_bus');
    } else if (EXCLUDES.has(item)) {
      excludes.add(item);
    } else {
      const allowed = [...EXCLUDES, 'bus'].sort().join(', ');
      throw badRequest(`exclude must be a comma list of: ${allowed}`);
    }
  }

  const sort = q.choice('sort', Object.keys(routes.SORT_MAP), 'time');
  const ticket = q.choice('ticket', Object.keys(routes.TICKET_MAP), 'ic');
  const seat = q.choice('seat', Object.keys(routes.SEAT_MAP), 'non_reserved');
  const walk = q.choice('walk', Object.keys(routes.WALK_MAP), 'slightly_slow');
  const page = q.integer('page', 1, 1, MAX_PAGE);

  const url = routes.withPage(
    routes.buildUrl({
      stations: [origin, ...via, dest],
      date: day.replaceAll('-', '/'),
      hour,
      minute,
      timeType: TIME_TYPES[timeType],
      ticket,
      seatPreference: seat,
      walkSpeed: walk,
      sortBy: sort,
      noAirline: excludes.has('airline'),
      noShinkansen: excludes.has('shinkansen'),
      noExpress: excludes.has('express'),
      noHighwayBus: excludes.has('highway_bus'),
      noLocalBus: excludes.has('local_bus'),
      noFerry: excludes.has('ferry'),
    }),
    page,
  );
  const html = await get(fetch, url, TTL_ROUTES, 'route search page not found');

  const found = parse('route', () => routes.parseRoutes(html));
  if (!found.length) {
    const errors = routes.routeErrors(html);
    if (errors.length) throw new ApiError(404, 'not_found', errors.join(' '));
    throw parseFailed('route');
  }

  return json(
    200,
    {
      source_url: url,
      query: {
        from: origin,
        to: dest,
        via,
        date: day,
        time: `${pad2(hour)}:${pad2(minute)}`,
        time_type: timeType,
        sort,
        ticket,
        seat,
        walk,
        exclude: [...excludes].sort(),
        page,
      },
      routes: found.map(routeWithOsm),
    },
    TTL_ROUTES,
  );
}

async function getStations(q: Params, fetch: Fetcher): Promise<ApiResponse> {
  const query = q.text('q', true);
  const kind = q.choice('type', STATION_TYPES, 'station');
  const url = timetable.searchUrl(query);
  const text = await get(fetch, url, TTL_SEARCH, 'station search not found');
  let results = parse('station search', () => timetable.parseSearch(JSON.parse(text)));
  if (kind !== 'all') results = results.filter((r) => r.type === kind);
  return json(200, { source_url: url, results: results.map((r) => withOsm(r as unknown as Place)) }, TTL_SEARCH);
}

async function getLines(code: string, fetch: Fetcher): Promise<ApiResponse> {
  const url = timetable.linesUrl(code);
  const html = await get(fetch, url, TTL_LINES, `station ${code} not found`);
  const data = parse('timetable lines', () => timetable.parseLines(html, code));
  const station = withOsm(data.station as unknown as Place);
  return json(200, { source_url: url, ...data, station }, TTL_LINES);
}

async function getTimetable(q: Params, code: string, gid: string, fetch: Fetcher): Promise<ApiResponse> {
  const day = q.get('day');
  if (day !== null && !(day in DAY_PARAMS))
    throw badRequest(`day must be one of: ${Object.keys(DAY_PARAMS).join(', ')}`);
  const hoursParam = q.get('hours');
  const hours = hoursParam ? parseHours(hoursParam) : null;

  const url = timetable.timetableUrl(code, gid, day ? DAY_PARAMS[day] : null);
  const ttl = day ? TTL_TIMETABLE : TTL_TIMETABLE_TODAY;
  const html = await get(fetch, url, ttl, `timetable ${code}/${gid} not found`);
  const data = parse('timetable', () => timetable.parseTimetable(html, code));
  if (hours) {
    const [lo, hi] = hours;
    data.departures = data.departures.filter((d) => lo <= +d.time.slice(0, 2) && +d.time.slice(0, 2) <= hi);
  }
  const station = withOsm(data.station as unknown as Place);
  return json(200, { source_url: url, ...data, station }, ttl);
}

async function getTrain(code: string, gid: string, trainId: string, fetch: Fetcher): Promise<ApiResponse> {
  const url = timetable.trainUrl(code, gid, trainId);
  const html = await get(fetch, url, TTL_TRAIN, `train ${trainId} not found`);
  const data = parse('train', () => timetable.parseTrain(html, code, gid));
  const station = withOsm(data.station as unknown as Place);
  const stops = data.stops.map((s) => withOsm(s as unknown as Place));
  return json(200, { source_url: url, ...data, station, stops }, TTL_TRAIN);
}

// ── Dispatch ────────────────────────────────────────────

const STATION = `^${NORIKAE_PREFIX}stations/(\\d+)/timetables`;
const PATHS: Array<[string, RegExp, string[]]> = [
  ['routes', new RegExp(`^${NORIKAE_PREFIX}routes$`), ROUTE_PARAMS],
  ['stations', new RegExp(`^${NORIKAE_PREFIX}stations$`), ['q', 'type']],
  ['lines', new RegExp(`${STATION}$`), []],
  ['timetable', new RegExp(`${STATION}/(\\d+)$`), ['day', 'hours']],
  ['train', new RegExp(`${STATION}/(\\d+)/trains/(\\d+)$`), []],
];

// `path` has no trailing slash; throws ApiError
export async function dispatchNorikae(
  path: string,
  search: URLSearchParams,
  fetch: Fetcher,
  now: Date,
): Promise<ApiResponse> {
  for (const [name, pattern, allowed] of PATHS) {
    const m = pattern.exec(path);
    if (!m) continue;
    const q = new Params(search, allowed);
    if (name === 'routes') return getRoutes(q, fetch, now);
    if (name === 'stations') return getStations(q, fetch);
    if (name === 'lines') return getLines(m[1], fetch);
    if (name === 'timetable') return getTimetable(q, m[1], m[2], fetch);
    return getTrain(m[1], m[2], m[3], fetch);
  }
  throw notFound(path);
}
