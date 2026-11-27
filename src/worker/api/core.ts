// Plumbing shared by the API's handlers: responses, errors, query parameters,
// dates and the injected upstream fetch and D1 query. Runtime-agnostic, so the
// handlers run under Node in tests with fixtures and SQLite.

export const API_PREFIX = '/api/v1';
// The doc, as a page and as Markdown
export const DOC_PATH = `${API_PREFIX}/doc`;
export const DOC_MARKDOWN_PATH = `${API_PREFIX}/doc.md`;

export const MAX_TEXT_LEN = 64;

export interface ApiResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'bad_request', message);
}

export function notFound(path: string): ApiError {
  return new ApiError(404, 'not_found', `no such endpoint: ${path} (see ${DOC_PATH})`);
}

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
};

export function json(status: number, payload: unknown, cacheTtl = 0): ApiResponse {
  return {
    status,
    body: JSON.stringify(payload),
    headers: { ...BASE_HEADERS, 'cache-control': cacheTtl > 0 ? `public, max-age=${cacheTtl}` : 'no-store' },
  };
}

export function errorResponse(err: ApiError): ApiResponse {
  return json(err.status, { error: { code: err.code, message: err.message } });
}

// ── Upstream fetch and D1 ───────────────────────────────

export interface Upstream {
  status: number;
  text: string;
}

export class UpstreamTimeout extends Error {}
export class UpstreamUnavailable extends Error {}

// (url, cache ttl in seconds) → Upstream; throws UpstreamTimeout / UpstreamUnavailable
export type Fetcher = (url: string, cacheTtl: number) => Promise<Upstream>;

export type Row = Record<string, unknown>;

// (sql, params) → rows; throws DataUnavailable
export type Query = (sql: string, params: readonly (string | number)[]) => Promise<Row[]>;

export class DataUnavailable extends Error {}

// ── Query parameters ────────────────────────────────────

export class Params {
  private readonly raw: Map<string, string[]>;

  constructor(search: URLSearchParams | string, allowed: Iterable<string>) {
    const params = typeof search === 'string' ? new URLSearchParams(search) : search;
    this.raw = new Map();
    for (const [key, value] of params) {
      const values = this.raw.get(key);
      if (values) values.push(value);
      else this.raw.set(key, [value]);
    }
    const known = new Set(allowed);
    const unknown = [...this.raw.keys()].filter((k) => !known.has(k)).sort();
    if (unknown.length) throw badRequest(`unknown parameter(s): ${unknown.join(', ')}`);
  }

  all(name: string): string[] {
    return (this.raw.get(name) ?? []).map((v) => v.trim()).filter(Boolean);
  }

  get(name: string): string | null {
    const values = this.raw.get(name) ?? [];
    if (values.length > 1) throw badRequest(`${name} must not be repeated`);
    return values.length ? values[0].trim() || null : null;
  }

  text(name: string, required: true): string;
  text(name: string, required?: boolean): string | null;
  text(name: string, required = false): string | null {
    const value = this.get(name);
    if (value === null && required) throw badRequest(`${name} is required`);
    if (value !== null && [...value].length > MAX_TEXT_LEN) {
      throw badRequest(`${name} must be at most ${MAX_TEXT_LEN} characters`);
    }
    return value;
  }

  choice(name: string, choices: Iterable<string>, fallback: string): string {
    const value = this.get(name) ?? fallback;
    const allowed = [...choices];
    if (!allowed.includes(value)) throw badRequest(`${name} must be one of: ${allowed.sort().join(', ')}`);
    return value;
  }

  integer(name: string, fallback: number, lo: number, hi: number): number {
    const value = this.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || +value < lo || +value > hi) {
      throw badRequest(`${name} must be an integer in ${lo}..${hi}`);
    }
    return +value;
  }
}

// H or H-H, an hour or a range of hours
export function parseHours(value: string): [number, number] {
  const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(value);
  if (!m) throw badRequest('hours must be H or H-H (e.g. 5-8)');
  const lo = +m[1];
  const hi = m[2] ? +m[2] : lo;
  if (lo > hi) throw badRequest('hours range must be ascending');
  return [lo, hi];
}

// ── Dates ───────────────────────────────────────────────

// Calendar dates are ISO strings (YYYY-MM-DD); arithmetic goes through UTC
// midnights, which have no DST.

export const JST_HOURS = 9; // Japan has no DST
export const CST_HOURS = 8; // nor has China

export interface LocalTime {
  date: string;
  hour: number;
  minute: number;
}

// The wall-clock date and time at a fixed UTC offset
export function localTime(now: Date, offsetHours: number): LocalTime {
  const shifted = new Date(now.getTime() + offsetHours * 3_600_000);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

// A YYYY-MM-DD parameter, checked to be a real date
export function parseDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const ok = m && isoDate(Date.UTC(+m[1], +m[2] - 1, +m[3])) === value && +m[1] >= 1;
  if (!ok) throw badRequest('date must be YYYY-MM-DD');
  return value;
}

export function isoDate(utcMillis: number): string {
  return new Date(utcMillis).toISOString().slice(0, 10);
}

export function dateMillis(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

export function addDays(iso: string, days: number): string {
  return isoDate(dateMillis(iso) + days * 86_400_000);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dateMillis(to) - dateMillis(from)) / 86_400_000);
}
