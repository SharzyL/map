import { DatabaseSync } from 'node:sqlite';
// China Railway API tests: a small timetable, as lltskb/build_d1.py and
// routing/export_d1.py write it (fixtures/cr-*.sql), in SQLite, which stands in
// for D1.

import { describe, expect, it } from 'vitest';
import { ApiError, type ApiResponse, DataUnavailable, errorResponse, type Fetcher, type Query } from './core.js';
import { dispatchCr, runs } from './cr.js';
import baseSql from './fixtures/cr-20261114.sql?raw';
import routesSql from './fixtures/cr-routes-20261114.sql?raw';
import longPartial from './fixtures/cr-routes-long.txt?raw';
import trainsetJson from './fixtures/cr_trainset_G2705.json?raw';

type SqliteDb = DatabaseSync;

function sqlite(...scripts: string[]): SqliteDb {
  const db = new DatabaseSync(':memory:');
  for (const sql of scripts) db.exec(sql);
  return db;
}

function asQuery(db: SqliteDb): Query {
  return async (sql, params) => {
    try {
      return db.prepare(sql).all(...params);
    } catch (e) {
      throw new DataUnavailable(String(e));
    }
  };
}

const NOW = new Date('2026-11-15T23:30:00Z'); // 08:30 in Japan, 07:30 in China
const EXTRACT = '2026-11-12T16:00:00Z';

function route(ways: number[], partial: string[] = []) {
  return {
    bbox: [116.3, 39.0, 121.3, 39.9],
    ways,
    partial,
    overview: [] as string[],
    stops: [] as unknown[],
    legs: [] as unknown[],
  };
}

const noYahoo: Fetcher = async (url) => {
  throw new Error(`China Railway endpoints must not call Yahoo: ${url}`);
};

// The path through dispatchCr, as the Worker routes it, with errors as responses
async function call(path: string, db: SqliteDb | null, fetch: Fetcher = noYahoo) {
  const url = new URL(path, 'https://map.test');
  let resp: ApiResponse;
  try {
    resp = await dispatchCr(url.pathname.replace(/\/+$/, ''), url.searchParams, db && asQuery(db), fetch, NOW);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    resp = errorResponse(e);
  }
  return { resp, body: JSON.parse(resp.body) as any };
}

function getter(db: SqliteDb) {
  return async (path: string, status = 200) => {
    const { resp, body } = await call(path, db);
    expect(resp.status, JSON.stringify(body)).toBe(status);
    return body;
  };
}

const q = encodeURIComponent;

