// Timetable data from Yahoo! 乗換案内: station search, a station's lines, a
// line's departures and a train's stops. The pages embed their data as
// Next.js's __NEXT_DATA__ JSON, which is what these parse.

const BASE_URL = 'https://transit.yahoo.co.jp';
const SUGGEST_URL = `${BASE_URL}/api/suggest`;
const TIMETABLE_URL = `${BASE_URL}/timetable`;

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const SUGGEST_TYPES: Record<string, string> = { st: 'station', bu: 'bus' };
const DAY_KINDS: Record<string, string> = { '1': 'weekday', '2': 'saturday', '4': 'holiday' };

export interface StationRef {
  code: string;
  name: string;
}

export interface StationMatch extends StationRef {
  type: string; // station | bus | <raw Yahoo type>
  address: string;
  // Yahoo's own position
  yahoo_lat: number | null;
  yahoo_lon: number | null;
}

export interface Direction {
  direction: string;
  gid: string;
}

export interface Line {
  name: string;
  directions: Direction[];
}

export interface StationLines {
  station: StationRef;
  lines: Line[];
}

export interface Departure {
  time: string;
  train_id: string;
  kind: string | null;
  destination: string | null;
  extra: boolean;
  name: string | null;
  kind_mark: string | null;
  destination_mark: string | null;
  track: string | null;
  cars: number | null;
  train_number: string | null;
  starts_here: boolean;
  green_car: boolean;
}

export interface Timetable {
  station: StationRef;
  line: string;
  direction: string;
  day: string;
  departures: Departure[];
}

export interface TrainStop {
  code: string;
  name: string;
  arrival: string | null;
  departure: string | null;
}

export interface Train {
  station: StationRef;
  train_id: string;
  name: string;
  line: string | null;
  comments: string[];
  stops: TrainStop[];
}

// The pages' JSON is only loosely typed; `need` reads a key that must be there
type Obj = Record<string, any>;

function need(obj: Obj, key: string): any {
  if (obj === null || typeof obj !== 'object' || !(key in obj)) throw new Error(`missing ${key}`);
  return obj[key];
}

function extractNextData(html: string): Obj {
  // [^\n] rather than `.`, which in JS also stops at \r and line separators
  const m = /<script id="__NEXT_DATA__" type="application\/json">([^\n]*?)<\/script>/.exec(html);
  if (!m) throw new Error('Could not find __NEXT_DATA__ in page');
  return JSON.parse(m[1]);
}

function pageProps(html: string): Obj {
  return need(need(extractNextData(html), 'props'), 'pageProps');
}

// Python's int() of a string of decimal digits, full-width ones included
function pyInt(value: unknown): number {
  const text = String(value).trim().normalize('NFKC');
  if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) throw new Error(`not an integer: ${String(value)}`);
  return parseInt(text.replace(/_/g, ''), 10);
}

