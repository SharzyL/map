// Tests of search-keys.mjs: the keys it adds, and the Worker's fixture
// (src/worker/api/fixtures/build-data/search-stations.json), which it makes
// from station-index.py's (fixtures/search-stations.raw.json, written by
// test_station_index.py). UPDATE_FIXTURES=1 writes it again.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIndex } from './search-keys.mjs';

const FIXTURES = new URL('../../src/worker/api/fixtures/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('search-stations.raw.json', FIXTURES), 'utf8'));

describe('search-keys', () => {
  it('makes the Worker’s fixture', () => {
    const path = new URL('build-data/search-stations.json', FIXTURES);
    const { text } = buildIndex(raw);
    if (process.env.UPDATE_FIXTURES) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8'), 'stale: rerun with UPDATE_FIXTURES=1').toBe(text);
  });

  it('adds each station’s keys, versioned by content', () => {
    const { version, text } = buildIndex(raw);
    const index = JSON.parse(text);
    expect(index.version).toBe(version);
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    const keys = Object.fromEntries(index.stations.map((s) => [`${s.n} ${s.r.join('')}`, [s.f, s.a]]));
    // Folded name and reading; romaji from the reading and OSM's Latin name
    expect(keys['渋谷 東京都渋谷区']).toEqual([['涩谷', 'シブヤ'], ['shibuya']]);
    expect(keys['東京 東京都千代田区']).toEqual([['东京', 'トウキョウ'], ['tokyo']]);
    expect(keys['代々木 東京都渋谷区']).toEqual([['代代木', 'ヨヨギ'], ['yoyogi']]);
    // Pinyin and initials as they are
    expect(keys['北京西 北京市丰台区']).toEqual([['北京西'], ['beijingxi', 'bjx']]);
    // Without a reading
    expect(keys['名無し ']).toEqual([['名无シ'], []]);
    expect(buildIndex(raw.slice(1)).version).not.toBe(version);
  });
});