describe('station timetable', () => {
  const get = getter(sqlite(baseSql));

  it('finds a station by name, today in China by default', async () => {
    const body = await get(`/api/v1/cr/stations/${q('北京南')}/timetable`);
    expect(body.data_version).toBe('20261114');
    expect(body.station).toEqual({ name: '北京南', telecode: 'VNP' });
    expect(body.date).toBe('2026-11-16');
    expect(body.trains).toEqual([
      {
        train: 'G1',
        arrival: null,
        departure: '06:30',
        origin: '北京南',
        destination: '上海虹桥',
        day: 1,
        platform: '17',
        arrival_number: null,
        departure_number: 'G1',
        bound: '下行',
        line: '京沪高速',
        line_in: null,
        line_out: '京沪高速',
      },
    ]);
  });

  it('gives the numbers and lines a train changes between', async () => {
    let body = await get(`/api/v1/cr/stations/${q('天津南')}/timetable?date=2026-11-15`);
    let [z] = body.trains.filter((t: { train: string }) => t.train === 'Z1/Z2');
    // Arrives as Z1 (下行), leaves as Z2 (上行): bound follows the leaving number
    expect([z.arrival_number, z.departure_number, z.bound, z.line, z.line_in, z.line_out]).toEqual([
      'Z1',
      'Z2',
      '上行',
      '京沪',
      '京沪',
      '京沪',
    ]);
    body = await get(`/api/v1/cr/stations/${q('上海虹桥')}/timetable?date=2026-11-16`);
    [z] = body.trains.filter((t: { train: string }) => t.train === 'Z1/Z2');
    // At the terminus: the arriving number and line
    expect([z.departure_number, z.bound, z.line]).toEqual([null, '上行', '京沪']);
  });

  it('finds a station by OSM refs', async () => {
    for (const refs of ['N1', 'W2', 'W99,W2', 'R5,N1']) {
      const body = await get(`/api/v1/cr/stations/${refs}/timetable`);
      expect(body.station, refs).toEqual({ name: '北京南', telecode: 'VNP' });
    }
  });

  it('counts an overnight train from its departure day', async () => {
    const trains = async (station: string, day: string) =>
      (await get(`/api/v1/cr/stations/${q(station)}/timetable?date=${day}`)).trains.map(
        (t: Record<string, unknown>) => [t.train, t.arrival, t.departure, t.day],
      );
    const codes = async (station: string, day: string) => (await trains(station, day)).map((t: unknown[]) => t[0]);
    // Leaves 北京 on the 15th, reaches 上海虹桥 on the 16th, not the 17th
    expect(await trains('天津南', '2026-11-15')).toContainEqual(['Z1/Z2', '23:20', '23:25', 1]);
    expect(await codes('天津南', '2026-11-16')).not.toContain('Z1/Z2');
    expect(await trains('上海虹桥', '2026-11-16')).toContainEqual(['Z1/Z2', '07:00', null, 2]);
    expect(await codes('上海虹桥', '2026-11-17')).not.toContain('Z1/Z2');
  });

  it('keeps to service dates and hours', async () => {
    const codes = async (path: string) => (await get(path)).trains.map((t: { train: string }) => t.train);
    const station = q('北京南');
    expect(await codes(`/api/v1/cr/stations/${station}/timetable?date=2026-10-15`)).toEqual(['G1', 'G9']);
    expect(await codes(`/api/v1/cr/stations/${station}/timetable?date=2026-11-17`)).toEqual(['G1']);
    expect(await codes(`/api/v1/cr/stations/${station}/timetable?date=2026-10-15&hours=8-23`)).toEqual(['G9']);
  });

  it('sorts by time', async () => {
    const body = await get(`/api/v1/cr/stations/${q('天津南')}/timetable?date=2026-11-15`);
    const times = body.trains.map((t: Record<string, string>) => t.departure || t.arrival);
    expect(times).toEqual([...times].sort());
  });

  it('answers 404 for an unknown station', async () => {
    for (const station of [q('火星'), 'N404', 'W404,R404']) {
      const body = await get(`/api/v1/cr/stations/${station}/timetable`, 404);
      expect(body.error.code).toBe('not_found');
    }
  });
});

describe('station search', () => {
  const get = getter(sqlite(baseSql));

  it('matches a prefix of the name, pinyin or telegraph code', async () => {
    const names = async (text: string) =>
      (await get(`/api/v1/cr/stations?q=${q(text)}`)).results.map((r: { name: string }) => r.name);
    // Busier stations first, but an exact name wins
    expect(await names('bj')).toEqual(['北京', '北京南']);
    expect(await names('北京')).toEqual(['北京', '北京南']);
    expect(await names('北京南')).toEqual(['北京南']);
    expect(await names('VNP')).toEqual(['北京南']);
    expect(await names('shanghai')).toEqual(['上海虹桥']);
    expect(await names('zzz')).toEqual([]);
  });

  it('answers in shape', async () => {
    expect(await get(`/api/v1/cr/stations?q=${q('天津')}`)).toEqual({
      data_version: '20261114',
      results: [{ name: '天津南', telecode: 'TIP', pinyin: 'tianjinnan' }],
    });
  });
});

