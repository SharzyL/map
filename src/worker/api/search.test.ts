import { DatabaseSync } from 'node:sqlite';
// Search API tests: the China Railway timetable of cr.test.ts, as
// lltskb/build_d1.py writes it (fixtures/cr-*.sql), in SQLite, which stands in
// for D1.

import { describe, expect, it } from 'vitest';
import { ApiError, type ApiResponse, DataUnavailable, errorResponse, type Query } from './core.js';
import baseSql from './fixtures/cr-20261114.sql?raw';
import newerSql from './fixtures/cr-20261120.sql?raw';
import { dispatchSearch } from './search.js';

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

async function call(path: string, db: SqliteDb | null) {
  const url = new URL(path, 'https://map.test');
  let resp: ApiResponse;
  try {
    resp = await dispatchSearch(url.pathname.replace(/\/+$/, ''), url.searchParams, db && asQuery(db));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    resp = errorResponse(e);
  }
  return { resp, body: JSON.parse(resp.body) as Record<string, any> };
}

describe('search', () => {
  const db = sqlite(baseSql);
  const get = async (path: string, status = 200) => {
    const { resp, body } = await call(path, db);
    expect(resp.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const numbers = async (text: string) =>
    (await get(`/api/v1/search?q=${encodeURIComponent(text)}`)).results.map((r: { train: string }) => r.train);

  it('answers in shape', async () => {
    const body = await get('/api/v1/search?q=G1');
    expect([body.data_version, body.query]).toEqual(['20261114', 'G1']);
    expect(body.results[0]).toEqual({
      type: 'cr_train',
      train: 'G1',
      origin: '北京南',
      destination: '上海虹桥',
      service: { from: '2026-01-01', to: null },
    });
  });

  it('matches a prefix of either half', async () => {
    // Exact first, then the shortest
    expect(await numbers('g')).toEqual(['G1', 'G9']);
    // Either half of a double number, under every service period
    expect(await numbers('Z2')).toEqual(['Z1/Z2']);
    expect(await numbers('4654')).toEqual(['4651/4654', '4651/4654B']);
    expect(await numbers('4651/4654b')).toEqual(['4651/4654B']);
    // Full-width and spaced input
    expect(await numbers('ｇ　１')).toEqual(['G1']);
    expect(await numbers('K9')).toEqual([]);
  });

  it('limits and validates', async () => {
    expect((await get('/api/v1/search?q=4&limit=1')).results).toHaveLength(1);
    for (const path of ['/api/v1/search', '/api/v1/search?q=G1&limit=0', '/api/v1/search?q=G1&type=x']) {
      expect((await get(path, 400)).error.code, path).toBe('bad_request');
    }
  });

  it('reloads with a new data version', async () => {
    await get('/api/v1/search?q=G1');
    const { body } = await call('/api/v1/search?q=G', sqlite(newerSql));
    expect([body.data_version, body.results.map((r: { train: string }) => r.train)]).toEqual(['20261120', ['G7']]);
  });

  it('answers 503 without data', async () => {
    for (const empty of [null, sqlite()]) {
      const { resp, body } = await call('/api/v1/search?q=G1', empty);
      expect([resp.status, body.error.code]).toEqual([503, 'data_unavailable']);
    }
  });

  it('answers 404 for an unknown path', async () => {
    expect((await get('/api/v1/search/trains', 404)).error.code).toBe('not_found');
  });
});
