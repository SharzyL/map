// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOAD_TASK_EVENT, type LoadTaskDetail } from './load-status.js';
import { forgetResponses, type CrTrainSchedule, type CrTrainset, type TrainRoute } from './norikae.js';
import {
  crBoundTabs,
  crLineTabs,
  crLinesBetweenStops,
  installTimetable,
  timetableButton,
  TIMETABLE_OPEN_EVENT,
  timetableRequestFor,
} from './timetable.js';

const crPath = (path: string) => '/api/v1/cr/' + path.split('/').map(encodeURIComponent).join('/');
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
      // It arrives as Z156 and leaves as Z157, onto another line.
      arrival_number: 'Z156',
      departure_number: 'Z157',
      bound: '下行',
      line: '京哈',
      line_in: '京沪',
      line_out: '京哈',
    },
    {
      train: 'G301',
      arrival: null,
      departure: '08:00',
      origin: '北京西',
      destination: '广州南',
      day: 1,
      platform: '7',
      arrival_number: null,
      departure_number: 'G301',
      bound: '下行',
      line: '京广高速',
      line_in: null,
      line_out: '京广高速',
    },
    {
      train: 'K2550',
      arrival: '09:11',
      departure: null,
      origin: '沈阳北',
      destination: '北京西',
      day: 1,
      platform: null,
      arrival_number: 'K2550',
      departure_number: null,
      bound: '上行',
      line: null,
      line_in: null,
      line_out: null,
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
      rolling_stock: { model: '25T', coupled: false, depot: '上局南京段', description: '25T型，DC600V供电' },
      lines: [
        {
          name: '京沪线',
          stations: [
            { name: '泰州', km: 0 },
            { name: '北京西', km: 1200 },
          ],
        },
        {
          name: '京哈线',
          stations: [
            { name: '北京西', km: 1200 },
            { name: '哈尔滨西', km: 2400 },
          ],
        },
      ],
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
          arrival_number: 'Z156',
          departure_number: 'Z157',
          bound: '下行',
        },
        { name: '哈尔滨西', telecode: 'VAB', arrival: '18:00', departure: null, day: 2, km: 2400, platform: null },
      ],
    },
  ],
};

// An EMU train whose track the API has not routed yet, with the trainset 12306 assigns.
const G301: CrTrainSchedule = {
  data_version: '20261114',
  train: 'G301',
  date: '2026-11-16',
  trains: [
    {
      train: 'G301',
      service: { from: '2026-01-27', to: null },
      runs: true,
      rolling_stock: { model: 'CR400AF', coupled: true, depot: null, description: 'CR400AF型重联' },
      lines: [],
      stops: [
        { name: '北京西', telecode: 'BXP', arrival: null, departure: '08:00', day: 1, km: 0, platform: '7' },
        { name: '广州南', telecode: 'IZQ', arrival: '16:00', departure: null, day: 1, km: 2298, platform: null },
      ],
    },
  ],
};
const G301_TRAINSET: CrTrainset = {
  source_url: 'https://mobile.12306.cn/',
  train: 'G301',
  date: '2026-11-16',
  trainset: {
    id: 'CR400AF-A-2001',
    model: 'CR400AF-A',
    brand: '复兴号',
    cars: 16,
    length_m: 414.26,
    capacity: 1193,
    max_speed_kmh: 350,
    details: [
      { name: '餐车', value: '09车' },
      { name: '静音车厢', value: null },
    ],
    coaches: ['01车 一等/商务 32/5', '02车 二等 93'],
  },
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
  [crPath('trains/Z156/Z157/route').replace('/Z157', '%2FZ157')]: ROUTE,
  '/api/v1/norikae/stations/22715/timetables/1051/trains/33471/route': ROUTE,
  [crPath('stations/北京西/timetable')]: CR_STATION,
  [crPath('stations/泰州/timetable')]: { ...CR_STATION, station: { name: '泰州', telecode: 'UTH' } },
  [crPath('trains/Z156/Z157').replace('/Z157', '%2FZ157')]: CR_TRAIN,
  // 12306 has no trainset for a loco-hauled train.
  [crPath('trainsets/Z156/Z157').replace('/Z157', '%2FZ157')]: { source_url: '', train: 'Z156', trainset: null },
  [crPath('trains/G301')]: G301,
  [crPath('trainsets/G301')]: G301_TRAINSET,
  '/api/v1/norikae/stations': { results: [{ code: '22715', name: '渋谷', type: 'station', address: '東京' }] },
  '/api/v1/norikae/stations/22715/timetables': {
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
  '/api/v1/norikae/stations/22715/timetables/1051': {
    source_url: 'https://transit.yahoo.co.jp/timetable/22715/1051?kind=1',
    station: { code: '22715', name: '渋谷' },
    line: 'ＪＲ湘南新宿ライン',
    direction: '新宿・高崎・宇都宮',
    day: 'weekday',
    departures: [
      {
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
        starts_here: true,
        green_car: true,
      },
      {
        time: '08:02',
        train_id: '33471',
        kind: '快速',
        destination: '宇都宮',
        extra: true,
        name: '快速',
        kind_mark: '快',
        destination_mark: '宇',
        track: '3',
        cars: 15,
        train_number: '2824Y',
        starts_here: false,
        green_car: true,
      },
    ],
  },
  '/api/v1/norikae/stations/22715/timetables/1051/trains/33471': {
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
      const { pathname, search } = new URL(url, 'http://localhost');
      requests.push(pathname + search);
      // A path set to fail answers once with that status, then as usual.
      const failure = failOnce.get(pathname);
      if (failure) {
        failOnce.delete(pathname);
        return new Response(JSON.stringify({ error: { message: 'upstream error' } }), { status: failure });
      }
      const body = API[pathname];
      return new Response(JSON.stringify(body ?? { error: { message: 'not found' } }), { status: body ? 200 : 404 });
    }),
  );
  const map = { getContainer: () => container, flyTo: vi.fn(), getZoom: () => 10 };
  const route = { sketch: vi.fn(), show: vi.fn(), unrouted: vi.fn(), hover: vi.fn(), clear: vi.fn() };
  const panel = installTimetable(map, route);
  return { container, panel, requests, map, route };
}

