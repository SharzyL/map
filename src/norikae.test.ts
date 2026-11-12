import { afterEach, describe, expect, it, vi } from 'vitest';
import { findStationsByName, japanNow, normalizeStationName, stationsNamed, type NorikaeStation } from './norikae.js';
import { nextDepartureIndex } from './timetable.js';

const station = (code: string, name: string, address = '東京'): NorikaeStation => ({
  code,
  name,
  type: 'station',
  address,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('station names', () => {
  it('ignores width, ケ/ヶ and a trailing 駅', () => {
    expect(normalizeStationName('霞ヶ関駅')).toBe(normalizeStationName('霞ケ関'));
    expect(normalizeStationName('ＪＲ難波')).toBe('JR難波');
  });

  it('keeps every station of the name, suffixed or not, and nothing else', () => {
    const results = [
      station('22961', '府中(東京都)'),
      station('27390', '府中(広島県)', '広島'),
      station('22963', '府中本町'),
      station('22941', '東府中'),
      { ...station('1', '府中'), type: 'bus' },
    ];
    expect(stationsNamed('府中', results).map(({ code }) => code)).toEqual(['22961', '27390']);
  });

  it('searches again with 駅 when a full result list misses the name', async () => {
    const longer = Array.from({ length: 10 }, (_, index) => station(String(index), `長${index}`));
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get('q');
      const results = q === '長' ? longer : [station('26307', '長', '兵庫')];
      return new Response(JSON.stringify({ results }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await findStationsByName('長')).map(({ code }) => code)).toEqual(['26307']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('next departure', () => {
  const table = (day: 'weekday' | 'saturday' | 'holiday') => ({
    day,
    departures: ['05:10', '12:00', '23:50', '00:20'].map((time) => ({
      time,
      train_id: time,
      kind: '普通',
      destination: 'X',
      extra: false,
    })),
  });

  it('is the first departure from now in today’s schedule', () => {
    // 2026-11-16 is a Monday; 03:00 UTC is 12:00 in Japan.
    const now = japanNow(new Date('2026-11-16T03:00:00Z'));
    expect(nextDepartureIndex(table('weekday'), now)).toBe(1);
    expect(nextDepartureIndex(table('saturday'), now)).toBe(-1);
  });

  it('counts departures after midnight as the end of the service day', () => {
    // 15:00 UTC is 00:00 on Tuesday in Japan; still Monday's service.
    expect(nextDepartureIndex(table('weekday'), { minutes: 23 * 60 + 55, weekday: 1 })).toBe(3);
  });
});
