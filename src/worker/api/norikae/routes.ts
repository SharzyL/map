// Yahoo! 乗換案内 route search: the result page's URL and its routes as
// JSON-ready objects. Pages are parsed with regular expressions; the parse
// functions throw on a page they cannot read, which the handler reports as 502.

const BASE_URL = 'https://transit.yahoo.co.jp/search/result';

export const TIME_TYPE_MAP: Record<string, string> = {
  departure: '1',
  arrival: '4',
  first_train: '3',
  last_train: '2',
  unspecified: '5',
};

export const TICKET_MAP: Record<string, string> = {
  ic: 'ic',
  cash: 'normal',
};

export const SEAT_MAP: Record<string, string> = {
  non_reserved: '1',
  reserved: '2',
  green: '3',
};

export const WALK_MAP: Record<string, string> = {
  fast: '1',
  slightly_fast: '2',
  slightly_slow: '3',
  slow: '4',
};

export const SORT_MAP: Record<string, string> = {
  time: '0',
  fare: '1',
  transfer: '2',
};

export interface BuildUrlArgs {
  stations: string[];
  date: string | null; // YYYY/MM/DD
  hour: number | null;
  minute: number | null;
  timeType: string; // a key of TIME_TYPE_MAP
  ticket: string;
  seatPreference: string;
  walkSpeed: string;
  sortBy: string;
  noAirline: boolean;
  noShinkansen: boolean;
  noExpress: boolean;
  noHighwayBus: boolean;
  noLocalBus: boolean;
  noFerry: boolean;
}

// Python's urllib.parse.quote_plus, which Yahoo's URLs have always been built with
function quotePlus(text: string): string {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export function buildUrl(args: BuildUrlArgs): string {
  const now = new Date();
  let [year, month, day] = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  if (args.date) {
    [year, month, day] = args.date.split('/').map((p) => pyInt(p));
  }
  const hour = args.hour ?? now.getHours();
  const minute = args.minute ?? now.getMinutes();
  const pad = (n: number) => String(n).padStart(2, '0');

  const params: [string, string][] = [
    ['from', args.stations[0]],
    ['to', args.stations[args.stations.length - 1]],
    ['y', String(year)],
    ['m', pad(month)],
    ['d', pad(day)],
    ['hh', String(hour)],
    ['m1', String(Math.floor(minute / 10))],
    ['m2', String(minute % 10)],
    ['type', TIME_TYPE_MAP[args.timeType]],
    ['ticket', TICKET_MAP[args.ticket]],
    ['expkind', SEAT_MAP[args.seatPreference]],
    ['ws', WALK_MAP[args.walkSpeed]],
    ['s', SORT_MAP[args.sortBy]],
    ['al', args.noAirline ? '0' : '1'],
    ['shin', args.noShinkansen ? '0' : '1'],
    ['ex', args.noExpress ? '0' : '1'],
    ['hb', args.noHighwayBus ? '0' : '1'],
    ['lb', args.noLocalBus ? '0' : '1'],
    ['sr', args.noFerry ? '0' : '1'],
  ];
  for (const station of args.stations.slice(1, -1).slice(0, 3)) params.push(['via', station]);

  return `${BASE_URL}?${params.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&')}`;
}

// Select a result page (3 routes per page)
export function withPage(url: string, page: number): string {
  if (page <= 1) return url;
  return `${url}&fl=${3 * (page - 1) + 1}&tl=${3 * page}`;
}

// ── Text helpers ──────────────────────────────────────

// Python's int(): digits of any script (full-width included), or throw
function pyInt(text: string): number {
  const digits = text.trim().normalize('NFKC');
  if (!/^[0-9]+$/.test(digits)) throw new Error(`not an integer: ${text}`);
  return Number(digits);
}

function pyFloat(text: string): number {
  const value = Number(text.normalize('NFKC'));
  if (!text || Number.isNaN(value)) throw new Error(`not a number: ${text}`);
  return value;
}

// Named references unescape() knows: the Latin-1 ones, which (with &amp; &lt;
// &gt; &quot;) also work without their semicolon, and a few common others
const LATIN1_ENTITIES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
  'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig ' +
  'Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash ' +
  'Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ' +
  'ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc ' +
  'uuml yacute thorn yuml';
const LEGACY_ENTITIES: Record<string, string> = {
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  COPY: '©',
  REG: '®',
};
LATIN1_ENTITIES.split(' ').forEach((name, i) => (LEGACY_ENTITIES[name] = String.fromCodePoint(0xa0 + i)));
const NAMED_ENTITIES: Record<string, string> = {
  ...LEGACY_ENTITIES,
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  euro: '€',
  trade: '™',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
};
// C1 controls that HTML reads as Windows-1252
const CP1252 = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ';

function numericEntity(num: number): string {
  if (num === 0) return '�';
  if (num === 0x0d) return '\r';
  if (num >= 0x80 && num <= 0x9f) return CP1252[num - 0x80];
  if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '�';
  if ((num >= 0x01 && num <= 0x08) || num === 0x0b || (num >= 0x0e && num <= 0x1f) || num === 0x7f) return '';
  if ((num >= 0xfdd0 && num <= 0xfdef) || (num & 0xfffe) === 0xfffe) return '';
  return String.fromCodePoint(num);
}

// Python's html.unescape, for the named references above
function unescapeHtml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      return numericEntity(parseInt(ref.slice(hex ? 2 : 1).replace(';', ''), hex ? 16 : 10));
    }
    if (ref.endsWith(';') && ref.slice(0, -1) in NAMED_ENTITIES) return NAMED_ENTITIES[ref.slice(0, -1)];
    // The longest legacy name the reference starts with, as in "&copy2026"
    for (let x = ref.length - 1; x > 1; x--) {
      const name = ref.slice(0, x);
      if (Object.hasOwn(LEGACY_ENTITIES, name)) return LEGACY_ENTITIES[name] + ref.slice(x);
    }
    return whole;
  });
}