const text = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((node) => node.textContent);

const failOnce = new Map<string, number>();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  forgetResponses();
  failOnce.clear();
  localStorage.clear();
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
    expect(text(root, '.timetable-direction')).toEqual(['新宿・高崎・宇都宮方面', '横浜・大船方面']);
    expect(root.querySelector('.timetable-title').textContent).toBe('渋谷');

    root.querySelector<HTMLButtonElement>('.timetable-direction').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toEqual(['07:16', '08:02']));
    expect(text(root, '.timetable-hour')).toEqual(['7時', '8時']);
    expect(root.querySelector('.timetable-summary').textContent).toBe('ＪＲ湘南新宿ライン 新宿・高崎・宇都宮方面');
    expect(root.querySelector('.timetable-day[aria-pressed="true"]').textContent).toBe('平日');
    // The day buttons stay in view in the back button's row.
    expect(root.querySelector('.timetable-nav .timetable-day[aria-pressed="true"]').textContent).toBe('平日');
    expect(root.querySelector<HTMLAnchorElement>('.timetable-source').href).toContain('/timetable/22715/1051');

    // The back button stays outside the scrolling list.
    expect(root.querySelector('.timetable-nav .timetable-back').textContent).toBe('← 路線');
    expect(root.querySelector('.timetable-body .timetable-back')).toBeNull();

    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['大船', '渋谷', '宇都宮']));
    expect(root.querySelector('.timetable-stop-here').textContent).toContain('渋谷');
    expect(text(root, '.timetable-stop-time')).toEqual(['07:30', '08:01 – 08:02', '09:50']);
    expect(text(root, '.timetable-comment')).toEqual(['大宮−小山間快速。']);
    // The departure it was opened from knows its number, cars and track here.
    expect(text(root, '.timetable-meta dt')).toEqual(['列車', '列車番号', '路線', '両数', '番線', '停車駅']);
    expect(text(root, '.timetable-meta dd')).toEqual([
      '快速',
      '2824Y',
      'ＪＲ湘南新宿ライン',
      '15両 · グリーン車',
      '渋谷 3番線',
      '3駅',
    ]);
    // The train's route goes on the map, and stops the API placed get a button to fly there.
    await vi.waitFor(() => expect(route.show).toHaveBeenCalledWith(ROUTE, '渋谷', expect.anything()));
    const locate = root.querySelectorAll<HTMLButtonElement>('button.timetable-stop-locate');
    expect(locate).toHaveLength(1);
    locate[0].click();
    expect(map.flyTo).toHaveBeenCalledWith({ center: [139.7016, 35.6587], zoom: 14 });
    // Pointing at a placed stop marks it on the map.
    const placed = locate[0].closest('li');
    placed.dispatchEvent(new Event('pointerenter'));
    expect(route.hover).toHaveBeenLastCalledWith({ name: '渋谷', position: [139.7016, 35.6587] });
    placed.dispatchEvent(new Event('pointerleave'));
    expect(route.hover).toHaveBeenLastCalledWith(null);
    const clears = route.clear.mock.calls.length;

    root.querySelector<HTMLButtonElement>('.timetable-back').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toEqual(['07:16', '08:02']));
    expect(route.clear.mock.calls.length).toBeGreaterThan(clears);
    root.querySelector<HTMLButtonElement>('.timetable-back').click();
    await vi.waitFor(() => expect(text(root, '.timetable-direction')).toHaveLength(2));
    expect(root.querySelector('.timetable-back')).toBeNull();
  });

  it('shows each departure’s name, badges, cars and track, or lays them out as a printed timetable', async () => {
    const { container, panel } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '渋谷', codes: ['22715'] } }));
    const root = panel.panel;
    await vi.waitFor(() => expect(text(root, '.timetable-direction')).toHaveLength(2));
    root.querySelector<HTMLButtonElement>('.timetable-direction').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toEqual(['07:16', '08:02']));

    const rows = root.querySelectorAll('.timetable-jp-departures .timetable-departure-button');
    expect(text(root, '.timetable-jp-departures .timetable-kind')).toEqual(['普通', '快速']);
    // A type other than the line's usual one has a mark, and stands out.
    expect(rows[1].querySelector('.timetable-kind').classList).toContain('timetable-kind-special');
    expect(rows[0].querySelector('.timetable-kind').classList).not.toContain('timetable-kind-special');
    expect(text(root, '.timetable-train-info')).toEqual(['始G15両', 'G15両']);
    expect(text(root, '.timetable-jp-departures .timetable-platform')).toEqual(['3', '3']);
    expect((rows[0] as HTMLElement).title).toBe('列車番号 2520Y · 当駅始発 · グリーン車 · 3番線');

    // The printed layout, by a switch the browser remembers.
    const printed = root.querySelector<HTMLElement>('.timetable-printed');
    const list = root.querySelector<HTMLElement>('.timetable-jp-departures');
    expect(printed.hidden).toBe(true);
    // It stays in view in the back button's row, which the list scrolls below.
    expect(root.querySelector('.timetable-nav .timetable-toggle').textContent).toBe('時刻表形式');
    root.querySelector<HTMLInputElement>('.timetable-nav .timetable-toggle input').click();
    expect(printed.hidden).toBe(false);
    expect(list.hidden).toBe(true);
    expect(localStorage.getItem('atlas-realm:timetable-printed')).toBe('true');
    expect(text(root, '.timetable-grid-hour')).toEqual(['7', '8']);
    expect(text(root, '.timetable-grid-time')).toEqual(['16', '02']);
    expect(text(root, '.timetable-grid-marks')).toEqual(['●金', '宇[快]◆']);
    expect(text(root, '.timetable-legend li')).toEqual([
      '[快] 快速',
      '金 小金井行',
      '宇 宇都宮行',
      '● 当駅始発',
      '◆ 運転日注意',
      '無印 普通',
    ]);
    expect(root.querySelectorAll('.timetable-grid-minute')[1].classList).toContain('timetable-kind-special');
    root.querySelectorAll<HTMLButtonElement>('.timetable-grid-minute')[1].click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['大船', '渋谷', '宇都宮']));
  });

  it('switches day types and looks stations up by name without codes', async () => {
    const { container, panel, requests } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '渋谷', codes: [] } }));
    await vi.waitFor(() => expect(text(panel.panel, '.timetable-direction')).toHaveLength(2));
    expect(requests[0]).toBe('/api/v1/norikae/stations?q=%E6%B8%8B%E8%B0%B7');

    panel.panel.querySelector<HTMLButtonElement>('.timetable-direction').click();
    await vi.waitFor(() => expect(text(panel.panel, '.timetable-time')).toHaveLength(2));
    Array.from(panel.panel.querySelectorAll<HTMLButtonElement>('.timetable-day'))
      .find((button) => button.textContent === '土曜')
      .click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe('/api/v1/norikae/stations/22715/timetables/1051?day=saturday'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.isOpen).toBe(false);
    expect(panel.panel.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows an overnight train’s later stops on the next day’s clock, marked +1', async () => {
    // The fixture train as an overnight one, as Yahoo counts on past 24
    const path = '/api/v1/norikae/stations/22715/timetables/1051/trains/33471';
    const train = API[path] as { stops: Array<Record<string, unknown>> };
    const stops = train.stops;
    train.stops = [
      { code: '23096', name: '大船', arrival: null, departure: '22:30' },
      { ...stops[1], arrival: '23:01', departure: '23:02' },
      { code: '23500', name: '宇都宮', arrival: '33:47', departure: '33:48' },
      { code: '23600', name: '黒磯', arrival: '34:00', departure: null },
    ];
    try {
      const { container, panel } = setup();
      container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '渋谷', codes: ['22715'] } }));
      await vi.waitFor(() => expect(text(panel.panel, '.timetable-direction')).toHaveLength(2));
      panel.panel.querySelector<HTMLButtonElement>('.timetable-direction').click();
      await vi.waitFor(() => expect(text(panel.panel, '.timetable-time')).toHaveLength(2));
      panel.panel.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
      await vi.waitFor(() => expect(text(panel.panel, '.timetable-stop-name')).toHaveLength(4));
      expect(text(panel.panel, '.timetable-stop-time')).toEqual([
        '22:30',
        '23:01 – 23:02',
        '09:47 – 09:48+1',
        '10:00+1',
      ]);
      expect(panel.panel.querySelector<HTMLElement>('.timetable-stop-day').title).toBe('始発駅を出て翌日');
    } finally {
      train.stops = stops;
    }
  });

  it('shows the error of a failed request', async () => {
    const { container, panel } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '架空', codes: ['99999'] } }));
    await vi.waitFor(() =>
      expect(panel.panel.querySelector('.timetable-error').textContent).toBe('時刻表を読み込めませんでした。'),
    );
    // The message names no data source; what went wrong is in its tooltip.
    expect(panel.panel.querySelector<HTMLElement>('.timetable-error-message').title).toBe('not found');
    // An unknown station stays unknown: nothing to retry.
    expect(panel.panel.querySelector('.panel-retry')).toBeNull();
  });

  it('asks again from a Retry button when the API failed', async () => {
    const { container, panel, route } = setup();
    failOnce.set('/api/v1/norikae/stations/22715/timetables', 502);
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '渋谷', codes: ['22715'] } }));
    const root = panel.panel;
    await vi.waitFor(() =>
      expect(root.querySelector('.timetable-error-message').textContent).toBe('時刻表を読み込めませんでした。'),
    );
    root.querySelector<HTMLButtonElement>('.timetable-error .panel-retry').click();
    await vi.waitFor(() => expect(text(root, '.timetable-direction')).toHaveLength(2));

    // A train whose track failed to load gets its own Retry.
    const loads: LoadTaskDetail[] = [];
    container.addEventListener(LOAD_TASK_EVENT, (event) => loads.push((event as CustomEvent<LoadTaskDetail>).detail));
    failOnce.set('/api/v1/norikae/stations/22715/timetables/1051/trains/33471/route', 503);
    root.querySelector<HTMLButtonElement>('.timetable-direction').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toHaveLength(2));
    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() => expect(root.querySelector('.timetable-route-missing .panel-retry')).not.toBeNull());
    expect(root.querySelector('.timetable-route-missing').textContent).toBe('走行経路を読み込めませんでした。再試行');
    // Its stops joined stand in for the track, and stay since it failed
    expect(route.sketch).toHaveBeenCalledWith(
      [
        expect.objectContaining({ name: '大船' }),
        expect.objectContaining({ name: '渋谷' }),
        expect.objectContaining({ name: '宇都宮' }),
      ],
      '渋谷',
      expect.anything(),
    );
    expect(route.show).not.toHaveBeenCalled();
    // and turns dashed, not to pass for the track
    expect(route.unrouted).toHaveBeenCalledTimes(1);
    // The load status said the route was loading, and no longer does
    expect(loads.map(({ id, label }) => [id, label])).toEqual([
      ['train-route', 'route'],
      ['train-route', null],
    ]);
    root.querySelector<HTMLButtonElement>('.timetable-route-missing .panel-retry').click();
    await vi.waitFor(() => expect(route.show).toHaveBeenCalledWith(ROUTE, '渋谷', expect.anything()));
    expect(root.querySelector('.timetable-route-missing')).toBeNull();
    await vi.waitFor(() => expect(loads.at(-1)).toMatchObject({ id: 'train-route', label: null }));
    expect(loads).toHaveLength(4);
  });
});

