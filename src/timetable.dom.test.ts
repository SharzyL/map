// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTimetable, timetableButton, TIMETABLE_OPEN_EVENT, timetableRequestFor } from './timetable.js';

const API = {
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
      { code: '22715', name: '渋谷', arrival: '08:01', departure: '08:02' },
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
      const body = API[pathname as keyof typeof API];
      return new Response(JSON.stringify(body ?? { error: { message: 'not found' } }), { status: body ? 200 : 404 });
    }),
  );
  const panel = installTimetable({ getContainer: () => container });
  return { container, panel, requests };
}

const text = (root: HTMLElement, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((node) => node.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('timetable panel', () => {
  it('goes from lines to departures to a train’s stops and back', async () => {
    const { container, panel } = setup();
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

    root.querySelectorAll<HTMLButtonElement>('.timetable-departure-button')[1].click();
    await vi.waitFor(() => expect(text(root, '.timetable-stop-name')).toEqual(['大船', '渋谷', '宇都宮']));
    expect(root.querySelector('.timetable-stop-here').textContent).toContain('渋谷');
    expect(text(root, '.timetable-stop-time')).toEqual(['07:30', '08:01 – 08:02', '09:50']);
    expect(text(root, '.timetable-comment')).toEqual(['大宮−小山間快速。']);

    root.querySelector<HTMLButtonElement>('.timetable-back').click();
    await vi.waitFor(() => expect(text(root, '.timetable-time')).toEqual(['07:16', '08:02']));
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

describe('Timetable button', () => {
  const stationAt = (lng: number, lat: number, properties: Record<string, unknown>) => ({
    sourceLayer: 'standard_railway_text_stations',
    properties: { feature: 'station', ...properties },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  });

  it('appears on Japanese stations and on any station with Yahoo codes', () => {
    expect(timetableRequestFor(stationAt(139.7, 35.66, { name: '渋谷' }))).toEqual({ name: '渋谷', codes: [] });
    expect(timetableRequestFor(stationAt(139.7, 35.66, { name: '渋谷', yahoo_codes: '22715;29342' }))).toEqual({
      name: '渋谷',
      codes: ['22715', '29342'],
    });
    expect(timetableRequestFor(stationAt(126.97, 37.55, { name: '서울역' }))).toBeNull();
    expect(timetableRequestFor(stationAt(116.32, 39.89, { name: '北京西' }))).toBeNull();
    expect(
      timetableRequestFor({ ...stationAt(139.7, 35.66, { name: '渋谷' }), sourceLayer: 'railway_line_high' }),
    ).toBeNull();
  });

  it('opens the timetable from the info box', () => {
    const content = document.createElement('div');
    content.innerHTML =
      '<h5 class="orm-popup-title">Station</h5><h6 class="orm-popup-osm"></h6><div class="orm-popup-section"></div>';
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
    expect(content.querySelector('.orm-popup-osm').nextElementSibling.className).toBe('orm-popup-actions');
    content.querySelector<HTMLButtonElement>('.orm-popup-action').click();
    expect(opened).toHaveBeenCalledWith({ name: '渋谷', codes: ['22715'] });
  });
});
