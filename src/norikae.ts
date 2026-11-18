// Client for this site's API (/api/v1/doc.md, served by the same Worker):
// Japanese station timetables from Yahoo! 乗換案内 (/api/v1/norikae),
// identified by Yahoo's station code (the export puts the codes on OSM
// stations in Japan as `yahoo_codes`), China Railway timetables (/api/v1/cr),
// whose stations the API finds by their OSM elements or name, with the
// trainsets 12306 assigns (/api/v1/cr/trainsets), the track trains run on, and
// OSM's railway routes and lines (/api/v1/relations), all answered with OSM
// ids the map's tiles share.

export const API_BASE = '/api/v1';

export type TimetableDay = 'weekday' | 'saturday' | 'holiday';
// Objects with a Yahoo station code also give the OSM features matched to it
// (N1, W2; [] for none) and their centre (null without any).
type OsmMatch = { osm?: string[]; lat?: number | null; lon?: number | null };
type YahooStation = { code: string; name: string } & OsmMatch;
export type NorikaeStation = YahooStation & {
  type: string;
  address: string;
  // Yahoo's own position, bus stops included.
  yahoo_lat?: number | null;
  yahoo_lon?: number | null;
};
export type StationLines = {
  source_url: string;
  station: YahooStation;
  lines: Array<{ name: string; directions: Array<{ direction: string; gid: string }> }>;
};
export type Departure = {
  time: string;
  train_id: string;
  kind: string | null;
  destination: string | null;
  extra: boolean;
  // The type, or service and number for named trains (特急わかしお1号).
  name?: string | null;
  // A printed timetable's one-character marks over the minute; null for the
  // line's usual type and destination.
  kind_mark?: string | null;
  destination_mark?: string | null;
  // As the station names it (3, 京葉1).
  track?: string | null;
  cars?: number | null;
  // The railway's own number (1803Y), not Yahoo's train_id.
  train_number?: string | null;
  starts_here?: boolean;
  green_car?: boolean;
};
export type DepartureTable = {
  source_url: string;
  station: YahooStation;
  line: string;
  direction: string;
  day: TimetableDay;
  departures: Departure[];
};
export type TrainStops = {
  source_url: string;
  station: YahooStation;
  train_id: string;
  name: string | null;
  line: string | null;
  comments: string[];
  stops: Array<
    {
      code: string | null;
      name: string;
      arrival: string | null;
      departure: string | null;
    } & OsmMatch
  >;
};

export type CrStationTrain = {
  train: string;
  arrival: string | null;
  departure: string | null;
  origin: string;
  destination: string;
  // Day of the train's run (1 = the day it left its origin) this stop falls on.
  day: number;
  platform: string | null;
  // The number it arrives and leaves under here (they differ where the
  // number changes); 下行 for an odd number, 上行 for an even one.
  arrival_number?: string | null;
  departure_number?: string | null;
  bound?: '上行' | '下行' | null;
  // The lines it arrives and leaves on (京沪, 京沪高速), and the one to group
  // it by: `line_out`, or `line_in` where it ends; null without one.
  line?: string | null;
  line_in?: string | null;
  line_out?: string | null;
};
export type CrStationTimetable = {
  data_version: string;
  station: { name: string; telecode: string };
  date: string;
  trains: CrStationTrain[];
};
export type CrStop = {
  name: string;
  telecode: string;
  arrival: string | null;
  departure: string | null;
  day: number;
  km: number;
  platform: string | null;
  // The OSM station features and their centre ([lon, lat]); null without a match.
  elements?: string[] | null;
  position?: [number, number] | null;
  arrival_number?: string | null;
  departure_number?: string | null;
  bound?: '上行' | '下行' | null;
};
// What the timetable says a train runs with: the model (null when its
// description names none), whether two sets run coupled, and the depot.
export type CrRollingStock = {
  model: string | null;
  coupled: boolean;
  depot: string | null;
  description: string | null;
};
// A railway line a train runs over, with every station it passes on it; `km`
// is on the stops' scale, and a line's last station is the next one's first.
export type CrLine = { name: string; stations: Array<{ name: string; km: number }> };
export type CrTrainRun = {
  train: string;
  service: { from: string; to: string | null };
  runs: boolean;
  rolling_stock?: CrRollingStock | null;
  lines?: CrLine[];
  stops: CrStop[];
};
export type CrTrainSchedule = {
  data_version: string;
  train: string;
  date: string;
  trains: CrTrainRun[];
};
// The trainset 12306 assigns to an EMU train on a day (/api/v1/cr/trainsets),
// asked live; null for trains it has none for.
export type CrTrainset = {
  source_url: string;
  train: string;
  date: string;
  trainset: {
    id: string;
    model: string | null;
    brand: string | null;
    cars: number | null;
    length_m: number | null;
    capacity: number | null;
    max_speed_kmh: number | null;
    details: Array<{ name: string; value: string | null }>;
    coaches: string[];
  } | null;
};

