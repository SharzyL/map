// The API's routing and the Yahoo endpoints, with a fake Yahoo upstream (no
// network, no Workers runtime).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpstreamTimeout, UpstreamUnavailable, type Upstream } from './core.js';
import basicHtml from './fixtures/basic.html?raw';
import ferryHtml from './fixtures/ferry.html?raw';
import linesHtml from './fixtures/lines.html?raw';
import noStationHtml from './fixtures/no_station.html?raw';
import statusLinesHtml from './fixtures/status-lines.html?raw';
import statusTimetableHtml from './fixtures/status-timetable.html?raw';
import suggestJson from './fixtures/suggest.json?raw';
import timetableHtml from './fixtures/timetable.html?raw';
import trainHtml from './fixtures/train.html?raw';
import { handleApi } from './index.js';
import { JP } from './osm-stations.js';

const NOW = new Date('2026-11-16T08:30:00+09:00');
const SHIBUYA = JP.get('22715');
const SHIBUYA_OSM = { osm: SHIBUYA.osm, lat: SHIBUYA.lat, lon: SHIBUYA.lon };

function osmOf(code: string | null) {
  const match = JP.get(code ?? '');
  return match ? { osm: match.osm, lat: match.lat, lon: match.lon } : { osm: [] as string[], lat: null, lon: null };
}

class FakeYahoo {
  calls: Array<[string, number]> = [];

  constructor(
    private readonly body = '',
    private readonly status = 200,
    private readonly error: Error | null = null,
  ) {}

  fetch = async (url: string, ttl: number): Promise<Upstream> => {
    this.calls.push([url, ttl]);
    if (this.error) throw this.error;
    return { status: this.status, text: this.body };
  };

  get query() {
    const params = new URL(this.calls.at(-1)[0]).searchParams;
    return (name: string) => params.getAll(name);
  }
}

async function call(path: string, yahoo = new FakeYahoo(), method = 'GET') {
  const resp = await handleApi(method, `https://map.test${path}`, { fetch: yahoo.fetch, now: NOW });
  return { resp, body: resp.body ? JSON.parse(resp.body) : null };
}

