import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  chinaNow,
  departures,
  findStationsByName,
  forgetResponses,
  japanNow,
  normalizeStationName,
  stationsNamed,
  type NorikaeStation,
} from './norikae.js';
import { forgetTodaysDay, nextCrTrainIndex, nextDepartureIndex, rememberTodaysDay, todaysDay } from './timetable.js';

const station = (code: string, name: string, address = '東京'): NorikaeStation => ({
  code,
  name,
  type: 'station',
  address,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  forgetResponses();
  forgetTodaysDay();
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
      const q = new URL(url, 'http://localhost').searchParams.get('q');
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
    // 01:00 on Monday is still Sunday's service
    expect(nextDepartureIndex(table('holiday'), { minutes: 60, weekday: 1 })).toBe(-1);
    expect(todaysDay({ minutes: 60, weekday: 1 })).toBe('holiday');
  });

  it('takes today’s day type from Yahoo, which knows the holidays', () => {
    // 2026-11-23, a Monday, is 勤労感謝の日; 03:00 UTC is 12:00 in Japan.
    const holiday = japanNow(new Date('2026-11-23T03:00:00Z'));
    expect(todaysDay(holiday)).toBe('weekday');
    rememberTodaysDay('holiday', holiday);
    expect(nextDepartureIndex(table('holiday'), holiday)).toBe(1);
    expect(nextDepartureIndex(table('weekday'), holiday)).toBe(-1);
    // Still that holiday's service at 01:00 the next day, a weekday after
    expect(todaysDay(japanNow(new Date('2026-11-23T16:00:00Z')))).toBe('holiday');
    expect(todaysDay(japanNow(new Date('2026-11-24T03:00:00Z')))).toBe('weekday');
  });

  it('does not take Yahoo’s day after midnight, when its day is unclear', () => {
    // 01:00 on Tuesday 2026-11-24 in Japan
    rememberTodaysDay('holiday', japanNow(new Date('2026-11-23T16:00:00Z')));
    expect(todaysDay(japanNow(new Date('2026-11-24T03:00:00Z')))).toBe('weekday');
  });
});

describe('remembered answers', () => {
  const answer = (cacheControl: string | null) =>
    vi.fn(async () => {
      const headers: Record<string, string> = cacheControl ? { 'cache-control': cacheControl } : {};
      return new Response(JSON.stringify({ day: 'holiday', departures: [] }), { status: 200, headers });
    });

  it('last as long as the API says, so today’s timetable is asked again', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T03:00:00Z') });
    const fetchMock = answer('public, max-age=600');
    vi.stubGlobal('fetch', fetchMock);
    await departures('22715', '1051', null);
    vi.setSystemTime(new Date('2026-11-22T03:09:00Z'));
    await departures('22715', '1051', null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A day later, as a page left open would ask
    vi.setSystemTime(new Date('2026-11-23T03:00:00Z'));
    await departures('22715', '1051', null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('last for the page’s life without a Cache-Control', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-22T03:00:00Z') });
    const fetchMock = answer(null);
    vi.stubGlobal('fetch', fetchMock);
    await departures('22715', '1051', 'weekday');
    vi.setSystemTime(new Date('2026-11-25T03:00:00Z'));
    await departures('22715', '1051', 'weekday');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
