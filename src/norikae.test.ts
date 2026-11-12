import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  chinaNow,
  findStationsByName,
  japanNow,
  normalizeStationName,
  stationsNamed,
  type NorikaeStation,
} from './norikae.js';
import { nextCrTrainIndex, nextDepartureIndex } from './timetable.js';

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

describe('China Railway dates', () => {
  it('uses China time', () => {
    // 17:30 UTC is 01:30 the next day in China.
    expect(chinaNow(new Date('2026-11-16T17:30:00Z'))).toEqual({ date: '2026-11-17', minutes: 90 });
  });

  it('steps across months and years', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('highlights the next train, by arrival for trains ending here, only today', () => {
    const table = {
      date: '2026-11-16',
      trains: [
        { departure: '06:02', arrival: '05:36' },
        { departure: null, arrival: '09:11' },
        { departure: '12:00', arrival: null },
      ].map((times) => ({
        train: 'X',
        origin: 'A',
        destination: 'B',
        day: 1,
        platform: null as string | null,
        ...times,
      })),
    };
    expect(nextCrTrainIndex(table, { date: '2026-11-16', minutes: 8 * 60 })).toBe(1);
    expect(nextCrTrainIndex(table, { date: '2026-11-16', minutes: 23 * 60 })).toBe(-1);
    expect(nextCrTrainIndex(table, { date: '2026-11-17', minutes: 0 })).toBe(-1);
  });
});
