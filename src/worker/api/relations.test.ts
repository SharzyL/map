import { DatabaseSync } from 'node:sqlite';
// Railway relation API tests: relations loaded into SQLite, which stands in for
// D1, in the tables and views osm/relations_sql.py writes.

import { describe, expect, it } from 'vitest';
import { ApiError, type ApiResponse, DataUnavailable, errorResponse, type Query } from './core.js';
import { dispatchRelations } from './relations.js';

type SqliteDb = DatabaseSync;

function asQuery(db: SqliteDb): Query {
  return async (sql, params) => {
    try {
      return db.prepare(sql).all(...params);
    } catch (e) {
      throw new DataUnavailable(String(e));
    }
  };
}

const VERSION = '2026-11-12T18:00:00Z';
const BODY_PART = 40_000; // bytes of JSON per row, as relations_sql.py stores them

const YAMANOTE = {
  relation: {
    id: 1972920,
    kind: 'route',
    type: 'train',
    name: 'JR山手線',
    ref: 'JY',
    from: '大崎',
    to: '大崎',
    operator: '東日本旅客鉄道',
    network: 'JR',
    colour: '#B1CB39',
    master: 1972959,
    wikidata: 'Q842716',
    wikipedia: 'ja:山手線',
  },
  bbox: [139.6965, 35.6197, 139.7774, 35.7381],
  length_m: 34500,
  overview: ['_p~iF~ps|U'],
  ways: [23816541, 23816542],
  stops: [{ name: '大崎', position: [139.7285, 35.6197], elements: ['N241896099'], km: null as number | null }],
};
// Long enough to take several rows, with names of several bytes in UTF-8
const TOKAIDO = {
  relation: { id: 5, kind: 'line', type: 'railway', name: '東海道本線' },
  ways: Array.from({ length: 20_000 }, (_, i) => 10_000_000 + i),
  stops: [
    { name: '東海道本線の駅'.repeat(3000), position: [0, 0], elements: [] as string[], km: null as number | null },
  ],
};
const SANIN = {
  relation: {
    id: 'jp-15e84d7cdd',
    kind: 'line',
    type: 'railway',
    name: '山陰本線',
    operator: '西日本旅客鉄道',
    aliases: [] as string[],
  },
  ways: [1],
  stops: [] as unknown[],
};

// text in pieces of at most `size` bytes of UTF-8, not splitting a character
function parts(text: string, size: number): string[] {
  const out: string[] = [];
  let piece = '';
  let bytes = 0;
  for (const ch of text) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > size) {
      out.push(piece);
      piece = '';
      bytes = 0;
    }
    piece += ch;
    bytes += n;
  }
  if (piece) out.push(piece);
  return out;
}

// One data version's table, then the views switched to it, as relations_sql.py does
function load(db: SqliteDb, version: string, rows: [string, unknown][]) {
  const table = `osm_relations_${version.replace(/\D/g, '').slice(0, 12)}`;
  db.exec(`CREATE TABLE ${table} (id TEXT, part INTEGER, body TEXT, PRIMARY KEY (id, part)) WITHOUT ROWID`);
  const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`);
  for (const [id, body] of rows) parts(JSON.stringify(body), BODY_PART).forEach((p, i) => insert.run(id, i, p));
  db.exec(
    `DROP VIEW IF EXISTS osm_relations; CREATE VIEW osm_relations AS SELECT * FROM ${table};` +
      `DROP VIEW IF EXISTS osm_version; CREATE VIEW osm_version AS SELECT '${version}' AS version;`,
  );
}

function makeDb(): SqliteDb {
  const db = new DatabaseSync(':memory:');
  load(db, VERSION, [
    ['1972920', YAMANOTE],
    ['5', TOKAIDO],
    ['jp-15e84d7cdd', SANIN],
  ]);
  return db;
}

async function call(path: string, db: SqliteDb | null) {
  const url = new URL(path, 'https://map.test');
  let resp: ApiResponse;
  try {
    resp = await dispatchRelations(url.pathname.replace(/\/+$/, ''), url.searchParams, db && asQuery(db));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    resp = errorResponse(e);
  }
  return { resp, body: JSON.parse(resp.body) as Record<string, any> };
}

describe('relations', () => {
  const db = makeDb();
  const get = async (path: string, status = 200) => {
    const { resp, body } = await call(path, db);
    expect(resp.status, JSON.stringify(body)).toBe(status);
    return body;
  };

  it('gives a route', async () => {
    expect(await get('/api/v1/relations/1972920')).toEqual({ data_version: VERSION, ...YAMANOTE });
  });

  it('joins a relation stored in several rows', async () => {
    const [count] = db.prepare("SELECT count(*) AS n FROM osm_relations WHERE id = '5'").all();
    expect(count.n).toBeGreaterThan(1);
    expect(await get('/api/v1/relations/5')).toEqual({ data_version: VERSION, ...TOKAIDO });
  });

  it('gives an official line', async () => {
    expect((await get('/api/v1/relations/jp-15e84d7cdd')).relation.name).toBe('山陰本線');
  });

  it('answers 404 for an unknown relation', async () => {
    expect((await get('/api/v1/relations/42', 404)).error.code).toBe('not_found');
    await get('/api/v1/relations/jp-0000000000', 404);
  });

  it('validates the id and parameters', async () => {
    for (const path of [
      '/api/v1/relations/R1972920',
      '/api/v1/relations/jp-15E84D7CDD',
      '/api/v1/relations/1972920?date=2026-11-12',
    ]) {
      expect((await get(path, 400)).error.code, path).toBe('bad_request');
    }
  });

  it('lets answers be cached anywhere', async () => {
    const { resp } = await call('/api/v1/relations/1972920', db);
    expect(resp.headers['cache-control']).toBe('public, max-age=86400');
    expect(resp.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers 503 without data', async () => {
    for (const empty of [null, new DatabaseSync(':memory:')]) {
      const { resp, body } = await call('/api/v1/relations/1972920', empty);
      expect(resp.status).toBe(503);
      expect(body.error.code).toBe('data_unavailable');
    }
  });

  it('serves the newest version', async () => {
    const updated = makeDb();
    load(updated, '2026-11-19T18:00:00Z', [['5', TOKAIDO]]);
    expect((await call('/api/v1/relations/1972920', updated)).resp.status).toBe(404);
    expect((await call('/api/v1/relations/5', updated)).body.data_version).toBe('2026-11-19T18:00:00Z');
  });

  it('answers 404 for an unknown path', async () => {
    expect((await get('/api/v1/relations/1972920/members', 404)).error.code).toBe('not_found');
  });
});