describe('train', () => {
  const get = getter(sqlite(baseSql));

  it('lists the stops', async () => {
    const body = await get('/api/v1/cr/trains/g1?date=2026-11-16');
    expect([body.train, body.date]).toEqual(['G1', '2026-11-16']);
    const [train] = body.trains;
    expect(train.service).toEqual({ from: '2026-01-01', to: null });
    expect(train.runs).toBe(true);
    expect(train.stops[1]).toEqual({
      name: '天津南',
      telecode: 'TIP',
      arrival: '07:00',
      departure: '07:02',
      day: 1,
      km: 120,
      platform: null,
      // Without the route data, no OSM station
      elements: null,
      position: null,
      arrival_number: 'G1',
      departure_number: 'G1',
      bound: '下行',
    });
    const z = (await get('/api/v1/cr/trains/Z1?date=2026-11-15')).trains[0].stops;
    expect(z.map((s: Record<string, unknown>) => [s.arrival_number, s.departure_number, s.bound])).toEqual([
      [null, 'Z1', '下行'],
      ['Z1', 'Z2', '上行'],
      ['Z2', null, '上行'],
    ]);
  });

  it('is found by either number and knows its running days', async () => {
    for (const [code, day, running] of [
      ['Z1', '2026-11-15', true],
      ['Z2', '2026-11-16', false],
    ] as const) {
      const [train] = (await get(`/api/v1/cr/trains/${code}?date=${day}`)).trains;
      expect(train.train).toBe('Z1/Z2');
      expect(train.runs).toBe(running);
      expect(train.stops.at(-1).day).toBe(2);
    }
  });

  it('lists every train sharing a number', async () => {
    // The variant letter sits on the last number: 4654 must find 4651/4654B
    for (const code of ['4651', '4654']) {
      const body = await get(`/api/v1/cr/trains/${code}`);
      expect(body.trains.map((t: { train: string }) => t.train)).toEqual(['4651/4654', '4651/4654B']);
    }
    const body = await get(`/api/v1/cr/trains/${q('4651/4654B')}`);
    expect(body.trains.map((t: { train: string }) => t.train)).toEqual(['4651/4654B']);
  });

  it('gives the rolling stock of the date', async () => {
    const stock = async (path: string) => (await get(path)).trains[0].rolling_stock;
    expect(await stock('/api/v1/cr/trains/G1?date=2026-11-19')).toEqual({
      model: 'CR400AF',
      coupled: false,
      depot: '京局北京动车段',
      description: 'CR400AF',
    });
    expect(await stock('/api/v1/cr/trains/G1?date=2026-11-20')).toEqual({
      model: 'CR400AF-Z',
      coupled: true,
      depot: null,
      description: 'CR400AF-Z型重联',
    });
    // After its service ends a train keeps the stock of its last day
    expect((await stock('/api/v1/cr/trains/G9?date=2026-11-16')).model).toBe('CRH380A');
    expect(await stock('/api/v1/cr/trains/Z1')).toBeNull();
  });

  it('lists its lines', async () => {
    let [train] = (await get('/api/v1/cr/trains/G1')).trains;
    expect(train.lines).toEqual([
      {
        name: '京沪高速线',
        stations: [
          { name: '北京南', km: 0 },
          { name: '廊坊', km: 59 },
          { name: '天津南', km: 120 },
          { name: '上海虹桥', km: 1318 },
        ],
      },
    ]);
    [train] = (await get(`/api/v1/cr/trains/${q('4651/4654')}`)).trains;
    expect(train.lines).toEqual([]);
  });

  it('answers 404 for an unknown train', async () => {
    expect((await get('/api/v1/cr/trains/G99999', 404)).error.code).toBe('not_found');
  });
});