function stripTags(fragment: string): string {
  return unescapeHtml(fragment.replace(/<[^>]+>/g, '')).trim();
}

// Drop 着/発 markers; preserve parens which mark pass-through stops
function cleanTime(text: string): string {
  return text.replaceAll('着', '').replaceAll('発', '');
}

function toMinutes(text: string): number | null {
  const m = /(\p{Nd}{1,2}):(\p{Nd}{2})/u.exec(text);
  return m ? pyInt(m[1]) * 60 + pyInt(m[2]) : null;
}

function parseYen(text: string): number | null {
  const m = /([\p{Nd},]+)円/u.exec(text);
  return m ? pyInt(m[1].replaceAll(',', '')) : null;
}

// "2時間30分" / "41分" / "1時間0分" → minutes
function parseDuration(text: string): number | null {
  const m = /^\s*(?:(\p{Nd}+)時間)?\s*(?:(\p{Nd}+)分)?\s*$/u.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return pyInt(m[1] ?? '0') * 60 + pyInt(m[2] ?? '0');
}

// ── Structured route data (HTML → JSON-ready objects) ──

export interface Place {
  name: string;
  id: string | null;
  time: string | null;
  platform: string | null;
}

export interface Stop {
  name: string;
  id: string | null;
  time: string;
}

export interface Surcharge {
  label: string;
  amount: number | null;
}

export interface Leg {
  mode: string; // train | bus | ferry | air | walk | other
  line: string | null;
  destination: string | null;
  duration_min: number | null;
  from: Place;
  to: Place;
  surcharges: Surcharge[];
  note: string | null;
  stops: Stop[];
}

export interface FareSection {
  from: string;
  to: string;
  mode: string;
  amount: number | null;
}

export interface FareItem {
  label: string;
  amount: number;
}

export interface Fare {
  label: string | null;
  total: number | null;
  breakdown: FareItem[];
  sections: FareSection[];
}

export interface Route {
  index: number;
  departure: string | null;
  arrival: string | null;
  duration_min: number | null;
  ride_min: number | null;
  transfers: number | null;
  distance_km: number | null;
  fare: Fare;
  legs: Leg[];
}

const MODE_ICONS: Record<string, string> = {
  icnTrain: 'train',
  icnBus: 'bus',
  icnShip: 'ferry',
  icnAir: 'air',
  icnWalk: 'walk',
};

const SURCHARGE_RE = /指定席|グリーン|自由席/;

function splitRouteBlocks(html: string): [number, string][] {
  const cleaned = html.replace(/<!--.*?-->/gs, '');
  const blocks = cleaned.matchAll(
    /id="route(\p{Nd}+)"[^>]*>(.*?)(?=<div[^>]*id="route\p{Nd}+"|<div[^>]*id="mdRouteSearch")/gsu,
  );
  return [...blocks].map((m) => [pyInt(m[1]), m[2]]);
}

// Error messages Yahoo shows when no route was found (e.g. unknown station)
export function routeErrors(html: string): string[] {
  const m = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/.exec(html);
  if (!m) return [];
  let errors: unknown;
  try {
    errors = JSON.parse(m[1]).props.pageProps.queryState.errorList;
  } catch {
    return [];
  }
  return Array.isArray(errors) ? errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))) : [];
}