describe('crLinesBetweenStops', () => {
  // Z157 from 北京丰台 (km 1298) to 山海关 (km 1629): on 京沪线 to 北京 (km 1314), then on 京哈线.
  const lines = [
    {
      name: '京沪线',
      stations: [
        { name: '上海', km: 0 },
        { name: '北京丰台', km: 1298 },
        { name: '北京', km: 1314 },
      ],
    },
    {
      name: '京哈线',
      stations: [
        { name: '北京', km: 1314 },
        { name: '天津', km: 1451 },
        { name: '山海关', km: 1629 },
      ],
    },
  ];

  it('gives the lines between each stop and the next, with the junctions where it changes line', () => {
    const stops = [{ km: 0 }, { km: 1298 }, { km: 1451 }, { km: 1629 }];
    expect(crLinesBetweenStops(stops, lines)).toEqual([
      [{ name: '京沪线', from: null }],
      [
        { name: '京沪线', from: null },
        { name: '京哈线', from: '北京' },
      ],
      [{ name: '京哈线', from: null }],
    ]);
  });

  it('gives no lines when the schedule has none', () => {
    expect(crLinesBetweenStops([{ km: 0 }, { km: 10 }], [])).toEqual([[]]);
  });
});

describe('crLineTabs and crBoundTabs', () => {
  it('list the lines, the busiest first and the trains with none last, and the directions, 下行 first', () => {
    const trains = [
      ...Array(3).fill({ line: '京沪高速', bound: '上行' }),
      ...Array(2).fill({ line: '京沪高速', bound: '下行' }),
      ...Array(4).fill({ line: '京津城际', bound: '下行' }),
      { line: null, bound: '上行' },
      { line: '京九', bound: null },
    ];
    expect(crLineTabs(trains)).toEqual([
      { line: '京沪高速', count: 5 },
      { line: '京津城际', count: 4 },
      { line: '京九', count: 1 },
      { line: '其他', count: 1 },
    ]);
    expect(crBoundTabs(trains)).toEqual([
      { bound: '下行', count: 6 },
      { bound: '上行', count: 4 },
    ]);
  });
});