// A train's track (…/trains/{id}/route, /cr/trains/{train}/route): the OSM
// ways it covers whole, the parts of others as geometry, an outline for small
// scales, its stops on the track, and how each leg was found. Geometry is in
// encoded polylines (decodePolyline).
export type TrainRoute = {
  data_version: string;
  bbox: [number, number, number, number];
  ways: number[];
  partial: string[];
  overview: string[];
  stops: Array<{ name: string; position: [number, number] | null; elements: string[] | null }>;
  legs: Array<{
    from: string;
    to: string;
    line: string | null;
    method: 'line' | 'straight';
    straight?: string;
  }>;
};

export type RelationSummary = {
  id: number | string;
  kind: 'route' | 'line' | 'master';
  type: string;
  name: string | null;
  ref: string | null;
  from: string | null;
  to: string | null;
  operator: string | null;
  network: string | null;
  colour: string | null;
  master?: number | null;
  wikidata: string | null;
  wikipedia: string | null;
  // Japan's official lines (jp-…): other names on their track, and the credit
  // anything showing them must display.
  aliases?: string[];
  attribution?: { text: string; url: string };
};

// A route, line or route master (/api/v1/relations/{id}); a master lists `routes`
// instead of ways and stops.
export type RelationDetails = {
  data_version: string;
  relation: RelationSummary;
  bbox: [number, number, number, number];
  length_m?: number;
  overview: string[];
  ways?: number[];
  stops?: Array<{ name: string; position: [number, number] | null; elements: string[] | null; km: number | null }>;
  routes?: RelationSummary[];
};

