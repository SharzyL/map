// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrTrainSchedule, CrTrainset, TrainRoute } from './norikae.js';
import {
  crLinesBetweenStops,
  installTimetable,
  timetableButton,
  TIMETABLE_OPEN_EVENT,
  timetableRequestFor,
} from './timetable.js';

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
  [crPath('cr-trains/Z156/Z157/route').replace('/Z157', '%2FZ157')]: ROUTE,
  '/v1/stations/22715/timetables/1051/trains/33471/route': ROUTE,
  [crPath('cr-stations/北京西/timetable')]: CR_STATION,
  [crPath('cr-stations/泰州/timetable')]: { ...CR_STATION, station: { name: '泰州', telecode: 'UTH' } },
  [crPath('cr-trains/Z156/Z157').replace('/Z157', '%2FZ157')]: CR_TRAIN,
  // 12306 has no trainset for a loco-hauled train.
  [crPath('cr-trainsets/Z156/Z157').replace('/Z157', '%2FZ157')]: { source_url: '', train: 'Z156', trainset: null },
  [crPath('cr-trains/G301')]: G301,
  [crPath('cr-trainsets/G301')]: G301_TRAINSET,
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
  const route = { show: vi.fn(), hover: vi.fn(), clear: vi.fn() };
  const panel = installTimetable(map, route);
  return { container, panel, requests, map, route };
}

