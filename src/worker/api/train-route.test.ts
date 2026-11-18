// Yahoo train route tests: a tiny store of hops, in the tables
// routing/export_d1.py creates, in SQLite standing in for D1.

import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { DataUnavailable, type Query } from './core.js';
import { encodePolyline } from './geo.js';
import type { Train } from './jp-assemble.js';
import { TRAIN_ROUTE, trainRoute } from './train-route.js';

const EXTRACT = '2026-11-12T16:00:00Z';
// Three stations 1 km apart along a line, and 4 only the 新幹線 serves
const STATIONS: Record<string, [number, number]> = {
  '1': [35.0, 139.0],
  '2': [35.0, 139.011],
  '3': [35.0, 139.022],
  '4': [35.001, 139.022],
};

// routing/export_d1.py's JP_TABLES
const JP_TABLES: Record<string, string> = {
  stations: 'code TEXT PRIMARY KEY, lat REAL, lon REAL, elements TEXT',
  routes: 'id INTEGER PRIMARY KEY, name TEXT, shinkansen INTEGER, loop INTEGER, stops INTEGER, train TEXT',
  route_stops: 'code TEXT, route_id INTEGER, seq INTEGER, PRIMARY KEY (code, route_id, seq)',
  hops:
    'route_id INTEGER, seq INTEGER, from_code TEXT, to_code TEXT, length_m INTEGER, ways TEXT, partial TEXT,' +
    ' line TEXT, start TEXT, end TEXT, highspeed REAL, PRIMARY KEY (route_id, seq)',
};

type Value = string | number | null;

function hop(routeId: number, seq: number, a: string, b: string, ways: number[], highspeed = 0.0): Value[] {
  const [la, lo] = STATIONS[a];
  const [lb, lob] = STATIONS[b];
  return [
    routeId,
    seq,
    a,
    b,
    1000 * ways.length,
    JSON.stringify(ways),
    '[]',
    encodePolyline([
      [la, lo],
      [lb, lob],
    ]),
    JSON.stringify([lo, la]),
    JSON.stringify([lob, lb]),
    highspeed,
  ];
}

const TABLES: Record<string, Value[][]> = {
  stations: Object.entries(STATIONS).map(([c, [la, lo]]) => [c, la, lo, JSON.stringify([`N${c}`])]),
  // id, name, shinkansen, loop, stops, train pattern
  routes: [
    [10, 'JRテスト線 普通', 0, 0, 3, null],
    [20, 'テスト新幹線', 1, 0, 2, null],
    [-1, '特急 鎌倉 (1 => 3)', 0, 0, 2, '特急 鎌倉'],
  ],
  route_stops: [
    ['1', 10, 0],
    ['2', 10, 1],
    ['3', 10, 2],
    ['1', 20, 0],
    ['4', 20, 1],
    ['1', -1, 0],
    ['3', -1, 1],
  ],
  hops: [
    hop(10, 0, '1', '2', [101]),
    hop(10, 1, '2', '3', [102]),
    hop(20, 0, '1', '4', [201, 202], 1.0),
    hop(-1, 0, '1', '3', [301, 302]),
  ],
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const [t, cols] of Object.entries(JP_TABLES)) {
    db.exec(`CREATE TABLE jp_${t} (${cols}) WITHOUT ROWID`);
    for (const row of TABLES[t]) {
      db.prepare(`INSERT INTO jp_${t} VALUES (${row.map(() => '?').join(',')})`).run(...row);
    }
  }
  db.exec(`CREATE VIEW jp_version AS SELECT '${EXTRACT}' AS version`);
  return db;
}

function query(db: DatabaseSync): Query {
  return async (sql, params) => {
    try {
      return db.prepare(sql).all(...params);
    } catch (e) {
      throw new DataUnavailable(String(e));
    }
  };
}

async function route(train: Train, db: DatabaseSync): Promise<[number, any]> {
  const resp = await trainRoute(train, query(db));
  return [resp.status, JSON.parse(resp.body)];
}

function train(name: string, codes: string[], line = 'ＪＲテスト線'): Train {
  return { name, line, stops: codes.map((c) => ({ code: c, name: `駅${c}` })) };
}

describe('trainRoute', () => {
  let db: DatabaseSync;
  beforeAll(() => {
    db = makeDb();
  });

  it('runs a local train on its route', async () => {
    const [status, body] = await route(train('普通', ['1', '2', '3']), db);
    expect(status).toBe(200);
    expect(body.data_version).toBe(EXTRACT);
    expect(body.ways).toEqual([101, 102]);
    expect(body.legs.map((x: any) => [x.from, x.to, x.line, x.method])).toEqual([
      ['駅1', '駅2', 'JRテスト線 普通', 'line'],
      ['駅2', '駅3', 'JRテスト線 普通', 'line'],
    ]);
    expect(body.stops[1]).toEqual({ name: '駅2', position: [139.011, 35.0], elements: ['N2'] });
  });

  it('keeps a conventional train off the 新幹線', async () => {
    // Only the 新幹線 route stops at both 1 and 4: better straight
    const [status, body] = await route(train('快速', ['1', '4']), db);
    expect(status).toBe(200);
    expect(body.legs[0].method).toBe('straight');
    expect(body.legs[0].straight).toBeTruthy();
  });

  it('runs a 新幹線 train on the 新幹線', async () => {
    const [status, body] = await route(train('新幹線 テスト1号', ['1', '4'], 'テスト新幹線'), db);
    expect(status).toBe(200);
    expect(body.ways).toEqual([201, 202]);
  });

  it('takes a route made from a rule first', async () => {
    const [status, body] = await route(train('特急 鎌倉', ['1', '3']), db);
    expect(status).toBe(200);
    expect([body.ways, body.legs[0].line]).toEqual([[301, 302], '特急 鎌倉 (1 => 3)']);
  });

  it('draws a stop not in the data straight', async () => {
    const [status, body] = await route(train('普通', ['1', '9']), db);
    expect(status).toBe(200);
    expect(body.legs[0].method).toBe('straight');
    expect(body.stops[1]).toEqual({ name: '駅9', position: null, elements: [] });
  });

  it('answers 503 without the data', async () => {
    const [status, body] = await route(train('普通', ['1', '2']), new DatabaseSync(':memory:'));
    expect(status).toBe(503);
    expect(body.error.code).toBe('data_unavailable');
  });
});

describe('TRAIN_ROUTE', () => {
  it('matches the route of a Yahoo train and gives the train', () => {
    const m = TRAIN_ROUTE.exec('/api/v1/norikae/stations/22715/timetables/123/trains/456/route');
    expect(m?.[1]).toBe('/api/v1/norikae/stations/22715/timetables/123/trains/456');
    expect(TRAIN_ROUTE.test('/api/v1/norikae/stations/22715/timetables/123/trains/456')).toBe(false);
  });
});