const R = '/api/v1/norikae/routes';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routes', () => {
  it('defaults to the time in Japan now', async () => {
    const yahoo = new FakeYahoo(basicHtml);
    const { resp, body } = await call(`${R}?from=渋谷&to=東京`, yahoo);
    expect(resp.status).toBe(200);
    expect(resp.headers['cache-control']).toBe('public, max-age=300');
    const q = yahoo.query;
    expect([q('y'), q('m'), q('d')]).toEqual([['2026'], ['11'], ['16']]);
    expect([q('hh'), q('m1'), q('m2')]).toEqual([['8'], ['3'], ['0']]);
    expect(q('type')).toEqual(['1']);
    expect(body.query.date).toBe('2026-11-16');
    expect(body.query.time).toBe('08:30');
    expect(body.routes).toHaveLength(3);
    expect(body.routes[0].legs[0].from.name).toBe('渋谷');
    expect(body.source_url).toBe(yahoo.calls.at(-1)[0]);
  });

  it('maps its options to Yahoo parameters', async () => {
    const yahoo = new FakeYahoo(basicHtml);
    const { resp, body } = await call(
      `${R}?from=新宿&via=渋谷&via=品川&to=東京&date=2026-12-01` +
        '&time=21:05&time_type=arrival&sort=fare&ticket=cash&seat=green' +
        '&walk=fast&exclude=bus,shinkansen&page=2',
      yahoo,
    );
    expect(resp.status).toBe(200);
    const q = yahoo.query;
    expect(q('via')).toEqual(['渋谷', '品川']);
    expect([q('m'), q('d'), q('hh')]).toEqual([['12'], ['01'], ['21']]);
    expect([q('m1'), q('m2'), q('type')]).toEqual([['0'], ['5'], ['4']]);
    expect([q('s'), q('ticket'), q('expkind')]).toEqual([['1'], ['normal'], ['3']]);
    expect([q('ws'), q('hb'), q('lb'), q('shin')]).toEqual([['1'], ['0'], ['0'], ['0']]);
    expect([q('ex'), q('al'), q('sr')]).toEqual([['1'], ['1'], ['1']]);
    expect([q('fl'), q('tl')]).toEqual([['4'], ['6']]);
    expect(body.query.exclude).toEqual(['highway_bus', 'local_bus', 'shinkansen']);
  });

  it.each([
    `${R}?from=渋谷`,
    `${R}?from=渋谷&to=`,
    `${R}?from=渋谷&to=東京&date=2026/11/16`,
    `${R}?from=渋谷&to=東京&date=2026-02-30`,
    `${R}?from=渋谷&to=東京&time=25:00`,
    `${R}?from=渋谷&to=東京&time=08:30&time_type=last`,
    `${R}?from=渋谷&to=東京&time_type=soon`,
    `${R}?from=渋谷&to=東京&exclude=rocket`,
    `${R}?from=渋谷&to=東京&page=0`,
    `${R}?from=渋谷&to=東京&from=新宿`,
    `${R}?from=渋谷&to=東京&sort_by=fare`,
    `${R}?from=A&via=B&via=C&via=D&via=E&to=F`,
  ])('rejects %s', async (path) => {
    const { resp, body } = await call(path);
    expect(resp.status).toBe(400);
    expect(resp.headers['cache-control']).toBe('no-store');
    expect(body.error.code).toBe('bad_request');
  });

  it("answers an unknown station with 404 and Yahoo's message", async () => {
    const { resp, body } = await call(`${R}?from=zzqqxx&to=東京`, new FakeYahoo(noStationHtml));
    expect(resp.status).toBe(404);
    expect(body).toEqual({ error: { code: 'not_found', message: '「zzqqxx」に該当する出発地はありませんでした。' } });
  });

  it('answers a page it cannot parse with 502', async () => {
    const { resp, body } = await call(`${R}?from=a&to=b`, new FakeYahoo('<html></html>'));
    expect(resp.status).toBe(502);
    expect(body.error.code).toBe('upstream_parse_error');
  });

  it('gives route places their OSM features', async () => {
    const { body } = await call(`${R}?from=渋谷&to=東京`, new FakeYahoo(basicHtml));
    const legs = body.routes.flatMap((r: { legs: unknown[] }) => r.legs);
    expect(legs[0].from.osm).toEqual(SHIBUYA.osm);
    for (const leg of legs) {
      for (const p of [leg.from, leg.to, ...leg.stops]) {
        expect({ osm: p.osm, lat: p.lat, lon: p.lon }).toEqual(osmOf(p.id));
      }
    }
  });

  it('leaves places without a Yahoo id without OSM features', async () => {
    const { body } = await call(`${R}?from=a&to=b`, new FakeYahoo(ferryHtml));
    const ferry = body.routes[0].legs.find((leg: { mode: string }) => leg.mode === 'ferry');
    expect(ferry.from.id).toBeNull();
    expect(ferry.from.osm).toEqual([]);
    expect(ferry.from.lat).toBeNull();
  });
});

describe('upstream failures', () => {
  it.each([
    [new FakeYahoo('', 500), 502, 'upstream_error'],
    [new FakeYahoo('', 404), 404, 'not_found'],
    [new FakeYahoo('""', 400), 400, 'bad_request'],
    [new FakeYahoo('', 403), 503, 'region_unavailable'],
    [new FakeYahoo('', 200, new UpstreamTimeout()), 504, 'upstream_timeout'],
    [new FakeYahoo('', 200, new UpstreamUnavailable('dns')), 502, 'upstream_error'],
    [new FakeYahoo('', 200, new Error('boom')), 500, 'internal_error'],
  ])('maps to %#: %i %s', async (yahoo, status, code) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { resp, body } = await call('/api/v1/norikae/stations/22715/timetables', yahoo);
    expect(resp.status).toBe(status);
    expect(body.error.code).toBe(code);
  });

  it('reports a region block as such', async () => {
    const { resp, body } = await call('/api/v1/norikae/stations?q=渋谷', new FakeYahoo('', 403));
    expect(resp.status).toBe(503);
    expect(resp.headers['cache-control']).toBe('no-store');
    expect(body).toEqual({
      error: { code: 'region_unavailable', message: 'API not available in your region temporarily' },
    });
  });
});

