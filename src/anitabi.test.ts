import { describe, expect, it } from 'vitest';
import {
  anitabiImageUrl,
  anitabiKey,
  anitabiMapUrl,
  bangumiUrl,
  loadAnitabi,
  originUrl,
  parseChunk,
  parseIndex,
  parseUsers,
  type AnitabiData,
} from './anitabi.js';

// Rows as anitabi serves them (shortened from its g.json and g0.json).
const WORK_A = [
  419801,
  '无法向繁星许愿的恋情',
  0,
  'この恋を星には願わない',
  '兵庫県',
  '#be8476',
  '/images/bangumi/419801.jpg',
  6.8,
  '漫画系列',
  33.163342,
  129.725069,
  20.3,
  ['m4js11o', 34.665386, 134.961811, 472, 'm4jxh3w', 34.668813, 134.959308, 0],
  0,
  [],
  90458,
  null,
  0,
];
const WORK_B = [
  51,
  'CLANNAD',
  'Clannad',
  'CLANNAD -クラナド-',
  '東京都',
  '#f09199',
  0,
  0,
  'TV',
  35.7,
  139.7,
  12,
  ['5c4dgq9r0', 35.71, 139.71, 3],
  0,
  ['KEY'],
  0,
  null,
  0,
];
const POINT_A1 = [
  'm4js11o',
  'JR西明石駅 東口',
  0,
  0,
  0,
  '1057',
  '/images/points/419801/m4js11o_1.webp',
  0,
  2,
  484,
  0,
  0,
  0,
  0,
  471,
];
const POINT_A2 = [
  'm4jxh3w',
  '小久保西交差点',
  '小久保西路口',
  0,
  'mid1',
  2128,
  0,
  0,
  '游戏背景图',
  '',
  '向南拍摄',
  'Shiro',
  'https://example.com/a',
  '明石',
  3,
];
const POINT_B = ['5c4dgq9r0', '光坂', 0, 0, 0, 0, 0, 0, 0, '', 0, 0, 0, 0, 0];

const index = (modified: number, pageSize = 1) => [[WORK_A, WORK_B], pageSize, modified];
const chunk = (id: number, points: unknown[], modified: number) => [[id, 0, points, modified]];

function server(files: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    fetchJson: async (file: string, key: string) => {
      asked.push(`${file}?d=${key}`);
      if (!(file in files)) throw new Error(`HTTP 404 for ${file}`);
      return structuredClone(files[file]);
    },
  };
}

function memoryCache(initial: AnitabiData | null = null) {
  const cache = {
    stored: initial,
    read: async () => structuredClone(cache.stored),
    write: async (data: AnitabiData) => {
      cache.stored = structuredClone(data);
    },
  };
  return cache;
}

const NOW = Date.parse('2026-11-21T03:00:00Z');