// (li class, whitespace-normalized text) for each summary item
function summaryParts(block: string): [string, string][] {
  const m = /<ul class="summary">(.*?)<\/ul>/s.exec(block);
  if (!m) return [];
  return [...m[1].matchAll(/<li class="([\p{L}\p{N}_]+)"[^>]*>(.*?)<\/li>/gsu)].map((item) => [
    item[1],
    stripTags(item[2]).replace(/\s+/g, ' '),
  ]);
}

function stationTimes(chunk: string): string[] {
  const m = /<ul class="time">(.*?)<\/ul>/s.exec(chunk);
  if (!m) return [];
  return [...m[1].matchAll(/<li>(.*?)<\/li>/g)].map((t) => cleanTime(stripTags(t[1])));
}

// e.g. "[発] 9番線 → [着] 情報なし"
function parsePlatforms(chunk: string): [string | null, string | null] {
  const platform = /<li class="platform">(.*?)<\/li>/s.exec(chunk);
  if (!platform) return [null, null];
  const raw = stripTags(platform[1].replace(/<!--.*?-->/gs, ''));
  let dep: string | null = null;
  let arr: string | null = null;
  for (const part of raw.split('→')) {
    const m = /^\s*\[(発|着)\]\s*(.*?)\s*$/.exec(part);
    if (!m || !m[2] || m[2].includes('情報なし')) continue;
    if (m[1] === '発') dep = m[2];
    else arr = m[2];
  }
  return [dep, arr];
}

// (line name, destination) from an access chunk
function parseTransport(chunk: string): [string | null, string | null] {
  const transport = /<li class="transport"[^>]*>(.*?)<\/li>/s.exec(chunk);
  if (!transport) return [null, null];
  let inner = transport[1];
  // Extract destination separately (handle nested spans)
  let destination: string | null = null;
  const dest = /<span class="destination">(.*)<\/span><\/div>/s.exec(inner);
  if (dest) {
    // Remove "当駅始発" marker
    const destHtml = dest[1].replace(/<span class="icnFirstTrain">[^<]*<\/span>/g, '');
    destination = stripTags(destHtml) || null;
    inner = inner.slice(0, dest.index) + inner.slice(dest.index + dest[0].length);
  }
  // Remove line color span and icon spans
  inner = inner.replace(/<span class="line[^"]*"[^>]*><\/span>/g, '');
  return [stripTags(inner).replace(/\s+/g, ' ').trim(), destination];
}