describe('stations', () => {
  it('lists stations only by default', async () => {
    const yahoo = new FakeYahoo(suggestJson);
    const { resp, body } = await call('/api/v1/norikae/stations?q=渋谷', yahoo);
    expect(resp.status).toBe(200);
    expect(body.results[0]).toEqual({
      code: '22715',
      name: '渋谷',
      type: 'station',
      address: '東京',
      yahoo_lat: 35.658516,
      yahoo_lon: 139.701773,
      ...SHIBUYA_OSM,
    });
    expect(body.results.every((r: { type: string }) => r.type === 'station')).toBe(true);

    const { body: all } = await call('/api/v1/norikae/stations?q=渋谷&type=all', yahoo);
    const buses = all.results.filter((r: { type: string }) => r.type === 'bus');
    expect(buses.length).toBeGreaterThan(0);
    for (const bus of buses) {
      // The OSM mapping only covers stations; positions are OSM's only, and
      // Yahoo's stay in yahoo_lat / yahoo_lon
      expect(bus.osm).toEqual([]);
      expect(bus.lat).toBeNull();
      expect(bus.yahoo_lat).not.toBeNull();
    }
  });

  it('answers a search Yahoo rejects with 400', async () => {
    const { resp, body } = await call('/api/v1/norikae/stations?q=%3C', new FakeYahoo('""', 400));
    expect(resp.status).toBe(400);
    expect(body).toEqual({ error: { code: 'bad_request', message: 'Yahoo rejected the request' } });
  });

  it("lists a station's lines", async () => {
    const yahoo = new FakeYahoo(linesHtml);
    const { resp, body } = await call('/api/v1/norikae/stations/22715/timetables/', yahoo);
    expect(resp.status).toBe(200);
    expect(yahoo.calls.at(-1)).toEqual(['https://transit.yahoo.co.jp/timetable/22715', 86400]);
    expect(body.station).toEqual({ code: '22715', name: '渋谷', ...SHIBUYA_OSM });
    expect(body.lines[0].directions[0]).toEqual({
      direction: '新宿・高崎・宇都宮',
      gid: '1051',
      // Where its trains come from
      source: '逗子・小田原',
    });
  });

  it('gives a timetable, filtered by hour', async () => {
    const yahoo = new FakeYahoo(timetableHtml);
    const { resp, body } = await call('/api/v1/norikae/stations/22715/timetables/1051?day=weekday&hours=7-8', yahoo);
    expect(resp.status).toBe(200);
    expect(yahoo.calls.at(-1)[0]).toBe('https://transit.yahoo.co.jp/timetable/22715/1051?kind=1');
    expect(body.day).toBe('weekday');
    expect(new Set(body.departures.map((d: { time: string }) => d.time.slice(0, 2)))).toEqual(new Set(['07', '08']));
    expect(body.departures[0]).toEqual({
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
      express_toll: false,
      kind_color: null,
    });
    // Yahoo leaves the car count out for some trains
    expect(body.departures.map((d: { cars: number | null }) => d.cars)).toContain(null);
  });

  it.each([
    '/api/v1/norikae/stations/22715/timetables/1051?day=sunday',
    '/api/v1/norikae/stations/22715/timetables/1051?hours=9-5',
    '/api/v1/norikae/stations/22715/timetables/1051?hours=x',
  ])('rejects %s', async (path) => {
    expect((await call(path)).resp.status).toBe(400);
  });

  it("gives a train's stops", async () => {
    const { resp, body } = await call(
      '/api/v1/norikae/stations/22715/timetables/1051/trains/33471',
      new FakeYahoo(trainHtml),
    );
    expect(resp.status).toBe(200);
    expect(body.train_id).toBe('33471');
    expect(body.comments).toEqual(['大宮−小山間快速。']);
    expect(body.stops[0]).toEqual({
      code: '23096',
      name: '大船',
      arrival: null,
      departure: '08:16',
      ...osmOf('23096'),
    });
    expect(body.station.osm).toEqual(SHIBUYA.osm);
    expect(body.line).toBe('ＪＲ湘南新宿ライン');
  });

  it("names a train's line after the timetable it was opened from", async () => {
    // The page lists every line at the station; 7171 is 山手線外回り's
    const { body } = await call(
      '/api/v1/norikae/stations/22715/timetables/7171/trains/33471',
      new FakeYahoo(trainHtml),
    );
    expect(body.line).toBe('ＪＲ山手線外回り');
  });
});

