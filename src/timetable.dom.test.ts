// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrTrainSchedule, TrainRoute } from './norikae.js';
import { installTimetable, timetableButton, TIMETABLE_OPEN_EVENT, timetableRequestFor } from './timetable.js';

const crPath = (path: string) => '/v1/' + path.split('/').map(encodeURIComponent).join('/');
const CR_STATION = {
  data_version: '20261114',
  station: { name: '北京西', telecode: 'BXP' },
  date: '2026-11-16',
  trains: [
    {
      train: 'Z156/Z157',
      arrival: '05:36',
      departure: '06:02',
      origin: '泰州',
      destination: '哈尔滨西',
      day: 2,
      platform: '10',
    },
    {
      train: 'G301',
      arrival: null,
      departure: '08:00',
      origin: '北京西',
      destination: '广州南',
      day: 1,
      platform: '7',
    },
    {
      train: 'K2550',
      arrival: '09:11',
      departure: null,
      origin: '沈阳北',
      destination: '北京西',
      day: 1,
      platform: null,
    },
  ],
};
const CR_TRAIN: CrTrainSchedule = {
  data_version: '20261114',
  train: 'Z156/Z157',
  date: '2026-11-15',
  trains: [
    {
      train: 'Z156/Z157',
      service: { from: '2024-04-02', to: '2026-11-24' },
      runs: true,
      stops: [
        { name: '泰州', telecode: 'UTH', arrival: null, departure: '15:00', day: 1, km: 0, platform: null },
        {
          name: '北京西',
          telecode: 'BXP',
          arrival: '05:36',
          departure: '06:02',
          day: 2,
          km: 1200,
          platform: '10',
          elements: ['N7780210950'],
          position: [116.3151, 39.8937],
        },
        { name: '哈尔滨西', telecode: 'VAB', arrival: '18:00', departure: null, day: 2, km: 2400, platform: null },
      ],
    },
  ],
};

// A train route as the API gives it; what is in it is the drawer's business.
const ROUTE: TrainRoute = {
  data_version: '2026-11-12T16:00:00Z',
  bbox: [0, 0, 1, 1],
  ways: [1],
  partial: [],
  overview: [],
  stops: [],
  legs: [],
};

const API: Record<string, unknown> = {
  [crPath('cr-trains/Z156/Z157/route').replace('/Z157', '%2FZ157')]: ROUTE,
  '/v1/stations/22715/timetables/1051/trains/33471/route': ROUTE,
  [crPath('cr-stations/北京西/timetable')]: CR_STATION,
  [crPath('cr-stations/泰州/timetable')]: { ...CR_STATION, station: { name: '泰州', telecode: 'UTH' } },
  [crPath('cr-trains/Z156/Z157').replace('/Z157', '%2FZ157')]: CR_TRAIN,
  '/v1/stations': { results: [{ code: '22715', name: '渋谷', type: 'station', address: '東京' }] },
  '/v1/stations/22715/timetables': {
    source_url: 'https://transit.yahoo.co.jp/timetable/22715',
    station: { code: '22715', name: '渋谷' },
    lines: [
      {
        name: 'ＪＲ湘南新宿ライン',
        directions: [
          { direction: '新宿・高崎・宇都宮', gid: '1051' },
          { direction: '横浜・大船', gid: '1050' },
        ],
      },
    ],
  },
  '/v1/stations/22715/timetables/1051': {
    source_url: 'https://transit.yahoo.co.jp/timetable/22715/1051?kind=1',
    station: { code: '22715', name: '渋谷' },
    line: 'ＪＲ湘南新宿ライン',
    direction: '新宿・高崎・宇都宮',
    day: 'weekday',
    departures: [
      { time: '07:16', train_id: '33461', kind: '普通', destination: '小金井', extra: false },
      { time: '08:02', train_id: '33471', kind: '快速', destination: '宇都宮', extra: true },
    ],
  },
  '/v1/stations/22715/timetables/1051/trains/33471': {
    source_url: 'https://transit.yahoo.co.jp/timetable/22715/1051/33471',
    station: { code: '22715', name: '渋谷' },
    train_id: '33471',
    name: '快速',
    line: 'ＪＲ湘南新宿ライン',
    comments: ['大宮−小山間快速。'],
    stops: [
      { code: '23096', name: '大船', arrival: null, departure: '07:30' },
      {
        code: '22715',
        name: '渋谷',
        arrival: '08:01',
        departure: '08:02',
        osm: ['N241896099'],
        lat: 35.6587,
        lon: 139.7016,
      },
      { code: '23500', name: '宇都宮', arrival: '09:50', departure: null },
    ],
  },
};

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const { pathname, search } = new URL(url);
      requests.push(pathname + search);
      const body = API[pathname];
      return new Response(JSON.stringify(body ?? { error: { message: 'not found' } }), { status: body ? 200 : 404 });
    }),
  );
  const map = { getContainer: () => container, flyTo: vi.fn(), getZoom: () => 10 };
  const route = { show: vi.fn(), clear: vi.fn() };
  const panel = installTimetable(map, route);
  return { container, panel, requests, map, route };
}

