// The API's response types, as the doc shows them (src/worker/api/doc.md):
// each `// @doc <name>` line starts the section a `<!-- types: <name> -->`
// line of the doc stands for, up to the next one; the data build fills them
// in (data_builder/api-doc/render.py), without the `export`s. doc.test.ts
// holds them to what the API answers.

// @doc index
// GET /api/v1
export interface ApiIndex {
  name: string;
  doc: string; // this page, /api/v1/doc
  doc_markdown: string; // its Markdown, /api/v1/doc.md
  endpoints: string[]; // paths, with {placeholders}
}

// @doc japan
// The OSM features matched to a Yahoo station code, and their centre
export interface OsmMatch {
  osm: string[]; // N123, W123, R123; [] when unmatched
  lat: number | null; // null when osm is empty
  lon: number | null;
}

export interface Station extends OsmMatch {
  code: string; // Yahoo's station code
  name: string;
}

// @doc routes
export interface RoutesResponse {
  source_url: string;
  query: {
    from: string;
    to: string;
    via: string[];
    date: string;
    time: string;
    time_type: 'departure' | 'arrival' | 'first' | 'last' | 'unspecified';
    sort: 'time' | 'fare' | 'transfer';
    ticket: 'ic' | 'cash';
    seat: 'non_reserved' | 'reserved' | 'green';
    walk: 'fast' | 'slightly_fast' | 'slightly_slow' | 'slow';
    exclude: string[]; // sorted
    page: number;
  };
  routes: Route[];
}

export interface Route {
  index: number;
  departure: string | null;
  arrival: string | null;
  duration_min: number | null; // door to door
  ride_min: number | null; // time on board
  transfers: number | null;
  distance_km: number | null;
  fare: {
    label: string | null; // the fare basis Yahoo used (IC優先)
    total: number | null;
    breakdown: { label: string; amount: number }[]; // [] unless Yahoo splits the total
    sections: { from: string; to: string; mode: string; amount: number | null }[];
  };
  legs: Leg[];
}

export interface Leg {
  mode: 'train' | 'bus' | 'ferry' | 'air' | 'walk' | 'other';
  line: string | null; // null for walk
  destination: string | null;
  duration_min: number | null;
  from: Place;
  to: Place;
  surcharges: { label: string; amount: number | null }[];
  note: string | null;
  stops: (OsmMatch & { name: string; id: string | null; time: string })[]; // between from and to
}

export interface Place extends OsmMatch {
  name: string;
  id: string | null; // Yahoo's station code
  time: string | null;
  platform: string | null;
}

// @doc stations
export interface StationsResponse {
  source_url: string;
  results: (Station & {
    type: 'station' | 'bus' | string; // other kinds as Yahoo names them
    address: string; // the prefecture, as Yahoo gives it
    yahoo_lat: number | null; // Yahoo's own position, bus stops too
    yahoo_lon: number | null;
    yomi: string | null; // the reading in katakana
  })[];
}

// @doc lines
export interface LinesResponse {
  source_url: string;
  station: Station & { yomi: string | null };
  lines: {
    name: string;
    directions: {
      direction: string;
      gid: string; // for /timetables/{gid}
      source: string | null; // where its trains come from
    }[];
  }[];
}

// @doc station-status
export interface StationStatusResponse {
  source_url: string;
  lines: LineStatus[];
}

export interface LineStatus {
  line: string; // as in /timetables
  notices: Notice[];
  url: string | null; // Yahoo's page about the line's service
}

export interface Notice {
  status: string; // 列車遅延, 運転見合わせ, 運転再開, その他, ...
  message: string;
  cause: string | null;
  range: string | null; // 上下方面[全区間]
  updated: string | null; // YYYY-MM-DD HH:MM, Japan time
}

// @doc direction-status
export interface DirectionStatusResponse {
  source_url: string;
  line: string | null; // Yahoo's name for it in its service information
  notices: Notice[];
  url: string | null;
}

// @doc timetable
export interface TimetableResponse {
  source_url: string;
  station: Station;
  line: string;
  direction: string;
  source: string | null;
  day: 'weekday' | 'saturday' | 'holiday';
  departures: Departure[];
}

export interface Departure {
  time: string;
  train_id: string; // for /trains/{train_id}
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
  express_toll: boolean;
  kind_color: string | null; // #rrggbb
}

// @doc train
export interface TrainResponse {
  source_url: string;
  station: Station; // where the train was opened from
  train_id: string;
  name: string;
  line: string | null;
  comments: string[];
  stops: (Station & {
    arrival: string | null; // null at the origin; hours of later days go on from 24
    departure: string | null; // null at the terminus
  })[];
}

