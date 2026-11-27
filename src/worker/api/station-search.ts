// The stations /api/v1/search finds (search.ts): China Railway's and Japan's,
// as data_builder/stations/station-index.py writes them with the keys
// search-keys.mjs adds, bundled with the Worker
// (`build-data/search-stations.json`) and parsed on an isolate's first search,
// which is all the work an isolate does before its first answer.
//
// Only names are matched, however they are written: names and queries are
// folded alike (foldName), so simplified Chinese finds Japanese and
// traditional names (涩谷 finds 渋谷, 东京 東京), hiragana finds katakana,
// and a trailing 駅 or 站 does no harm. A Japanese station is also found by
// its reading, in kana or romaji (シンジュク, しんじゅく, shinjuku, Shinjuku),
// and a Chinese one by its pinyin or its initials (beijingxi, bjx). Romaji is
// compared after folding the ways of writing it (romajiKey): Hepburn, kunrei
// and long vowels written or not (Tōkyō, toukyou, tokyo). The folding is
// search-keys.ts's.
//
// The region (Japan's prefecture and municipality, China's province, city and
// district) is shown, never matched.

import stationsJson from 'build-data/search-stations.json?raw';
import foldPairs from './han-fold.json';
import { hanFolder, romajiKey } from './search-keys.js';

export interface IndexedStation {
  c: 'cn' | 'jp';
  n: string; // name
  y?: string | null; // reading, katakana (Japan)
  r: string[]; // region, largest first
  o: string[]; // OSM features
  p: [number, number] | null; // lat, lon
  k?: string[]; // Yahoo codes (Japan)
  t?: string | null; // telecode (China)
  l: string[]; // romaji (Japan) or pinyin and initials (China)
  w: number; // 0..1000, how busy within its country
  f: string[]; // keys: folded name and reading (search-keys.ts stationKeys)
  a: string[]; // keys: romaji (Japan), pinyin and initials (China)
}

export interface StationHit {
  type: 'station';
  country: 'cn' | 'jp';
  name: string;
  yomi?: string | null;
  region: string[];
  osm: string[];
  lat: number | null;
  lon: number | null;
  codes?: string[];
  telecode?: string | null;
}

export const foldName = hanFolder(foldPairs as string);

// ── The index ───────────────────────────────────────────

// How a station matched: its name or reading whole, at its start, inside it
const EXACT = 0;
const PREFIX = 1;
const INSIDE = 2;
type Match = typeof EXACT | typeof PREFIX | typeof INSIDE;

function matchOf(keys: string[], query: string, inside: boolean): Match | null {
  let best: Match | null = null;
  for (const key of keys) {
    if (key === query) return EXACT;
    if (key.startsWith(query)) best = PREFIX;
    else if (inside && best === null && key.includes(query)) best = INSIDE;
  }
  return best;
}

export class StationIndex {
  readonly version: string;
  readonly stations: IndexedStation[];

  constructor(version: string, stations: IndexedStation[]) {
    this.version = version;
    this.stations = stations;
  }

  // Exact matches first, then names starting with the query, then those
  // holding it (for two characters or more; romaji only from the start); the
  // busiest first within each, then the shortest name.
  find(text: string, limit: number): IndexedStation[] {
    let name = foldName(text);
    const latin = /^[a-z]+$/.test(name);
    // tokyo station
    if (latin) name = name.replace(/(?<=..)station$/, '');
    if (!name) return [];
    const key = latin ? romajiKey(name) : '';
    const inside = [...name].length >= 2;
    const found: [Match, IndexedStation][] = [];
    for (const station of this.stations) {
      let match = matchOf(station.f, name, inside);
      const romajiMatch = latin ? matchOf(station.a, station.c === 'jp' ? key : name, false) : null;
      if (romajiMatch !== null && (match === null || romajiMatch < match)) match = romajiMatch;
      if (match !== null) found.push([match, station]);
    }
    found.sort(
      ([ma, a], [mb, b]) => ma - mb || b.w - a.w || a.n.length - b.n.length || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0),
    );
    return found.slice(0, limit).map(([, station]) => station);
  }
}

export function stationHit(s: IndexedStation): StationHit {
  const hit: StationHit = {
    type: 'station',
    country: s.c,
    name: s.n,
    region: s.r,
    osm: s.o,
    lat: s.p ? s.p[0] : null,
    lon: s.p ? s.p[1] : null,
  };
  if (s.c === 'jp') {
    hit.yomi = s.y ?? null;
    hit.codes = s.k ?? [];
  } else {
    hit.telecode = s.t ?? null;
  }
  return hit;
}

let index: StationIndex | null = null;

export function stationIndex(): StationIndex {
  if (index === null) {
    const data = JSON.parse(stationsJson) as { version: string; stations: IndexedStation[] };
    index = new StationIndex(data.version, data.stations);
  }
  return index;
}