const text = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((node) => node.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('timetable panel', () => {
  it('goes from lines to departures to a train’s stops and back', async () => {
    const { container, panel, map, route } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '渋谷', codes: ['22715'] } }));
    expect(panel.isOpen).toBe(true);
    const root = panel.panel;
    await vi.waitFor(() => expect(text(root, '.timetable-direction')).toHaveLength(2));
    expect(text(root, '.timetable-line-name')).toEqual(['ＪＲ湘南新宿ライン']);
    expect(root.querySelector('.timetable-title').textContent).toBe('渋谷');

    root.querySelector<HTMLButtonElement>('.timetable-direction').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toEqual(['07:16', '08:02']));
    expect(text(root, '.timetable-hour')).toEqual(['7時', '8時']);
    expect(root.querySelector('.timetable-summary').textContent).toBe('ＪＲ湘南新宿ライン → 新宿・高崎・宇都宮');
    expect(root.querySelector('.timetable-day[aria-pressed="true"]').textContent).toBe('Weekday');
    expect(root.querySelector<HTMLAnchorElement>('.timetable-source').href).toContain('/timetable/22715/1051');

    // The back button stays outside the scrolling list.
    expect(root.querySelector('.timetable-nav .timetable-back').textContent).toBe('← Lines');
    expect(root.querySelector('.timetable-body .timetable-back')).toBeNull();

    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['大船', '渋谷', '宇都宮']));
    expect(root.querySelector('.timetable-stop-here').textContent).toContain('渋谷');
    expect(text(root, '.timetable-stop-time')).toEqual(['07:30', '08:01 – 08:02', '09:50']);
    expect(text(root, '.timetable-comment')).toEqual(['大宮−小山間快速。']);
    expect(text(root, '.timetable-meta dd')).toEqual(['快速', 'ＪＲ湘南新宿ライン', '3']);
    // The train's route goes on the map, and stops the API placed get a button to fly there.
    await vi.waitFor(() => expect(route.show).toHaveBeenCalledWith(ROUTE, '渋谷', expect.anything()));
    const locate = root.querySelectorAll<HTMLButtonElement>('button.timetable-stop-locate');
    expect(locate).toHaveLength(1);
    locate[0].click();
    expect(map.flyTo).toHaveBeenCalledWith({ center: [139.7016, 35.6587], zoom: 14 });
    const clears = route.clear.mock.calls.length;

    root.querySelector<HTMLButtonElement>('.timetable-back').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toEqual(['07:16', '08:02']));
    expect(route.clear.mock.calls.length).toBeGreaterThan(clears);
    root.querySelector<HTMLButtonElement>('.timetable-back').click();
    await vi.waitFor(() => expect(text(root, '.timetable-direction')).toHaveLength(2));
    expect(root.querySelector('.timetable-back')).toBeNull();
  });

  it('switches day types and looks stations up by name without codes', async () => {
    const { container, panel, requests } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '渋谷', codes: [] } }));
    await vi.waitFor(() => expect(text(panel.panel, '.timetable-direction')).toHaveLength(2));
    expect(requests[0]).toBe('/v1/stations?q=%E6%B8%8B%E8%B0%B7');

    panel.panel.querySelector<HTMLButtonElement>('.timetable-direction').click();
    await vi.waitFor(() => expect(text(panel.panel, '.timetable-time')).toHaveLength(2));
    Array.from(panel.panel.querySelectorAll<HTMLButtonElement>('.timetable-day'))
      .find((button) => button.textContent === 'Saturday')
      .click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe('/v1/stations/22715/timetables/1051?day=saturday'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.isOpen).toBe(false);
    expect(panel.panel.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the error of a failed request', async () => {
    const { container, panel } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '架空', codes: ['99999'] } }));
    await vi.waitFor(() =>
      expect(panel.panel.querySelector('.timetable-error').textContent).toBe('Could not load the timetable: not found'),
    );
  });
});

