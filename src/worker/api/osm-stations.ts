// OSM features and positions of Yahoo station codes, from the station files
// bundled with the Worker: jp-station-codes.csv (OSM feature → Yahoo codes)
// and station-coords.csv (OSM feature → position). The build makes them
// (data_builder/stations/); `station-data/` is where vite.config.js finds them, and
// a few stations' worth in fixtures/stations/ where it does not.

import codesCsv from 'station-data/jp-station-codes.csv?raw';
import coordsCsv from 'station-data/station-coords.csv?raw';
import { sum } from './geo.js';

export interface Match {
  osm: string[]; // N123 / W123 / R123
  lat: number | null; // centre of the features
  lon: number | null;
}

// Rows of a CSV file without quoted fields, as the station files are
export function csvRows(text: string): Record<string, string>[] {
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const names = head.split(',');
  return lines.map((line) => {
    const values = line.split(',');
    return Object.fromEntries(names.map((name, k) => [name, values[k] ?? '']));
  });
}

export function match(refs: string[], coords: Map<string, [number, number]>): Match {
  // jp-station-codes.py only keeps features near Yahoo's position of the
  // code, so they are one place. Features without a position (deleted from
  // OSM, or station-coords.csv is older) are listed but not averaged.
  const placed = refs.filter((r) => coords.has(r)).map((r) => coords.get(r));
  if (!placed.length) return { osm: refs, lat: null, lon: null };
  const lat = sum(placed.map((p) => p[0])) / placed.length;
  const lon = sum(placed.map((p) => p[1])) / placed.length;
  return { osm: refs, lat: +lat.toFixed(6), lon: +lon.toFixed(6) };
}

export function loadJp(codes: string, coordinates: string): Map<string, Match> {
  const coords = new Map<string, [number, number]>(
    csvRows(coordinates).map((r) => [r.osm_type + r.osm_id, [parseFloat(r.lat), parseFloat(r.lon)]]),
  );
  const refs = new Map<string, string[]>();
  for (const row of csvRows(codes)) {
    for (const code of row.codes.split(';')) {
      if (!refs.has(code)) refs.set(code, []);
      refs.get(code).push(row.osm_type + row.osm_id);
    }
  }
  return new Map([...refs].map(([code, rs]) => [code, match(rs, coords)]));
}

// Yahoo station code → its OSM features and position
export const JP = loadJp(codesCsv, coordsCsv);