function parseStops(chunk: string): Stop[] {
  const stop = /<li class="stop">(.*?)<\/ul><\/li>/s.exec(chunk);
  if (!stop) return [];
  return [...stop[1].matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(([, time, dd]) => {
    const code = /data-code="(\p{Nd}+)"/u.exec(dd);
    return { name: stripTags(dd), id: code ? code[1] : null, time: stripTags(time) };
  });
}

function parseLegs(block: string): [Leg[], FareSection[]] {
  const legs: Leg[] = [];
  const fareSections: FareSection[] = [];

  // Track station names for fare section labels
  let fareSectionStart = '';
  // Deferred base fare, resolved when the next station is encountered
  let hasPendingFare = false;
  let pendingFare: number | null = null;
  let pendingFareMode = '';
  // Walk resets fare section: the next station becomes the new section start
  let afterWalk = false;

  // Station the next leg departs from: name, id, departure time
  let current: [string, string | null, string | null] = ['', null, null];
  // Leg awaiting its arrival station, plus its arrival platform
  let pendingLeg: Leg | null = null;
  let pendingArrPlatform: string | null = null;

  // Find station and access elements in document order
  const elements = [...block.matchAll(/<div class="(station|access[^"]*)"[^>]*>/g)];

  elements.forEach((elem, i) => {
    const kind = elem[1];
    const end = i + 1 < elements.length ? elements[i + 1].index : block.length;
    const chunk = block.slice(elem.index, end);

    if (kind === 'station') {
      const times = stationTimes(chunk);
      const arr = times.length ? times[0] : null;
      const dep = times.length ? times[times.length - 1] : null;

      let name = '';
      const nameM = /<dt>(?:<a[^>]*>)?(.*?)(?:<\/a>)?<\/dt>/s.exec(chunk);
      if (nameM) {
        // Strip bus company suffix like "/十王自動車"
        name = stripTags(nameM[1]).replace(/\/[^/]+$/, '');
      }

      const sid = /href="\/station\/(\p{Nd}+)"/u.exec(chunk);
      const stationId = sid ? sid[1] : null;

      if (pendingLeg !== null) {
        pendingLeg.to = { name, id: stationId, time: arr, platform: pendingArrPlatform };
        const depMin = toMinutes(pendingLeg.from.time ?? '');
        const arrMin = toMinutes(arr ?? '');
        if (depMin !== null && arrMin !== null) {
          pendingLeg.duration_min = (((arrMin - depMin) % 1440) + 1440) % 1440;
        }
        legs.push(pendingLeg);
        pendingLeg = null;
      }

      // Resolve pending base fare now that we know the end station
      if (hasPendingFare) {
        fareSections.push({ from: fareSectionStart, to: name, mode: pendingFareMode, amount: pendingFare });
        fareSectionStart = name;
        hasPendingFare = false;
      }

      if (!fareSectionStart || afterWalk) {
        fareSectionStart = name;
        afterWalk = false;
      }

      current = [name, stationId, dep];
    } else {
      const icon = /<li class="transport".*?class="icon (icn[\p{L}\p{N}_]+)"/su.exec(chunk);
      let mode = icon ? (MODE_ICONS[icon[1]] ?? 'other') : 'other';
      let line: string | null = null;
      let destination: string | null = null;
      if (chunk.includes('icnWalk')) {
        mode = 'walk';
        afterWalk = true;
      } else {
        [line, destination] = parseTransport(chunk);
      }

      let depPlatform: string | null;
      [depPlatform, pendingArrPlatform] = parsePlatforms(chunk);

      // Fare elements: may have surcharge + base fare
      const surcharges: Surcharge[] = [];
      for (const fareM of chunk.matchAll(/<p class="fare"[^>]*>(.*?)<\/p>/gs)) {
        const fareText = stripTags(fareM[1]);
        if (!fareText) continue;
        if (SURCHARGE_RE.test(fareText)) {
          surcharges.push({ label: fareText.split('：')[0], amount: parseYen(fareText) });
        } else {
          hasPendingFare = true;
          pendingFare = parseYen(fareText);
          pendingFareMode = mode;
        }
      }

      const noteM = /<li class="note">(.*?)<\/li>/s.exec(chunk);
      let note: string | null = null;
      if (noteM) {
        note = stripTags(noteM[1].replace(/<span class="icnNote">[^<]*<\/span>/g, '')) || null;
      }

      const [name, stationId, dep] = current;
      pendingLeg = {
        mode,
        line,
        destination,
        duration_min: null,
        from: { name, id: stationId, time: dep, platform: depPlatform },
        to: { name: '', id: null, time: null, platform: null },
        surcharges,
        note,
        stops: mode === 'walk' ? [] : parseStops(chunk),
      };
    }
  });

  return [legs, fareSections];
}

function parseRoute(index: number, block: string): Route {
  const summary = new Map(summaryParts(block));

  let departure: string | null = null;
  let arrival: string | null = null;
  let durationMin: number | null = null;
  let rideMin: number | null = null;
  // "08:30発→11:00着2時間30分（乗車2時間30分）"
  const timeM = /^(\p{Nd}{1,2}:\p{Nd}{2})発→(\p{Nd}{1,2}:\p{Nd}{2})着(.*?)(?:（乗車(.*?)）)?$/u.exec(
    summary.get('time') ?? '',
  );
  if (timeM) {
    [departure, arrival] = [timeM[1], timeM[2]];
    durationMin = parseDuration(timeM[3]);
    rideMin = parseDuration(timeM[4] ?? '');
  }

  const transferM = /(\p{Nd}+)回/u.exec(summary.get('transfer') ?? '');
  const distanceM = /([\p{Nd}.]+)km/u.exec(summary.get('distance') ?? '');

  // "IC優先：14,720円（乗車券8,910円 特別料金5,810円）"
  const fare: Fare = { label: null, total: null, breakdown: [], sections: [] };
  const fareM = /^(?:(.*?)：)?([\p{Nd},]+)円(?:（(.*)）)?/u.exec(summary.get('fare') ?? '');
  if (fareM) {
    fare.label = fareM[1] ?? null;
    fare.total = pyInt(fareM[2].replaceAll(',', ''));
    for (const [, label, amount] of (fareM[3] ?? '').matchAll(/(\S+?)([\p{Nd},]+)円/gu)) {
      fare.breakdown.push({ label, amount: pyInt(amount.replaceAll(',', '')) });
    }
  }

  let legs: Leg[] = [];
  const detail = /<div class="routeDetail">(.*)/s.exec(block);
  if (detail) [legs, fare.sections] = parseLegs(detail[1]);

  return {
    index,
    departure,
    arrival,
    duration_min: durationMin,
    ride_min: rideMin,
    transfers: transferM ? pyInt(transferM[1]) : null,
    distance_km: distanceM ? pyFloat(distanceM[1]) : null,
    fare,
    legs,
  };
}

export function parseRoutes(html: string): Route[] {
  return splitRouteBlocks(html).map(([index, block]) => parseRoute(index, block));
}