describe('China Railway timetable', () => {
  it('lists a station’s trains by date and opens a train’s stops', async () => {
    const { container, panel, requests, route } = setup();
    // The OSM elements are unknown here, so the panel falls back to the name.
    container.dispatchEvent(
      new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '北京西站', cr: ['N1,W2', '北京西'] } }),
    );
    const root = panel.panel;
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toEqual(['Z156/Z157', 'G301', 'K2550']));
    expect(requests.slice(0, 2)).toEqual([
      crPath('cr-stations/N1,W2/timetable'),
      crPath('cr-stations/北京西/timetable'),
    ]);
    expect(root.querySelector('.timetable-title').textContent).toBe('北京西');
    expect(root.querySelector('.timetable-summary').textContent).toBe('2026-11-16 Mon · 3 trains');
    expect(text(root, '.timetable-hour')).toEqual(['6时', '8时', '9时']);
    expect(text(root, '.timetable-time')).toEqual(['06:02', '08:00', '09:11']);
    expect(root.querySelector('.timetable-time-arrival').textContent).toBe('09:11');
    expect(text(root, '.timetable-platform')).toEqual(['10', '7', '']);
    const source = root.querySelector<HTMLAnchorElement>('.timetable-source');
    expect(source.textContent).toBe('lltskb 20261114');
    expect(source.hasAttribute('href')).toBe(false);

    // Date steps replace the view instead of stacking on the back button.
    Array.from(root.querySelectorAll<HTMLButtonElement>('.timetable-day'))
      .find((button) => button.textContent === '›')
      .click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe(`${crPath('cr-stations/北京西/timetable')}?date=2026-11-17`));
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toHaveLength(3));
    expect(root.querySelector('.timetable-back')).toBeNull();

    // Z156/Z157 stops here on the second day of its run, so it left the day before.
    root.querySelector<HTMLButtonElement>('.timetable-departure-button').click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['泰州', '北京西', '哈尔滨西']));
    expect(requests).toContain('/v1/cr-trains/Z156%2FZ157?date=2026-11-15');
    await vi.waitFor(() => expect(route.show).toHaveBeenCalledWith(ROUTE, '北京西', expect.anything()));
    expect(requests).toContain('/v1/cr-trains/Z156%2FZ157/route?date=2026-11-15');
    expect(root.querySelector('.timetable-summary').textContent).toBe('Z156/Z157 · 泰州 → 哈尔滨西');
    expect(text(root, '.timetable-meta dt')).toEqual(['Train', 'Departs', 'In service', 'Distance', 'Stops']);
    expect(text(root, '.timetable-meta dd')).toEqual([
      'Z156/Z157',
      '2026-11-15 Sun from 泰州',
      '2024-04-02 – 2026-11-24',
      '2400 km',
      '3',
    ]);
    expect(root.querySelector('.timetable-stop-here').textContent).toContain('北京西');
    expect(text(root, '.timetable-stop-day')).toEqual(['+1', '+1']);
    expect(root.querySelector('.timetable-back').textContent).toBe('← Trains');

    // A stop opens that station's trains on the day the train is there.
    root.querySelector<HTMLButtonElement>('.timetable-stop-name').click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe(`${crPath('cr-stations/泰州/timetable')}?date=2026-11-15`));
  });

  it('says so when no way of naming the station is known', async () => {
    const { container, panel } = setup();
    container.dispatchEvent(
      new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '申滨南路', cr: ['N9', '申滨南路'] } }),
    );
    await vi.waitFor(() =>
      expect(panel.panel.querySelector('.timetable-status').textContent).toBe(
        'No China Railway timetable for 申滨南路.',
      ),
    );
  });
});