const text = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((node) => node.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(root.querySelector('.timetable-title').textContent).toBe('渋谷');

    root.querySelector<HTMLButtonElement>('.timetable-direction').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toEqual(['07:16', '08:02']));
    expect(text(root, '.timetable-hour')).toEqual(['7時', '8時']);
    expect(root.querySelector('.timetable-summary').textContent).toBe('ＪＲ湘南新宿ライン → 新宿・高崎・宇都宮');
    expect(root.querySelector('.timetable-day[aria-pressed="true"]').textContent).toBe('Weekday');
    // The day buttons stay in view in the back button's row.
    expect(root.querySelector('.timetable-nav .timetable-day[aria-pressed="true"]').textContent).toBe('Weekday');
    expect(root.querySelector<HTMLAnchorElement>('.timetable-source').href).toContain('/timetable/22715/1051');

    // The back button stays outside the scrolling list.
    expect(root.querySelector('.timetable-nav .timetable-back').textContent).toBe('← Lines');
    expect(root.querySelector('.timetable-body .timetable-back')).toBeNull();

    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['大船', '渋谷', '宇都宮']));
    expect(root.querySelector('.timetable-stop-here').textContent).toContain('渋谷');
    expect(text(root, '.timetable-stop-time')).toEqual(['07:30', '08:01 – 08:02', '09:50']);
    expect(text(root, '.timetable-comment')).toEqual(['大宮−小山間快速。']);
    // The departure it was opened from knows its number, cars and track here.
    expect(text(root, '.timetable-meta dt')).toEqual(['Train', 'Number', 'Line', 'Cars', 'Track', 'Stops']);
    expect(text(root, '.timetable-meta dd')).toEqual([
      '快速',
      '2824Y',
      'ＪＲ湘南新宿ライン',
      '15 cars · Green Car',
      '3 at 渋谷',
      '3',
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
    expect((rows[0] as HTMLElement).title).toBe('Train 2520Y · Starts here · Green Car · Track 3');

    // The printed layout, by a switch the browser remembers.
    const printed = root.querySelector<HTMLElement>('.timetable-printed');
    const list = root.querySelector<HTMLElement>('.timetable-jp-departures');
    expect(printed.hidden).toBe(true);
    // It stays in view in the back button's row, which the list scrolls below.
    expect(root.querySelector('.timetable-nav .timetable-toggle').textContent).toBe('Printed');
    root.querySelector<HTMLInputElement>('.timetable-nav .timetable-toggle input').click();
    expect(printed.hidden).toBe(false);
    expect(list.hidden).toBe(true);
    expect(localStorage.getItem('atlas-realm:timetable-printed')).toBe('true');
    expect(text(root, '.timetable-grid-hour')).toEqual(['7', '8']);
    expect(text(root, '.timetable-grid-time')).toEqual(['16', '02']);
    expect(text(root, '.timetable-grid-marks')).toEqual(['●金', '宇[快]◆']);
    expect(text(root, '.timetable-legend li')).toEqual([
      '[快] 快速',
      '金 for 小金井',
      '宇 for 宇都宮',
      '● Starts here',
      '◆ Runs on specific days only',
      'No mark 普通',
    ]);
    expect(root.querySelectorAll('.timetable-grid-minute')[1].classList).toContain('timetable-kind-special');
    root.querySelectorAll<HTMLButtonElement>('.timetable-grid-minute')[1].click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['大船', '渋谷', '宇都宮']));
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

    // The date steps stay in view in the row a back button would take.
    expect(root.querySelector<HTMLElement>('.timetable-nav').hidden).toBe(false);
    expect(root.querySelector('.timetable-nav .timetable-date').textContent).toBe('2026-11-16 Mon');
    // Date steps replace the view instead of stacking on the back button.
    Array.from(root.querySelectorAll<HTMLButtonElement>('.timetable-day'))
      .find((button) => button.title === 'Next day')
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
    // 12306 has no trainset for it, so that row goes.
    await vi.waitFor(() => expect(root.querySelector('.timetable-trainset')).toBeNull());
    expect(requests).toContain('/v1/cr-trainsets/Z156%2FZ157?date=2026-11-15');
    expect(text(root, '.timetable-meta dt')).toEqual([
      'Train',
      'Departs',
      'In service',
      'Distance',
      'Stops',
      'Rolling stock',
    ]);
    expect(text(root, '.timetable-meta dd')).toEqual([
      'Z156/Z157',
      '2026-11-15 Sun from 泰州',
      '2024-04-02 – 2026-11-24',
      '2400 km',
      '3',
      '25T · 上局南京段',
    ]);
    expect(text(root, '.timetable-comment')).toEqual(['25T型，DC600V供电']);
    expect(root.querySelector('.timetable-stop-here').textContent).toContain('北京西');
    expect(text(root, '.timetable-stop-day')).toEqual(['+1', '+1']);
    expect(text(root, '.timetable-cr-stops .timetable-platform')).toEqual(['', '10', '']);
    expect(root.querySelector('.timetable-back').textContent).toBe('← Trains');

    // Lines and distances are folded in by a switch the browser remembers.
    const stopList = root.querySelector('.timetable-cr-stops');
    const toggle = root.querySelector<HTMLInputElement>('.timetable-nav .timetable-toggle input');
    expect(root.querySelector('.timetable-nav .timetable-toggle').textContent).toBe('Lines and distances');
    expect(toggle.checked).toBe(false);
    expect(stopList.classList.contains('timetable-show-lines')).toBe(false);
    expect(text(root, '.timetable-stop-km')).toEqual(['0 km', '1200 km', '2400 km']);
    expect(text(root, '.timetable-stop-lines')).toEqual(['京沪线', '京哈线']);
    toggle.click();
    expect(stopList.classList.contains('timetable-show-lines')).toBe(true);
    expect(localStorage.getItem('atlas-realm:timetable-lines')).toBe('true');
    toggle.click();
    expect(localStorage.getItem('atlas-realm:timetable-lines')).toBe('false');

    // A stop opens that station's trains on the day the train is there.
    root.querySelector<HTMLButtonElement>('.timetable-stop-name').click();
    await vi.waitFor(() => expect(requests.at(-1)).toBe(`${crPath('cr-stations/泰州/timetable')}?date=2026-11-15`));
  });

  it('shows the trainset 12306 assigns, and why a track is missing', async () => {
    const { container, panel, route } = setup();
    container.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { detail: { name: '北京西', cr: ['北京西'] } }));
    const root = panel.panel;
    await vi.waitFor(() => expect(text(root, '.timetable-train-number')).toHaveLength(3));
    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() =>
      expect(root.querySelector('.timetable-trainset').firstChild.textContent).toBe(
        'CR400AF-A-2001 · 复兴号 · 16 cars · 1193 seats · 350 km/h',
      ),
    );
    const rows = Object.fromEntries(
      Array.from(root.querySelectorAll('.timetable-meta > dt')).map((dt) => [dt.textContent, dt.nextElementSibling]),
    );
    // It replaces the rolling stock the timetable plans, which named another model.
    expect(rows['Rolling stock']).toBeUndefined();
    expect(text(root, '.timetable-comment')).not.toContain('CR400AF型重联');
    expect(text(root, '.timetable-coach-details dt')).toEqual(['餐车', '静音车厢']);
    expect(text(root, '.timetable-coach-details dd')).toEqual(['09车', '✓']);
    expect(text(root, '.timetable-coach-list li')).toEqual(['01车 一等/商务 32/5', '02车 二等 93']);
    // The API has no track for it yet: a note says so above the stops.
    await vi.waitFor(() =>
      expect(root.querySelector('.timetable-route-missing')?.textContent).toBe('Its track is not available yet.'),
    );
    expect(root.querySelector('.timetable-route-missing').nextElementSibling.classList).toContain('timetable-stops');
    expect(route.show).not.toHaveBeenCalled();
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
