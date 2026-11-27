// Search API tests: the indexes of trains and stations the Worker bundles, as
// cr-timetable/build_d1.py and stations/station-index.py write them, here the
// fixtures' (fixtures/build-data/, which vitest.config.js puts in their place).

import { describe, expect, it } from 'vitest';
import { ApiError, type ApiResponse, errorResponse } from './core.js';
import { dispatchSearch } from './search.js';

function call(path: string) {
  const url = new URL(path, 'https://map.test');
  let resp: ApiResponse;
  try {
    resp = dispatchSearch(url.pathname.replace(/\/+$/, ''), url.searchParams);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    resp = errorResponse(e);
  }
  return { resp, body: JSON.parse(resp.body) as Record<string, any> };
}

describe('search', () => {
  const get = async (path: string, status = 200) => {
    const { resp, body } = call(path);
    expect(resp.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const numbers = async (text: string) =>
    (await get(`/api/v1/search?q=${encodeURIComponent(text)}`)).results.map((r: { train: string }) => r.train);

  it('answers in shape', async () => {
    const body = await get('/api/v1/search?q=G1');
    expect([body.data_version, body.stations_version, body.query]).toEqual(['20261114', expect.any(String), 'G1']);
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
    expect((await get('/api/v1/search?q=4&type=train&limit=1')).results).toHaveLength(1);
    for (const path of ['/api/v1/search', '/api/v1/search?q=G1&limit=0', '/api/v1/search?q=G1&type=x']) {
      expect((await get(path, 400)).error.code, path).toBe('bad_request');
    }
  });

  const names = async (text: string, extra = '') =>
    (await get(`/api/v1/search?q=${encodeURIComponent(text)}${extra}`)).results
      .filter((r: { type: string }) => r.type === 'station')
      .map((r: { name: string; region: string[] }) => `${r.name} ${r.region.join('')}`);

  it('finds stations in shape', async () => {
    const body = await get(`/api/v1/search?q=${encodeURIComponent('渋谷')}`);
    expect([body.data_version, body.results]).toEqual([
      null,
      [
        {
          type: 'station',
          country: 'jp',
          name: '渋谷',
          yomi: 'シブヤ',
          region: ['東京都', '渋谷区'],
          osm: ['N241896099', 'N3623713008'],
          lat: 35.658713,
          lon: 139.701637,
          codes: ['22715'],
        },
      ],
    ]);
    expect((await get(`/api/v1/search?q=${encodeURIComponent('北京西')}`)).results[0]).toEqual({
      type: 'station',
      country: 'cn',
      name: '北京西',
      region: ['北京市', '丰台区'],
      osm: ['N124205138'],
      lat: 39.894,
      lon: 116.322,
      telecode: 'BXP',
    });
    // Without a position
    expect((await get(`/api/v1/search?q=${encodeURIComponent('叆河')}`)).results[0]).toMatchObject({
      lat: null,
      lon: null,
      telecode: null,
    });
  });

  it('finds stations by name, however it is written', async () => {
    // Simplified Chinese, traditional and Japanese forms alike
    for (const text of ['涩谷', '澀谷', '渋谷', '渋谷駅', 'しぶや', 'シブヤ', 'Shibuya', 'shibuya']) {
      expect(await names(text), text).toEqual(['渋谷 東京都渋谷区']);
    }
    expect(await names('东京站')).toEqual(['東京 東京都千代田区']);
    expect(await names('代代木')).toEqual(['代々木 東京都渋谷区']);
    // Same names told apart by region, the busier first
    expect(await names('府中')).toEqual(['府中 東京都府中市', '府中 広島県府中市']);
    // Exact first, then starting with it, then holding it; busier first
    expect(await names('北京')).toEqual(['北京 北京市东城区', '北京西 北京市丰台区']);
    expect(await names('新')).toEqual(['新宿 東京都新宿区', '新大阪 大阪府大阪市淀川区', '新橋 東京都港区']);
    expect(await names('虹桥')).toEqual(['上海虹桥 上海市闵行区']);
    // One character matches only at the start
    expect(await names('桥')).toEqual([]);
  });

  it('finds stations by reading', async () => {
    for (const text of ['tokyo', 'Tōkyō', 'toukyou', 'TOKYO', 'tokyo station']) {
      expect(await names(text), text).toEqual(['東京 東京都千代田区']);
    }
    for (const text of ['shin-osaka', 'shinosaka', 'Shin Ōsaka', 'sinoosaka']) {
      expect(await names(text), text).toEqual(['新大阪 大阪府大阪市淀川区']);
    }
    expect(await names('shimbashi')).toEqual(['新橋 東京都港区']);
    expect(await names('sinzyuku')).toEqual(['新宿 東京都新宿区']);
    expect(await names('shin')).toEqual(['新宿 東京都新宿区', '新大阪 大阪府大阪市淀川区', '新橋 東京都港区']);
    // Pinyin and its initials
    expect(await names('beijing')).toEqual(['北京 北京市东城区', '北京西 北京市丰台区']);
    expect(await names('bjx')).toEqual(['北京西 北京市丰台区']);
    expect(await names('xyz')).toEqual([]);
  });

  it('lists trains before stations, each up to the limit', async () => {
    const body = await get('/api/v1/search?q=G1');
    expect(body.results.map((r: { type: string }) => r.type)).toEqual(['cr_train']);
    expect(await names('shin', '&limit=1')).toEqual(['新宿 東京都新宿区']);
    expect(await names('G', '&type=station')).toEqual([]);
    expect((await get('/api/v1/search?q=bjx&type=train')).results).toEqual([]);
  });

  it('answers 404 for an unknown path', async () => {
    expect((await get('/api/v1/search/trains', 404)).error.code).toBe('not_found');
  });
});