describe('Timetable button', () => {
  const stationAt = (lng: number, lat: number, properties: Record<string, unknown>) => ({
    sourceLayer: 'standard_railway_text_stations',
    properties: { feature: 'station', ...properties },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  });

  it('appears on stations with Yahoo codes', () => {
    expect(timetableRequestFor(stationAt(139.7, 35.66, { name: '渋谷', yahoo_codes: '22715;29342' }))).toEqual({
      name: '渋谷',
      codes: ['22715', '29342'],
    });
    // Without codes a Japanese station gets none, even a kanji-only name in Kyushu.
    expect(timetableRequestFor(stationAt(139.7, 35.66, { name: '渋谷' }))).toBeNull();
    expect(timetableRequestFor(stationAt(130.42, 33.59, { name: '博多', station: 'train' }))).toBeNull();
    expect(
      timetableRequestFor({
        ...stationAt(139.7, 35.66, { name: '渋谷', yahoo_codes: '22715' }),
        sourceLayer: 'railway_line_high',
      }),
    ).toBeNull();
  });

  it('appears on mainline stations in China, with their OSM elements and then their name', () => {
    const china = (lng: number, lat: number, properties: Record<string, unknown>) =>
      timetableRequestFor(
        stationAt(lng, lat, { station: 'train', osm_id: '7780210950', osm_type: 'N', ...properties }),
      );
    expect(china(116.32, 39.89, { name: '北京西' })).toEqual({ name: '北京西', cr: ['N7780210950', '北京西'] });
    expect(china(116.32, 39.89, { name: '北京西站', osm_id: '1\u001e1\u001e2', osm_type: 'N\u001eN\u001eW' })).toEqual({
      name: '北京西站',
      cr: ['N1,W2', '北京西'],
    });
    // Shenyang lies inside a box around Japan, but is no Japanese station.
    expect(china(123.43, 41.82, { name: '沈阳北' })).toEqual({ name: '沈阳北', cr: ['N7780210950', '沈阳北'] });
    expect(china(116.32, 39.89, { name: '北京西站', station: 'subway' })).toBeNull();
    expect(china(121.52, 25.05, { name: '臺北' })).toBeNull();
    expect(china(126.97, 37.55, { name: '서울역' })).toBeNull();
    expect(china(116.32, 39.89, { name: 'Beijing West' })).toBeNull();
  });

  it('opens the timetable from the info box', () => {
    const content = document.createElement('div');
    content.innerHTML =
      '<h5 class="orm-popup-title">Station</h5><h6 class="orm-popup-label">渋谷</h6><div class="orm-popup-section"></div>';
    document.body.appendChild(content);
    const opened = vi.fn();
    document.body.addEventListener(TIMETABLE_OPEN_EVENT, (event) => opened((event as CustomEvent).detail));
    timetableButton(
      {
        sourceLayer: 'standard_railway_text_stations',
        properties: { feature: 'station', name: '渋谷', yahoo_codes: '22715' },
        geometry: { type: 'Point', coordinates: [139.7, 35.66] },
      },
      content,
    );
    expect(content.querySelector('.orm-popup-label .orm-popup-action').textContent).toBe('Timetable');
    content.querySelector<HTMLButtonElement>('.orm-popup-action').click();
    expect(opened).toHaveBeenCalledWith({ name: '渋谷', codes: ['22715'] });
  });
});