describe('parsing', () => {
  it('reads the index: works with their spots’ places', () => {
    const { works, pageSize, modified } = parseIndex(index(1700, 250));
    expect([pageSize, modified]).toEqual([250, 1700]);
    expect(works[0]).toMatchObject({
      id: 419801,
      cn: '无法向繁星许愿的恋情',
      en: undefined,
      title: 'この恋を星には願わない',
      city: '兵庫県',
      color: '#be8476',
      cat: '漫画系列',
      geo: [33.163342, 129.725069],
      priority: 90458,
    });
    // A priority of 0 is anitabi's "unranked", 999.
    expect(works[0].points).toEqual([
      { id: 'm4js11o', geo: [34.665386, 134.961811], priority: 472 },
      { id: 'm4jxh3w', geo: [34.668813, 134.959308], priority: 999 },
    ]);
    expect(works[1].tags).toEqual(['KEY']);
    expect(() => parseIndex('<html>')).toThrow();
  });

  it('reads a chunk: the spots’ details', () => {
    const [work] = parseChunk(chunk(419801, [POINT_A1, POINT_A2], 1795181376911));
    expect(work.modified).toBe(1795181376911);
    expect(work.points[0]).toEqual({
      id: 'm4js11o',
      name: 'JR西明石駅 東口',
      cn: undefined,
      mid: undefined,
      uid: 1057,
      image: '/images/points/419801/m4js11o_1.webp',
      ep: 2,
      s: 484,
      mark: undefined,
      origin: undefined,
      originLink: undefined,
      folder: undefined,
    });
    // No contributor is 0.
    expect(parseChunk(chunk(51, [POINT_B], 1))[0].points[0].uid).toBeUndefined();
    expect(work.points[1]).toMatchObject({
      cn: '小久保西路口',
      ep: '游戏背景图',
      mark: '向南拍摄',
      folder: '明石',
      uid: 2128,
    });
  });

  it('reads contributors and anitabi’s cache key', () => {
    expect(parseUsers('1000,卜卜口\r\n1001,a,b\n\nx,y\n')).toEqual(
      new Map([
        [1000, '卜卜口'],
        [1001, 'a,b'],
      ]),
    );
    // What anitabi's own page asked for on this day
    expect(anitabiKey(NOW)).toBe('qpyd');
    expect(anitabiKey(NOW + 24 * 60_000)).not.toBe('qpyd');
  });
});

describe('links', () => {
  it('points images, the work and the source where anitabi does', () => {
    expect(anitabiImageUrl('/images/points/1/a.jpg', 'h360')).toBe(
      'https://img-tc.anitabi.cn/points/1/a.jpg?plan=h360',
    );
    expect(anitabiImageUrl('/images/points/1/a.jpg?v=1', 'h160')).toBe(
      'https://img-tc.anitabi.cn/points/1/a.jpg?v=1&plan=h160',
    );
    expect(anitabiImageUrl('http://www.tv-asahi.co.jp/a.jpg')).toBe('https://www.tv-asahi.co.jp/a.jpg');
    expect(anitabiImageUrl(undefined)).toBeUndefined();
    expect(bangumiUrl(51)).toBe('https://bgm.tv/subject/51');
    expect(anitabiMapUrl(51, 'p1')).toBe('https://www.anitabi.cn/map?bangumiId=51&pid=p1');
    expect(originUrl({ id: 'p', geo: [35, 139], priority: 1, mid: 'abc' })).toBe(
      'https://www.google.com/maps/d/viewer?mid=abc&ll=35%2C139&z=16',
    );
    expect(originUrl({ id: 'p', geo: [35, 139], priority: 1, mid: 'abc', originLink: 'https://x.test/' })).toBe(
      'https://x.test/',
    );
  });
});

