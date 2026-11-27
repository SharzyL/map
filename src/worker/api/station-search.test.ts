import { describe, expect, it } from 'vitest';
import { romaji, romajiKey, stationKeys } from './search-keys.js';
import { foldName, type IndexedStation, StationIndex } from './station-search.js';

describe('foldName', () => {
  it('folds the ways of writing a name', () => {
    expect(foldName('渋谷')).toBe(foldName('涩谷'));
    expect(foldName('澀谷')).toBe('涩谷');
    expect(foldName('東京駅')).toBe('东京');
    expect(foldName('北京西站')).toBe('北京西');
    expect(foldName('代々木')).toBe('代代木');
    expect(foldName('霞ヶ関')).toBe(foldName('霞ケ関'));
    expect(foldName('しんじゅく')).toBe('シンジュク');
    expect(foldName('ＪＲ 難波')).toBe('jr难波');
    expect(foldName('押上〈スカイツリー前〉')).toBe('押上スカイツリー前');
    // A name that is only 駅 keeps it
    expect(foldName('駅')).toBe('驿');
  });
});

describe('romaji', () => {
  it('writes katakana as Hepburn', () => {
    const cases: Record<string, string> = {
      シンジュク: 'shinjuku',
      トウキョウ: 'toukyou',
      サッポロ: 'sapporo',
      ハッチョウボリ: 'hatchoubori',
      キョウト: 'kyouto',
      チャタンチョウ: 'chatanchou',
      ジョウバン: 'jouban',
      ティーズ: 'tizu',
      ファミリー: 'famiri',
      ウィング: 'wingu',
      ヴァ: 'va',
      しぶや: 'shibuya',
    };
    for (const [kana, latin] of Object.entries(cases)) expect(romaji(kana), kana).toBe(latin);
  });

  it('compares romaji however it is written', () => {
    const same = (...texts: string[]) => {
      for (const text of texts) expect(romajiKey(text), text).toBe(romajiKey(texts[0]));
    };
    same('tokyo', 'Tōkyō', 'toukyou', 'Tôkyô', 'TOKYO');
    same('osaka', 'oosaka', 'Ōsaka');
    same('shinjuku', 'sinzyuku', 'SHINJUKU', 'shin-juku');
    same('shimbashi', 'shinbashi', 'sinbasi');
    same('chiba', 'tiba');
    same('tsuruga', 'turuga');
    same('fukuoka', 'hukuoka');
    same('shuzenji', 'syuzenzi');
    same('hatchobori', 'hacchobori');
    expect(romajiKey('chuo')).not.toBe(romajiKey('fuo'));
  });
});

describe('StationIndex', () => {
  // With the keys the build adds
  const station = (n: string, y: string | null, w: number, c: 'jp' | 'cn' = 'jp', l: string[] = []): IndexedStation => {
    const raw = { c, n, y, r: [] as string[], o: [] as string[], p: null as [number, number] | null, l, w };
    return { ...raw, ...stationKeys(raw, foldName) };
  };
  const index = new StationIndex('v', [
    station('上野', 'ウエノ', 800),
    station('上野原', 'ウエノハラ', 200),
    station('京成上野', 'ケイセイウエノ', 500),
    station('上海', null, 990, 'cn', ['shanghai', 'sh']),
  ]);
  const found = (text: string) => index.find(text, 10).map((s) => s.n);

  it('ranks exact, then prefix, then inside', () => {
    expect(found('上野')).toEqual(['上野', '上野原', '京成上野']);
    expect(found('ueno')).toEqual(['上野', '上野原']);
    expect(found('うえの')).toEqual(['上野', '上野原', '京成上野']);
    expect(found('上')).toEqual(['上海', '上野', '上野原']);
    expect(found('sh')).toEqual(['上海']);
    expect(found('')).toEqual([]);
    expect(found('・')).toEqual([]);
  });
});