describe('service notices', () => {
  it('gives the lines of a station with notices, fetched and kept for minutes', async () => {
    const yahoo = new FakeYahoo(statusLinesHtml);
    const { resp, body } = await call('/api/v1/norikae/stations/21338/status', yahoo);
    expect(resp.status).toBe(200);
    expect(resp.headers['cache-control']).toBe('public, max-age=180');
    // Not the lines page the timetable keeps for a day
    expect(yahoo.calls.at(-1)).toEqual(['https://transit.yahoo.co.jp/timetable/21338?diainfo=1', 180]);
    expect(body.source_url).toBe('https://transit.yahoo.co.jp/timetable/21338');
    expect(body.lines.map((line: { line: string }) => line.line)).toEqual(['ＪＲ陸羽西線', 'ＪＲ陸羽東線']);
  });

  it('gives a direction’s line and its notices', async () => {
    const yahoo = new FakeYahoo(statusTimetableHtml);
    const { resp, body } = await call('/api/v1/norikae/stations/21338/timetables/510/status', yahoo);
    expect(resp.status).toBe(200);
    expect(yahoo.calls.at(-1)).toEqual(['https://transit.yahoo.co.jp/timetable/21338/510?diainfo=1', 180]);
    expect(body.line).toBe('陸羽東線');
    expect(body.notices[0].message).toContain('鳴子温泉〜新庄駅間の運転を見合わせています');
    expect(body.url).toBe('https://transit.yahoo.co.jp/traininfo/detail/460/0/');
  });
});

describe('protocol', () => {
  it.each([
    '/api/v2/routes',
    '/api/v1/norikae/stations/abc/timetables',
    '/api/v1/doc',
    '/api/v1/routes',
    '/api/v1/cr-stations',
  ])('answers %s with 404', async (path) => {
    expect((await call(path)).resp.status).toBe(404);
  });

  it('lists the endpoints and the doc', async () => {
    const { resp, body } = await call('/api/v1');
    expect(resp.status).toBe(200);
    expect(body.doc).toBe('/api/v1/doc.md');
    expect(body.endpoints).toContain('/api/v1/cr/trains/{train}');
  });

  it('takes GET, HEAD and OPTIONS only', async () => {
    let { resp } = await call(R, undefined, 'POST');
    expect([resp.status, resp.headers.allow]).toEqual([405, 'GET, HEAD, OPTIONS']);
    ({ resp } = await call(R, undefined, 'OPTIONS'));
    expect(resp.status).toBe(204);
    expect(resp.headers['access-control-allow-origin']).toBe('*');
    const head = await call('/api/v1', undefined, 'HEAD');
    expect([head.resp.status, head.body]).toEqual([200, null]);
  });
});
