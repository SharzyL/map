import { describe, expect, it } from 'vitest';

import linesHtml from '../fixtures/lines.html?raw';
import linesExpected from '../fixtures/lines.expected.json';
import suggestJson from '../fixtures/suggest.json?raw';
import suggestExpected from '../fixtures/suggest.expected.json';
import timetableHtml from '../fixtures/timetable.html?raw';
import timetableExpected from '../fixtures/timetable.expected.json';
import trainHtml from '../fixtures/train.html?raw';
import trainExpected from '../fixtures/train.expected.json';
import { parseLines, parseSearch, parseTimetable, parseTrain, searchUrl, timetableUrl, trainUrl } from './timetable.js';

// The *.expected.json files are what the Python API returned for the same fixtures

describe('Yahoo timetable pages', () => {
  it('parses station search like the Python API', () => {
    const results = parseSearch(JSON.parse(suggestJson));
    expect(results).toEqual(suggestExpected);
    expect(results[0]).toMatchObject({ code: '22715', name: '渋谷', type: 'station' });
  });

  it('parses a station lines page like the Python API', () => {
    const lines = parseLines(linesHtml, '22715');
    expect(lines).toEqual(linesExpected);
    expect(lines.lines[0].directions[0]).toEqual({ direction: '新宿・高崎・宇都宮', gid: '1051' });
  });

  it('parses a timetable like the Python API', () => {
    const tt = parseTimetable(timetableHtml, '22715');
    expect(tt).toEqual(timetableExpected);
    expect(tt.departures.find((d) => d.time === '07:16')).toEqual({
      time: '07:16',
      train_id: '33461',
      kind: '普通',
      destination: '小金井',
      extra: false,
      name: '普通',
      kind_mark: null,
      destination_mark: '金',
      track: '3',
      cars: 15,
      train_number: '2520Y',
      starts_here: false,
      green_car: true,
    });
    // Yahoo leaves the car count out for some trains
    expect(tt.departures.some((d) => d.cars === null)).toBe(true);
  });

  it('parses a train like the Python API', () => {
    const train = parseTrain(trainHtml, '22715', '1051');
    expect(train).toEqual(trainExpected);
    expect(train.comments).toEqual(['大宮−小山間快速。']);
    expect(train.stops[0]).toEqual({ code: '23096', name: '大船', arrival: null, departure: '08:16' });
  });

  it("takes the train's line from the timetable it was opened from", () => {
    expect(parseTrain(trainHtml, '22715', '1051').line).toBe('ＪＲ湘南新宿ライン');
    // 7171 is 山手線外回り's
    expect(parseTrain(trainHtml, '22715', '7171').line).toBe('ＪＲ山手線外回り');
  });

  it('rejects a page without its data', () => {
    expect(() => parseTimetable('<html></html>', '22715')).toThrow();
    expect(() => parseTrain('<script id="__NEXT_DATA__" type="application/json">{}</script>', '1')).toThrow();
  });

  it('builds URLs as Python quotes them', () => {
    expect(searchUrl("渋谷 a/b!'()*~._-")).toBe(
      'https://transit.yahoo.co.jp/api/suggest?value=%E6%B8%8B%E8%B0%B7%20a/b%21%27%28%29%2A~._-',
    );
    expect(timetableUrl('22715', '1051', '1')).toBe('https://transit.yahoo.co.jp/timetable/22715/1051?kind=1');
    expect(timetableUrl('22715', '1051', null)).toBe('https://transit.yahoo.co.jp/timetable/22715/1051');
    expect(trainUrl('22715', '1051', '33471')).toBe('https://transit.yahoo.co.jp/timetable/22715/1051/33471');
  });
});