describe('China Railway timetable', () => {
  it('filters a station’s trains by line and by direction, keeping both across its days', async () => {
    const { container, panel, requests } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '北京西', cr: ['北京西'] } }));
    const root = panel.panel;
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toHaveLength(3));
    // Two rows in the back row, under the date: lines, then directions.
    const [lineRow, boundRow] = Array.from(root.querySelectorAll<HTMLElement>('.timetable-nav .timetable-directions'));
    const tabs = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLButtonElement>('button'));
    const pick = (row: HTMLElement, label: string) =>
      tabs(row)
        .find((tab) => tab.textContent === label)
        .click();
    const pressed = (row: HTMLElement) =>
      tabs(row).find((tab) => tab.getAttribute('aria-pressed') === 'true').textContent;
    expect(lineRow.getAttribute('aria-label')).toBe('线路');
    expect(tabs(lineRow)[0].textContent).toBe('全部');
    expect(
      tabs(lineRow)
        .map((tab) => tab.textContent)
        .slice(1)
        .sort(),
    ).toEqual(['其他', '京哈', '京广高速'].sort());
    expect(tabs(lineRow).at(-1).textContent).toBe('其他');
    expect(boundRow.getAttribute('aria-label')).toBe('方向');
    expect(tabs(boundRow).map((tab) => tab.textContent)).toEqual(['上下行', '下行', '上行']);
    expect([pressed(lineRow), pressed(boundRow)]).toEqual(['全部', '上下行']);

    pick(boundRow, '下行');
    expect(text(root, '.timetable-train-number')).toEqual(['Z157', 'G301']);
    expect(root.querySelector('.timetable-summary').textContent).toBe('2026-11-16 周一 · 2/3趟');
    // Each tab counts what it would show with the other row's pick.
    expect(tabs(lineRow).find((tab) => tab.textContent === '其他').title).toBe('0趟');
    pick(lineRow, '京广高速');
    expect(text(root, '.timetable-train-number')).toEqual(['G301']);
    expect(text(root, '.timetable-hour')).toEqual(['8时']);
    expect(tabs(boundRow).find((tab) => tab.textContent === '上行').title).toBe('0趟');

    // The next day keeps both.
    Array.from(root.querySelectorAll<HTMLButtonElement>('.timetable-day'))
      .find((button) => button.title === '后一天')
      .click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe(`${crPath('stations/北京西/timetable')}?date=2026-11-17`));
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toEqual(['G301']));
    const [nextLineRow, nextBoundRow] = Array.from(
      root.querySelectorAll<HTMLElement>('.timetable-nav .timetable-directions'),
    );
    expect([pressed(nextLineRow), pressed(nextBoundRow)]).toEqual(['京广高速', '下行']);
  });

  it('lists a station’s trains by date and opens a train’s stops', async () => {
    // Today in China is after the train leaves, so its header gives the day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
    const { container, panel, requests, route } = setup();
    // The OSM elements are unknown here, so the panel falls back to the name.
    container.dispatchEvent(
      new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '北京西站', cr: ['N1,W2', '北京西'] } }),
    );
    const root = panel.panel;
    // Each train under the number it runs as here.
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toEqual(['Z157', 'G301', 'K2550']));
    expect(requests.slice(0, 2)).toEqual([crPath('stations/N1,W2/timetable'), crPath('stations/北京西/timetable')]);
    expect(root.querySelector('.timetable-title').textContent).toBe('北京西');
    expect(root.querySelector('.timetable-summary').textContent).toBe('2026-11-16 周一 · 3趟');
    expect(text(root, '.timetable-hour')).toEqual(['6时', '8时', '9时']);
    expect(text(root, '.timetable-time')).toEqual(['06:02', '08:00', '09:11']);
    expect(root.querySelector('.timetable-time-arrival').textContent).toBe('09:11');
    expect(text(root, '.timetable-platform')).toEqual(['10', '7', '']);
    // A train changing lines here says so; the full number and its direction are on hover.
    expect(text(root, '.timetable-line-change')).toEqual(['京沪→京哈']);
    expect(root.querySelector<HTMLElement>('.timetable-departure-button').title).toBe(
      '全程车次 Z156/Z157 · 京哈 下行 · 站台/检票口 10',
    );
    const source = root.querySelector<HTMLAnchorElement>('.timetable-source');
    expect(source.textContent).toBe('lltskb 20261114');
    expect(source.hasAttribute('href')).toBe(false);

    // The date steps stay in view in the row a back button would take.
    expect(root.querySelector<HTMLElement>('.timetable-nav').hidden).toBe(false);
    expect(root.querySelector('.timetable-nav .timetable-date').textContent).toBe('2026-11-16 周一');
    // Date steps replace the view instead of stacking on the back button.
    Array.from(root.querySelectorAll<HTMLButtonElement>('.timetable-day'))
      .find((button) => button.title === '后一天')
      .click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe(`${crPath('stations/北京西/timetable')}?date=2026-11-17`));
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toHaveLength(3));
    expect(root.querySelector('.timetable-back')).toBeNull();

    // Z156/Z157 stops here on the second day of its run, so it left the day before.
    root.querySelector<HTMLButtonElement>('.timetable-departure-button').click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['泰州', '北京西Z156→Z157', '哈尔滨西']));
    // Its number changes at 北京西.
    expect(text(root, '.timetable-number-change')).toEqual(['Z156→Z157']);
    expect(requests).toContain('/api/v1/cr/trains/Z156%2FZ157?date=2026-11-15');
    await vi.waitFor(() => expect(route.show).toHaveBeenCalledWith(ROUTE, '北京西', expect.anything()));
    expect(requests).toContain('/api/v1/cr/trains/Z156%2FZ157/route?date=2026-11-15');
    expect(root.querySelector('.timetable-summary').textContent).toBe(
      'Z156/Z157 · 泰州 → 哈尔滨西 · 2026-11-15 周日始发',
    );
    // 12306 has no trainset for it, so that row goes.
    await vi.waitFor(() => expect(root.querySelector('.timetable-trainset')).toBeNull());
    expect(requests).toContain('/api/v1/cr/trainsets/Z156%2FZ157?date=2026-11-15');
    // The train and its first stop are in the header: the facts say the rest.
    expect(text(root, '.timetable-meta dt')).toEqual(['停站', '开行日期', '担当车底']);
    expect(text(root, '.timetable-meta dd')).toEqual([
      '3站 · 全程 2400 公里',
      '2024-04-02 – 2026-11-24',
      '25T · 上局南京段',
    ]);
    expect(text(root, '.timetable-comment')).toEqual(['25T型，DC600V供电']);
    expect(root.querySelector('.timetable-stop-here').textContent).toContain('北京西');
    expect(text(root, '.timetable-stop-day')).toEqual(['+1', '+1']);
    expect(text(root, '.timetable-cr-stops .timetable-platform')).toEqual(['', '10', '']);
    expect(root.querySelector('.timetable-back').textContent).toBe('← 车次');

    // Lines and distances are folded in by a switch the browser remembers.
    const stopList = root.querySelector('.timetable-cr-stops');
    const toggle = root.querySelector<HTMLInputElement>('.timetable-nav .timetable-toggle input');
    expect(root.querySelector('.timetable-nav .timetable-toggle').textContent).toBe('线路和里程');
    expect(toggle.checked).toBe(false);
    expect(stopList.classList.contains('timetable-show-lines')).toBe(false);
    expect(text(root, '.timetable-stop-km')).toEqual(['0 公里', '1200 公里', '2400 公里']);
    expect(text(root, '.timetable-stop-lines')).toEqual(['京沪线', '京哈线']);
    toggle.click();
    expect(stopList.classList.contains('timetable-show-lines')).toBe(true);
    expect(localStorage.getItem('atlas-realm:timetable-lines')).toBe('true');
    toggle.click();
    expect(localStorage.getItem('atlas-realm:timetable-lines')).toBe('false');

    // A stop opens that station's trains on the day the train is there.
    root.querySelector<HTMLButtonElement>('.timetable-stop-name').click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe(`${crPath('stations/泰州/timetable')}?date=2026-11-15`));
  });

  it('shows the trainset 12306 assigns, and why a track is missing', async () => {
    const { container, panel, route } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '北京西', cr: ['北京西'] } }));
    const root = panel.panel;
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toHaveLength(3));
    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() =>
      expect(root.querySelector('.timetable-trainset').firstChild.textContent).toBe('CR400AF-A-2001 · 16辆编组'),
    );
    // It replaces the rolling stock the timetable plans, which named another model.
    const stockRows = Array.from(root.querySelectorAll('.timetable-meta > dt')).filter(
      (dt) => dt.textContent === '担当车底',
    );
    expect(stockRows.map((dt) => dt.nextElementSibling.className)).toEqual(['timetable-trainset']);
    expect(text(root, '.timetable-comment')).not.toContain('CR400AF型重联');
    expect(text(root, '.timetable-coach-details dt')).toEqual(['餐车', '静音车厢']);
    expect(text(root, '.timetable-coach-details dd')).toEqual(['09车', '✓']);
    expect(text(root, '.timetable-coach-list li')).toEqual(['01车 一等/商务 32/5', '02车 二等 93']);
    // The API has no track for it yet: a note says so above the stops.
    await vi.waitFor(() => expect(root.querySelector('.timetable-route-missing')?.textContent).toBe('暂无运行路径。'));
    expect(root.querySelector('.timetable-route-missing').nextElementSibling.classList).toContain('timetable-stops');
    expect(route.show).not.toHaveBeenCalled();
  });

  it('asks for the trainset again from its row when it failed', async () => {
    const { container, panel } = setup();
    failOnce.set(crPath('trainsets/G301'), 504);
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '北京西', cr: ['北京西'] } }));
    const root = panel.panel;
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toHaveLength(3));
    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() => expect(root.querySelector('.timetable-trainset .panel-retry')).not.toBeNull());
    expect(root.querySelector('.timetable-trainset').textContent).toBe('无法加载车底信息重试');
    root.querySelector<HTMLButtonElement>('.timetable-trainset .panel-retry').click();
    await vi.waitFor(() =>
      expect(root.querySelector('.timetable-trainset').firstChild.textContent).toBe('CR400AF-A-2001 · 16辆编组'),
    );
  });

  it('says so when no way of naming the station is known', async () => {
    const { container, panel } = setup();
    container.dispatchEvent(
      new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '申滨南路', cr: ['N9', '申滨南路'] } }),
    );
    await vi.waitFor(() =>
      expect(panel.panel.querySelector('.timetable-status').textContent).toBe('没有申滨南路站的列车时刻表。'),
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