describe('loadAnitabi', () => {
  const files = {
    'g.json': index(2000),
    'g0.json': chunk(419801, [POINT_A1, POINT_A2], 2000),
    'g1.json': chunk(51, [POINT_B], 1000),
  };

  it('loads the index, then every chunk, and keeps the result', async () => {
    const { asked, fetchJson } = server(files);
    const cache = memoryCache();
    const progress: string[] = [];
    const data = await loadAnitabi({
      fetchJson,
      cache,
      now: NOW,
      onData: (works, p) => progress.push(`${p.done}/${p.total} ${works[0].points[0].name ?? '-'}`),
    });
    expect(asked).toEqual(['g.json?d=qpyd', 'g0.json?d=qpyd', 'g1.json?d=qpyd']);
    expect(progress).toEqual(['0/2 -', '1/2 JR西明石駅 東口', '2/2 JR西明石駅 東口']);
    expect(data.modified).toBe(2000);
    expect(data.works[0].points[0]).toMatchObject({ id: 'm4js11o', geo: [34.665386, 134.961811], ep: 2, s: 484 });
    expect(data.works[1]).toMatchObject({ modified: 1000, points: [{ id: '5c4dgq9r0', name: '光坂' }] });
    expect(cache.stored).toEqual(data);
  });

  it('stops at the index when nothing changed since the saved copy', async () => {
    const first = await loadAnitabi({ ...server(files), cache: memoryCache(), now: NOW });
    const { asked, fetchJson } = server(files);
    const seen: boolean[] = [];
    const data = await loadAnitabi({
      fetchJson,
      cache: memoryCache(first),
      now: NOW,
      onData: (_, p) => seen.push(p.fromCache),
    });
    expect(asked).toEqual(['g.json?d=qpyd']);
    expect(seen).toEqual([true]);
    expect(data).toEqual(first);
  });

  it('fetches chunks only up to the first unchanged work, keeping the rest from the copy', async () => {
    const first = await loadAnitabi({ ...server(files), cache: memoryCache(), now: NOW });
    const edited = [...POINT_A1];
    edited[1] = '西明石駅';
    // Work A edited and moved a spot; chunks hold one work each, newest first.
    const moved = structuredClone(WORK_A);
    (moved[12] as unknown[])[1] = 34.7;
    const { asked, fetchJson } = server({
      'g.json': [[moved, WORK_B], 1, 3000],
      'g0.json': chunk(419801, [edited, POINT_A2], 3000),
      'g1.json': chunk(51, [POINT_B], 1000),
    });
    const cache = memoryCache(first);
    const data = await loadAnitabi({ fetchJson, cache, now: NOW });
    // g1 holds only work B, unchanged, so it is fetched and ends the walk; a
    // later chunk would not be.
    expect(asked).toEqual(['g.json?d=qpyd', 'g0.json?d=qpyd', 'g1.json?d=qpyd']);
    expect(data.works[0].points[0]).toMatchObject({ name: '西明石駅', geo: [34.7, 134.961811] });
    expect(data.works[1].points[0]).toMatchObject({ name: '光坂' });
    expect(cache.stored.modified).toBe(3000);
  });

  it('skips the chunks after an unchanged one', async () => {
    const WORK_C = [7, 'C', 0, 'C', 0, '#000', 0, 0, 'TV', 1, 2, 3, ['c1', 1, 2, 5], 0, [], 0, null, 0];
    const three = {
      'g.json': [[WORK_A, WORK_B, WORK_C], 1, 2000],
      'g0.json': chunk(419801, [POINT_A1, POINT_A2], 2000),
      'g1.json': chunk(51, [POINT_B], 1000),
      'g2.json': chunk(7, [['c1', 'C spot', 0, 0, 0, 0, 0, 0, 0, '', 0, 0, 0, 0, 0]], 500),
    };
    const first = await loadAnitabi({ ...server(three), cache: memoryCache(), now: NOW });
    const { asked, fetchJson } = server({ ...three, 'g.json': [[WORK_A, WORK_B, WORK_C], 1, 2500] });
    const data = await loadAnitabi({ fetchJson, cache: memoryCache(first), now: NOW });
    expect(asked).toEqual(['g.json?d=qpyd', 'g0.json?d=qpyd']);
    expect(data.works[2].points[0].name).toBe('C spot');
  });

  it('falls back on the saved copy when the index cannot be had, and fails without one', async () => {
    const first = await loadAnitabi({ ...server(files), cache: memoryCache(), now: NOW });
    const offline = server({});
    expect(await loadAnitabi({ fetchJson: offline.fetchJson, cache: memoryCache(first), now: NOW })).toEqual(first);
    await expect(loadAnitabi({ fetchJson: offline.fetchJson, cache: memoryCache(), now: NOW })).rejects.toThrow('404');
  });

  it('loads without storage', async () => {
    const broken = {
      read: async (): Promise<AnitabiData> => Promise.reject(new Error('blocked')),
      write: async () => Promise.reject(new Error('blocked')),
    };
    const data = await loadAnitabi({ ...server(files), cache: broken, now: NOW });
    expect(data.works).toHaveLength(2);
  });
});