// @doc train-route
export interface TrainRouteResponse {
  data_version: string;
  bbox: [number, number, number, number] | null; // null without any track
  ways: number[];
  partial: string[]; // polylines
  overview: string[]; // polylines
  stops: {
    name: string;
    position: [number, number] | null; // [lon, lat]
    elements: string[] | null;
    rank: number | null;
  }[];
  legs: {
    from: string;
    to: string;
    line: string | null;
    method: 'line' | 'straight';
    straight?: string; // a polyline, for a straight leg with both ends known
  }[];
}

// @doc cr-stations
export interface CrStationsResponse {
  data_version: string;
  results: { name: string; telecode: string; pinyin: string | null }[];
}

// @doc cr-timetable
export interface CrTimetableResponse {
  data_version: string;
  station: { name: string; telecode: string };
  date: string;
  trains: {
    train: string;
    arrival: string | null; // null where it starts
    departure: string | null; // null where it ends
    origin: string;
    destination: string;
    day: number; // the day of the train's run, 1 = the day it left its origin
    platform: string | null;
    arrival_number: string | null; // the number it arrives and leaves under here
    departure_number: string | null;
    bound: '上行' | '下行' | null;
    line: string | null;
    line_in: string | null;
    line_out: string | null;
  }[];
}

// @doc cr-train
export interface CrTrainResponse {
  data_version: string;
  train: string; // as asked, upper case
  date: string;
  trains: CrTrainRun[]; // every train running under the number
}

export interface CrTrainRun {
  train: string;
  service: { from: string; to: string | null };
  runs: boolean; // whether it runs on date
  rolling_stock: {
    model: string | null;
    coupled: boolean;
    depot: string | null;
    description: string;
  } | null;
  lines: { name: string; stations: { name: string; km: number }[] }[];
  stops: {
    name: string;
    telecode: string | null;
    arrival: string | null;
    departure: string | null;
    day: number;
    km: number;
    platform: string | null;
    elements: string[] | null; // its OSM station elements; null unmatched
    position: [number, number] | null; // [lon, lat]
    arrival_number: string | null;
    departure_number: string | null;
    bound: '上行' | '下行' | null;
  }[];
}

// @doc cr-train-route
export type CrTrainRouteResponse = TrainRouteResponse; // as Japan's train route

// @doc cr-trainset
export interface CrTrainsetResponse {
  source_url: string;
  train: string;
  date: string;
  trainset: {
    id: string | null;
    model: string | null;
    brand: string | null;
    cars: number | null;
    length_m: number | null;
    capacity: number | null;
    max_speed_kmh: number | null;
    details: { name: string; value: string | null }[];
    coaches: string[];
  } | null; // null for a train 12306 assigns none to
}

// @doc relation
export interface RelationResponse {
  data_version: string;
  relation: RelationSummary;
  bbox: [number, number, number, number] | null;
  overview: string[]; // polylines
  length_m?: number; // left out for a route master
  ways?: number[]; // left out for a route master
  stops?: {
    name: string | null;
    position: [number, number]; // [lon, lat]
    elements: string[];
    km: number | null;
    rank: number;
  }[];
  routes?: RelationSummary[]; // a route master's routes, instead of ways and stops
}

export interface RelationSummary {
  id: number | string; // a string for Japan's official lines (jp-…)
  kind: 'route' | 'line' | 'master';
  type: string | null; // the route=* or route_master=* value
  name: string | null;
  ref: string | null;
  from: string | null;
  to: string | null;
  operator: string | null;
  network: string | null;
  colour: string | null;
  master: number | null;
  wikidata: string | null;
  wikipedia: string | null;
  aliases?: string[]; // Japan's official lines
  attribution?: { text: string; url: string }; // Japan's official lines
}

// @doc search
export interface SearchResponse {
  data_version: string | null; // null when trains were not searched
  stations_version: string | null; // null with type=train
  query: string;
  results: (TrainHit | StationHit)[];
}

export interface TrainHit {
  type: 'cr_train';
  train: string;
  origin: string;
  destination: string;
  service: { from: string; to: string | null };
}

export interface StationHit {
  type: 'station';
  country: 'cn' | 'jp';
  name: string;
  region: string[];
  osm: string[];
  lat: number | null;
  lon: number | null;
  yomi?: string | null; // Japan
  codes?: string[]; // Japan
  telecode?: string | null; // China
}

// @doc error
export interface ErrorResponse {
  error: { code: string; message: string };
}