// urllib.parse.quote: everything but letters, digits, _.-~ and / is escaped
function quote(text: string): string {
  return encodeURIComponent(text)
    .replace(/%2F/g, '/')
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ── URLs ────────────────────────────────────────────

export function searchUrl(query: string): string {
  return `${SUGGEST_URL}?value=${quote(query)}`;
}

export function linesUrl(code: string): string {
  return `${TIMETABLE_URL}/${code}`;
}

export function timetableUrl(code: string, gid: string, kind: string | null): string {
  let url = `${TIMETABLE_URL}/${code}/${gid}`;
  if (kind) url += `?kind=${kind}`;
  return url;
}

export function trainUrl(code: string, gid: string, trainId: string): string {
  return `${TIMETABLE_URL}/${code}/${gid}/${trainId}`;
}

// ── Parsers ─────────────────────────────────────────

function coord(value: unknown): number | null {
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  return Number(Number(text).toFixed(6));
}

export function parseSearch(payload: unknown): StationMatch[] {
  const results: Obj[] = need(payload as Obj, 'Result');
  return results.map((r) => {
    const id: string = need(r, 'Id');
    return {
      code: need(r, 'Code'),
      name: need(r, 'Suggest'),
      type: SUGGEST_TYPES[id] ?? id,
      address: need(r, 'Address'),
      yahoo_lat: coord(r.Lat ?? ''),
      yahoo_lon: coord(r.Lon ?? ''),
    };
  });
}

function routeInfos(detail: Obj): Obj[] {
  return need(need(detail, 'directionItem'), 'routeInfos');
}

export function parseLines(html: string, code: string): StationLines {
  const detail = need(pageProps(html), 'directionDetail');
  return {
    station: { code, name: need(detail, 'stationName') },
    lines: routeInfos(detail).map((route) => ({
      name: need(route, 'railName'),
      directions: (need(route, 'railGroup') as Obj[]).map((g) => ({
        direction: need(g, 'direction'),
        gid: need(g, 'groupId'),
      })),
    })),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function parseTimetable(html: string, code: string): Timetable {
  const tt = need(pageProps(html), 'timetableItem');
  const master = need(tt, 'master');
  const dests = new Map<string, Obj>((need(master, 'destination') as Obj[]).map((d) => [need(d, 'id'), d]));
  const kinds = new Map<string, Obj>((need(master, 'kind') as Obj[]).map((k) => [need(k, 'id'), k]));
  const departures: Departure[] = [];
  for (const hourEntry of need(tt, 'hourTimeTable') as Obj[]) {
    const hour = pyInt(need(hourEntry, 'hour'));
    for (const t of need(hourEntry, 'minTimeTable') as Obj[]) {
      const kind = kinds.get(need(t, 'kindId'));
      const dest = dests.get(need(t, 'destinationId'));
      const cars = String(t.numOfCar || '');
      const extra = need(t, 'extraTrain');
      departures.push({
        time: `${pad2(hour)}:${pad2(pyInt(need(t, 'minute')))}`,
        train_id: need(t, 'trainId'),
        kind: kind ? need(kind, 'name') : null,
        destination: dest ? need(dest, 'name') : null,
        extra: extra === 'true' || extra === true,
        name: t.trainName || null,
        // The one-character marks Yahoo prints over the minute (特, 府)
        kind_mark: kind ? kind.info || null : null,
        destination_mark: dest ? dest.info || null : null,
        track: t.trackNumber || null,
        cars: /^\p{Nd}+$/u.test(cars) ? pyInt(cars) : null,
        train_number: t.vendorTrainId || null,
        starts_here: t.firstStation === 'true' || t.firstStation === true,
        green_car: Object.values((t.greenCar || {}) as Obj).some(Boolean),
      });
    }
  }
  const day: string = need(tt, 'driveDayKind');
  return {
    station: { code, name: need(tt, 'stationName') },
    line: need(tt, 'railName'),
    direction: need(tt, 'directionName'),
    day: DAY_KINDS[day] ?? day,
    departures,
  };
}

// Yahoo's 816 or 0816 → 08:16
function hhmm(raw: string | null): string | null {
  if (!raw) return null;
  const padded = raw.padStart(4, '0');
  return `${padded.slice(0, 2)}:${padded.slice(2)}`;
}

export function parseTrain(html: string, code: string, gid: string | null = null): Train {
  const page = pageProps(html);
  const tt = need(need(page, 'timetableStationTrainResult'), 'timetable');
  const detail = need(page, 'directionDetail');
  const routes = routeInfos(detail);
  // The page lists every line at the station; the train's is the one whose
  // directions include the timetable it was opened from
  const fallback = routes.length ? need(routes[0], 'railName') : null;
  const own = routes.find((r) => (need(r, 'railGroup') as Obj[]).some((g) => need(g, 'groupId') === gid));
  return {
    station: { code, name: need(detail, 'stationName') },
    train_id: need(tt, 'trainId'),
    name: need(tt, 'displayName'),
    line: own ? need(own, 'railName') : fallback,
    comments: [need(tt, 'driveComment'), need(tt, 'guideComment')].filter(Boolean),
    stops: (need(tt, 'stopStation') as Obj[]).map((stop) => ({
      code: need(stop, 'stationCode'),
      name: need(stop, 'stationName'),
      arrival: hhmm(need(stop, 'arrivalTime')),
      departure: hhmm(need(stop, 'departureTime')),
    })),
  };
}
