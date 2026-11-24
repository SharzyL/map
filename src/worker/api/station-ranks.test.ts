// The ranks of a train route's stops, from the relations step's table in
// SQLite standing in for D1.

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DataUnavailable, type Query } from './core.js';
import { withRanks } from './station-ranks.js';

function query(db: DatabaseSync, asked: string[][] = []): Query {
  return async (sql, params) => {
    asked.push(params.map(String));
    try {
      return db.prepare(sql).all(...params);
    } catch (e) {
      throw new DataUnavailable(String(e));
    }
  };
}

function ranksDb(rows: Array<[string, number]>) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE osm_station_ranks (element TEXT PRIMARY KEY, rank INTEGER) WITHOUT ROWID');
  for (const [element, rank] of rows) db.prepare('INSERT INTO osm_station_ranks VALUES (?, ?)').run(element, rank);
  return db;
}

describe('withRanks', () => {
  it('gives each stop the busiest of its elements, 0 for one no route stops at', async () => {
    const db = ranksDb([
      ['N1', 3],
      ['W2', 40],
      ['N3', 7],
    ]);
    const stops = [
      { name: '北京南', elements: ['N1', 'W2'] },
      { name: '天津南', elements: ['N3'] },
      { name: '无名', elements: ['N9'] },
      { name: '未匹配', elements: null },
    ];
    expect((await withRanks(stops, query(db))).map((s) => [s.name, s.rank])).toEqual([
      ['北京南', 40],
      ['天津南', 7],
      ['无名', 0],
      ['未匹配', null],
    ]);
  });

  it('asks for many stops a part at a time', async () => {
    const db = ranksDb([['N150', 9]]);
    const asked: string[][] = [];
    const stops = Array.from({ length: 200 }, (_, i) => ({ elements: [`N${i}`] }));
    const ranked = await withRanks(stops, query(db, asked));
    expect(asked.map((params) => params.length)).toEqual([90, 90, 20]);
    expect(ranked[150].rank).toBe(9);
  });

  it('gives none without the table, and passes other errors on', async () => {
    const stops = [{ elements: ['N1'] }];
    expect(await withRanks(stops, query(new DatabaseSync(':memory:')))).toEqual([{ elements: ['N1'], rank: null }]);
    const broken: Query = async () => {
      throw new TypeError('bug');
    };
    await expect(withRanks(stops, broken)).rejects.toThrow('bug');
  });
});