describe('train route', () => {
  const db = sqlite(baseSql, routesSql);
  const get = getter(db);

  it('is the stored one', async () => {
    const { resp, body } = await call('/api/v1/cr/trains/g1/route', db);
    expect(resp.status).toBe(200);
    expect(body).toEqual({ ...route([1, 2]), data_version: EXTRACT });
    expect(resp.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('is read back from several parts', async () => {
    const [count] = db.prepare("SELECT count(*) AS n FROM route_cr_runs WHERE run = 'Z1/Z2'").all();
    expect(count.n).toBeGreaterThan(1);
    expect((await get('/api/v1/cr/trains/Z1/route')).partial).toEqual([longPartial]);
  });

  it("is the date's run", async () => {
    // Both run every day; the first is taken, and the second has no route
    expect((await get('/api/v1/cr/trains/4654/route')).ways).toEqual([3]);
    const body = await get(`/api/v1/cr/trains/${q('4651/4654B')}/route`, 404);
    expect(body.error.message).toContain('4651/4654B');
  });

  it('answers 404 for an unknown train', async () => {
    expect((await get('/api/v1/cr/trains/G99999/route', 404)).error.code).toBe('not_found');
  });

  it("gives the stops' OSM stations", async () => {
    const [train] = (await get('/api/v1/cr/trains/G1')).trains;
    const first = train.stops[0];
    const last = train.stops.at(-1);
    expect(first.elements).toEqual(['N1', 'W2']);
    expect(first.position).toEqual([116.379, 39.865]);
    expect([last.elements, last.position]).toEqual([null, null]);
  });

  it('is unavailable without the route data', async () => {
    const { resp, body } = await call('/api/v1/cr/trains/G1/route', sqlite(baseSql));
    expect(resp.status).toBe(503);
    expect(body.error.code).toBe('data_unavailable');
  });
});

describe('protocol', () => {
  const db = sqlite(baseSql);
  const get = getter(db);

  it('validates parameters', async () => {
    for (const path of [
      '/api/v1/cr/stations',
      '/api/v1/cr/stations?q=bj&type=all',
      '/api/v1/cr/stations/N1/timetable?date=2026/11/16',
      '/api/v1/cr/stations/N1/timetable?hours=9-5',
      `/api/v1/cr/stations/${Array.from({ length: 11 }, (_, i) => `N${i}`).join(',')}/timetable`,
      '/api/v1/cr/trains/G1?day=weekday',
    ]) {
      expect((await get(path, 400)).error.code, path).toBe('bad_request');
    }
  });

  it('answers 404 for an unknown path', async () => {
    expect((await get('/api/v1/cr/routes', 404)).error.code).toBe('not_found');
  });

  it('lets answers be cached', async () => {
    const { resp } = await call('/api/v1/cr/trains/G1', db);
    expect(resp.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('answers 503 without data', async () => {
    for (const empty of [null, sqlite()]) {
      const { resp, body } = await call('/api/v1/cr/trains/G1', empty);
      expect(resp.status).toBe(503);
      expect(resp.headers['cache-control']).toBe('no-store');
      expect(body.error.code).toBe('data_unavailable');
    }
  });

  it('counts running days back from the last service day', () => {
    // 20261120 is bit 0
    const got = [14, 15, 16, 17, 18, 19, 20, 21].map((d) => runs(20260101, 20261120, 3, 0b101, `2026-11-${d}`));
    expect(got).toEqual([true, true, false, true, true, false, true, false]);
  });
});

describe('trainset', () => {
  // Against a 12306 answer for G2705 on 2026-11-14; needs no database
  async function get(path: string, answer: string | null = null, status = 200) {
    const urls: string[] = [];
    const fetch: Fetcher = async (url) => {
      urls.push(url);
      return { status: 200, text: answer ?? trainsetJson };
    };
    const { resp, body } = await call(path, null, fetch);
    expect(resp.status, JSON.stringify(body)).toBe(status);
    return { body, urls };
  }

  it('gives the trainset', async () => {
    const { body, urls } = await get('/api/v1/cr/trainsets/g2705?date=2026-11-14');
    expect([body.train, body.date]).toEqual(['G2705', '2026-11-14']);
    expect(body.source_url).toBe(urls[0]);
    expect(urls[0]).toContain('trainCode=G2705&runningDay=20261114');
    const ts = body.trainset;
    expect({
      id: ts.id,
      model: ts.model,
      brand: ts.brand,
      cars: ts.cars,
      length_m: ts.length_m,
      capacity: ts.capacity,
      max_speed_kmh: ts.max_speed_kmh,
    }).toEqual({
      id: 'CR400BF-S-3243',
      model: 'CR400BF-S',
      brand: '复兴号',
      cars: 8,
      length_m: 208.95,
      capacity: 619,
      max_speed_kmh: 350,
    });
    expect(ts.details).toContainEqual({ name: '餐车', value: '05车' });
    expect(ts.details).toContainEqual({ name: '静音车厢', value: null });
    expect(ts.coaches[0]).toBe('01车 一等/商务 32/5');
    expect(ts.coaches).toHaveLength(8);
  });

  it('asks for one plain number, today in China by default', async () => {
    const { body, urls } = await get(`/api/v1/cr/trainsets/${q('Z156/Z157B')}`);
    expect([body.train, body.date]).toEqual(['Z156', '2026-11-16']);
    expect(urls[0]).toContain('trainCode=Z156&runningDay=20261116');
  });

  it('may have no trainset', async () => {
    const empty = '{"httpCode":200,"content":{"timestamp":"1","status":0},"status":0}';
    expect((await get('/api/v1/cr/trainsets/K551', empty)).body.trainset).toBeNull();
  });

  it('reports errors', async () => {
    for (const path of ['/api/v1/cr/trainsets/G1%26x=1', '/api/v1/cr/trainsets/G1?day=1']) {
      expect((await get(path, null, 400)).body.error.code, path).toBe('bad_request');
    }
    expect((await get('/api/v1/cr/trainsets/G1', '<html>busy</html>', 502)).body.error.code).toBe(
      'upstream_parse_error',
    );
    expect((await get('/api/v1/cr/trainsets/G1', '{"content":{"status":1}}', 502)).body.error.code).toBe(
      'upstream_error',
    );
  });
});