export class NorikaeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Whether asking again may help: a network failure, a timeout or an upstream
// error the API reports with 5xx, but not a request it answered or rejected
// for good (404 for an unknown station or train, 400 for a bad one).
export function isRetryable(error: unknown) {
  if (!(error instanceof NorikaeError)) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

const responses = new Map<string, Promise<unknown>>();

// Forgets every answer, so the next request of each asks the API (for tests).
export function forgetResponses() {
  responses.clear();
}

// GET with an in-memory cache; the API sets its own Cache-Control as well.
async function get<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${query ? `?${query}` : ''}`;
  let response = responses.get(url) as Promise<T> | undefined;
  if (!response) {
    response = fetch(url, { signal }).then(async (res) => {
      const body = (await res.json().catch((): null => null)) as { error?: { message?: string } } | null;
      if (!res.ok) throw new NorikaeError(body?.error?.message || `HTTP ${res.status}`, res.status);
      return body as T;
    });
    responses.set(url, response);
    response.catch(() => responses.delete(url));
  }
  return response;
}

export function searchStations(name: string, signal?: AbortSignal) {
  return get<{ results: NorikaeStation[] }>('/norikae/stations', { q: name }, signal).then((body) => body.results);
}

export function stationLines(code: string, signal?: AbortSignal) {
  return get<StationLines>(`/norikae/stations/${encodeURIComponent(code)}/timetables`, {}, signal);
}

export function departures(code: string, gid: string, day: TimetableDay | null, signal?: AbortSignal) {
  return get<DepartureTable>(
    `/norikae/stations/${encodeURIComponent(code)}/timetables/${encodeURIComponent(gid)}`,
    day ? { day } : {},
    signal,
  );
}

export function trainStops(code: string, gid: string, trainId: string, signal?: AbortSignal) {
  return get<TrainStops>(
    `/norikae/stations/${encodeURIComponent(code)}/timetables/${encodeURIComponent(gid)}/trains/${encodeURIComponent(trainId)}`,
    {},
    signal,
  );
}

// `station` is a station name or comma-separated OSM elements (N1,W2); `date`
// defaults to today in China.
export function crStationTimetable(station: string, date: string | null, signal?: AbortSignal) {
  return get<CrStationTimetable>(`/cr/stations/${encodeURIComponent(station)}/timetable`, date ? { date } : {}, signal);
}

// `date` is the day the train leaves its origin.
export function crTrain(train: string, date: string, signal?: AbortSignal) {
  return get<CrTrainSchedule>(`/cr/trains/${encodeURIComponent(train)}`, { date }, signal);
}

// A China Railway train found by the start of its number (/api/v1/search,
// which will find stations and lines too, each result with its `type`);
// `train` is what /api/v1/cr/trains takes, one result per service period.
export type CrTrainHit = {
  type: 'cr_train';
  train: string;
  origin: string;
  destination: string;
  service: { from: string; to: string | null };
};

export function searchCrTrains(query: string, limit: number, signal?: AbortSignal) {
  return get<{ results: Array<{ type: string }> }>('/search', { q: query, limit: String(limit) }, signal).then((body) =>
    body.results.filter((result): result is CrTrainHit => result.type === 'cr_train'),
  );
}

// The day to show a found train on: today in China, or the nearest day of
// its service period when today is outside it.
export function crTrainHitDate(hit: Pick<CrTrainHit, 'service'>, today = chinaNow().date) {
  if (today < hit.service.from) return hit.service.from;
  if (hit.service.to && today > hit.service.to) return hit.service.to;
  return today;
}

// The trainset of a train leaving its origin on `date`, from 12306.
export function crTrainset(train: string, date: string, signal?: AbortSignal) {
  return get<CrTrainset>(`/cr/trainsets/${encodeURIComponent(train)}`, { date }, signal);
}

export function trainRoute(code: string, gid: string, trainId: string, signal?: AbortSignal) {
  return get<TrainRoute>(
    `/norikae/stations/${encodeURIComponent(code)}/timetables/${encodeURIComponent(gid)}/trains/${encodeURIComponent(trainId)}/route`,
    {},
    signal,
  );
}

export function crTrainRoute(train: string, date: string, signal?: AbortSignal) {
  return get<TrainRoute>(`/cr/trains/${encodeURIComponent(train)}/route`, { date }, signal);
}

export function relationDetails(id: string, signal?: AbortSignal) {
  return get<RelationDetails>(`/relations/${encodeURIComponent(id)}`, {}, signal);
}

// A Google encoded polyline as [lon, lat] points (the API encodes latitude
// first, precision 6).
export function decodePolyline(encoded: string, precision = 6): Array<[number, number]> {
  const factor = 10 ** precision;
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push([lon / factor, lat / factor]);
  }
  return points;
}

// Yahoo names stations as OSM does, but adds a suffix where a name is shared:
// 府中(東京都), 宇治(京阪線), 新宿(東京メトロ). Comparison ignores the suffix,
// full-width forms, ケ/ヶ and a trailing 駅 (scripts/stations/jp-station-codes.py
// uses the same rule).
export function normalizeStationName(name: string) {
  return name.normalize('NFKC').replace(/ヶ/g, 'ケ').replace(/ヵ/g, 'カ').replace(/\s/g, '').replace(/駅$/, '');
}

export function stationBaseName(name: string) {
  return name.normalize('NFKC').replace(/\(.+\)$/, '');
}

// Stations among search results that carry the given name, with or without a suffix.
export function stationsNamed(name: string, results: NorikaeStation[]) {
  const wanted = normalizeStationName(name);
  return results.filter(
    (result) => result.type === 'station' && normalizeStationName(stationBaseName(result.name)) === wanted,
  );
}

// Looks a station up by name: the search lists at most ten results, so an
// exact match can fall off a full list of longer names (長 under 長野, 長津田,
// ...), and searching for the name with 駅 finds it.
export async function findStationsByName(name: string, signal?: AbortSignal) {
  const plain = normalizeStationName(name);
  const results = await searchStations(plain, signal);
  const found = stationsNamed(plain, results);
  if (found.length > 0 || results.length < 10) return found;
  return stationsNamed(plain, await searchStations(`${plain}駅`, signal));
}

// The schedule that applies in Japan today (holidays other than Sunday are
// left to the API, which picks today's schedule itself when no day is given).
export function japanNow(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  return {
    minutes: jst.getUTCHours() * 60 + jst.getUTCMinutes(),
    weekday: jst.getUTCDay(),
  };
}

// Today's date and the time in China (UTC+8), as the China Railway timetables use.
export function chinaNow(now = new Date()) {
  const cst = new Date(now.getTime() + 8 * 3600_000);
  return { date: cst.toISOString().slice(0, 10), minutes: cst.getUTCHours() * 60 + cst.getUTCMinutes() };
}

// 'YYYY-MM-DD' moved by whole days.
export function addDays(date: string, days: number) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

export function minutesOf(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}
