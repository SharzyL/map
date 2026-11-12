// Client for the norikae API (https://norikae.shz.al/v1/doc.md): Japanese
// station timetables from Yahoo! 乗換案内, identified by Yahoo's station code
// (the export puts the codes on OSM stations in Japan as `yahoo_codes`), and
// China Railway timetables (/v1/cr-*), whose stations the API finds by their
// OSM elements or name.

export const NORIKAE_API = 'https://norikae.shz.al/v1';

export type TimetableDay = 'weekday' | 'saturday' | 'holiday';
export type NorikaeStation = { code: string; name: string; type: string; address: string };
export type StationLines = {
  source_url: string;
  station: { code: string; name: string };
  lines: Array<{ name: string; directions: Array<{ direction: string; gid: string }> }>;
};
export type Departure = {
  time: string;
  train_id: string;
  kind: string | null;
  destination: string | null;
  extra: boolean;
};
export type DepartureTable = {
  source_url: string;
  station: { code: string; name: string };
  line: string;
  direction: string;
  day: TimetableDay;
  departures: Departure[];
};
export type TrainStops = {
  source_url: string;
  station: { code: string; name: string };
  train_id: string;
  name: string | null;
  line: string | null;
  comments: string[];
  stops: Array<{ code: string | null; name: string; arrival: string | null; departure: string | null }>;
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
};
export type CrTrainSchedule = {
  data_version: string;
  train: string;
  date: string;
  trains: Array<{ train: string; service: { from: string; to: string | null }; runs: boolean; stops: CrStop[] }>;
};

export class NorikaeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const responses = new Map<string, Promise<unknown>>();

// GET with an in-memory cache; the API sets its own Cache-Control as well.
async function get<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const url = `${NORIKAE_API}${path}${query ? `?${query}` : ''}`;
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
  return get<{ results: NorikaeStation[] }>('/stations', { q: name }, signal).then((body) => body.results);
}

export function stationLines(code: string, signal?: AbortSignal) {
  return get<StationLines>(`/stations/${encodeURIComponent(code)}/timetables`, {}, signal);
}

export function departures(code: string, gid: string, day: TimetableDay | null, signal?: AbortSignal) {
  return get<DepartureTable>(
    `/stations/${encodeURIComponent(code)}/timetables/${encodeURIComponent(gid)}`,
    day ? { day } : {},
    signal,
  );
}

export function trainStops(code: string, gid: string, trainId: string, signal?: AbortSignal) {
  return get<TrainStops>(
    `/stations/${encodeURIComponent(code)}/timetables/${encodeURIComponent(gid)}/trains/${encodeURIComponent(trainId)}`,
    {},
    signal,
  );
}

// `station` is a station name or comma-separated OSM elements (N1,W2); `date`
// defaults to today in China.
export function crStationTimetable(station: string, date: string | null, signal?: AbortSignal) {
  return get<CrStationTimetable>(`/cr-stations/${encodeURIComponent(station)}/timetable`, date ? { date } : {}, signal);
}

// `date` is the day the train leaves its origin.
export function crTrain(train: string, date: string, signal?: AbortSignal) {
  return get<CrTrainSchedule>(`/cr-trains/${encodeURIComponent(train)}`, { date }, signal);
}

// Yahoo names stations as OSM does, but adds a suffix where a name is shared:
// 府中(東京都), 宇治(京阪線), 新宿(東京メトロ). Comparison ignores the suffix,
// full-width forms, ケ/ヶ and a trailing 駅 (scripts/tiles/jp-station-codes.py
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
