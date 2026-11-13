// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installRouteHighlight,
  ROUTE_HIGHLIGHT_COLOR_STATE,
  ROUTE_HIGHLIGHT_ID_STATE,
  ROUTE_SELECT_EVENT,
  type RouteSelection,
} from './route-highlight.js';
import { tilesInBounds } from './route-trace.js';
import { UI_PANEL_OPEN_EVENT } from './ui-panels.js';

const ROUTE: RouteSelection = { id: '900821540', color: '#c3a17f', label: '15号线：顾村公园 -> 紫竹高新区' };

// The railway relations API, answering for the ids in `relations` and 404 otherwise.
let relations: Record<string, unknown> = {};
let fetched: string[] = [];
beforeEach(() => {
  relations = {};
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url);
      const id = decodeURIComponent(url.match(/\/relations\/([^/?]+)$/)?.[1] ?? '');
      const body = relations[id];
      return new Response(JSON.stringify(body ?? { error: { code: 'not_found', message: 'not found' } }), {
        status: body ? 200 : 404,
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const SHANGHAI_15 = {
  data_version: '2026-11-12T18:00:00Z',
  relation: {
    id: 900821540,
    kind: 'route',
    type: 'subway',
    name: '上海地铁15号线：顾村公园 → 紫竹高新区',
    ref: '15',
    from: '顾村公园',
    to: '紫竹高新区',
    operator: '上海地铁',
    network: '上海地铁',
    colour: '#c3a17f',
    master: 900821541,
    wikidata: 'Q6129137',
    wikipedia: 'zh:上海轨道交通15号线',
  },
  bbox: [121.38, 31.05, 121.47, 31.35],
  length_m: 42300,
  overview: ['_p~iF~ps|U_ulLnnqC'],
  ways: [1, 2],
  stops: [
    { name: '顾村公园', position: [121.38, 31.35], elements: ['N1'], km: null },
    { name: '紫竹高新区', position: [121.47, 31.05], elements: ['N2'], km: 42.3 },
  ],
};

function createMap() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const state: Record<string, unknown> = {};
  const overview = { setData: vi.fn() };
  const hover = { setData: vi.fn() };
  const map = {
    getContainer: () => container,
    isStyleLoaded: () => true,
    loaded: () => true,
    getStyle: () => ({ layers: [] as unknown[] }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    setGlobalStateProperty: vi.fn((name: string, value: unknown) => (state[name] = value)),
    getSource: (id: string) => (id === 'station_hover' ? hover : overview),
    getBounds: () => ({ getWest: () => 121.2, getSouth: () => 31.0, getEast: () => 121.6, getNorth: () => 31.4 }),
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    getZoom: () => 10,
  };
  return { map, container, state, overview, hover };
}

function routeItem(container: HTMLElement, id: string) {
  const item = document.createElement('li');
  item.dataset.routeId = id;
  container.appendChild(item);
  return item;
}

function selectRoute(target: HTMLElement, route: RouteSelection) {
  target.dispatchEvent(new CustomEvent(ROUTE_SELECT_EVENT, { bubbles: true, detail: route }));
}

describe('installRouteHighlight', () => {
  it('highlights the selected route and describes it in a panel that clears it', () => {
    const { map, container, state } = createMap();
    installRouteHighlight(map as never);
    const item = routeItem(container, ROUTE.id);

    selectRoute(item, ROUTE);
    expect(state).toEqual({ [ROUTE_HIGHLIGHT_ID_STATE]: ROUTE.id, [ROUTE_HIGHLIGHT_COLOR_STATE]: ROUTE.color });
    const panel = container.querySelector<HTMLElement>('.route-info-panel');
    expect(panel.classList.contains('route-info-panel-visible')).toBe(true);
    expect(panel.querySelector('.route-info-title').textContent).toBe(ROUTE.label);
    expect(panel.querySelector('.route-info-summary').textContent).toBe('Transit route');
    const links = [...panel.querySelectorAll<HTMLAnchorElement>('.route-info-fields a')].map((link) => link.href);
    expect(links).toEqual([
      `https://www.openstreetmap.org/relation/${ROUTE.id}`,
      `https://www.openstreetmap.org/edit?relation=${ROUTE.id}`,
    ]);
    expect(item.getAttribute('aria-pressed')).toBe('true');

    panel.querySelector<HTMLButtonElement>('.route-info-close').click();
    expect(state[ROUTE_HIGHLIGHT_ID_STATE]).toBe('');
    expect(panel.classList.contains('route-info-panel-visible')).toBe(false);
    expect(item.getAttribute('aria-pressed')).toBe('false');
  });

  it('fills the panel from the relations API: details, outline, extent and stations', async () => {
    relations['900821540'] = SHANGHAI_15;
    const { map, container, overview, hover } = createMap();
    installRouteHighlight(map as never);
    selectRoute(container, ROUTE);
    const panel = container.querySelector<HTMLElement>('.route-info-panel');
    await vi.waitFor(() => expect(panel.querySelectorAll('.route-info-station')).toHaveLength(2));
    expect(panel.querySelector('.route-info-title').textContent).toBe('上海地铁15号线：顾村公园 → 紫竹高新区');
    expect(panel.querySelector('.route-info-summary').textContent).toBe('Subway route · 15');
    const rows = Object.fromEntries(
      [...panel.querySelectorAll('.route-info-fields dt')].map((dt) => [
        dt.textContent,
        dt.nextElementSibling.textContent,
      ]),
    );
    expect(rows).toMatchObject({
      'From – to': '顾村公园 → 紫竹高新区',
      Operator: '上海地铁',
      Length: '42.3 km',
      'Route master': 'relation 900821541',
      Links: 'Wikidata · Wikipedia',
    });
    expect(panel.querySelector('.route-info-km').textContent).toBe('42.3 km');
    // The API's outline replaces the trace through z7 tiles, with the stops for their labels.
    const { features } = overview.setData.mock.lastCall[0];
    expect(features.map(({ geometry }: GeoJSON.Feature) => geometry.type)).toEqual(['LineString', 'Point', 'Point']);
    expect(features[1].properties).toEqual({ kind: 'stop', name: '顾村公园', here: false, end: true });
    expect(fetched.some((url) => url.includes('.mvt'))).toBe(false);

    panel.querySelector<HTMLButtonElement>('.route-info-zoom').click();
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [121.38, 31.05],
        [121.47, 31.35],
      ],
      expect.anything(),
    );
    panel.querySelector<HTMLButtonElement>('.route-info-station').click();
    expect(map.flyTo).toHaveBeenCalledWith({ center: [121.38, 31.35], zoom: 14 });

    // Pointing at a station marks it on the map.
    const station = panel.querySelector('.route-info-stations li');
    station.dispatchEvent(new Event('pointerenter'));
    expect(hover.setData.mock.lastCall[0].features).toEqual([
      expect.objectContaining({
        properties: { name: '顾村公园' },
        geometry: { type: 'Point', coordinates: [121.38, 31.35] },
      }),
    ]);
    station.dispatchEvent(new Event('pointerleave'));
    expect(hover.setData.mock.lastCall[0].features).toEqual([]);
  });

  it('names a railway line with its number, and an official Japanese line by its source', async () => {
    relations['jp-15e84d7cdd'] = {
      ...SHANGHAI_15,
      relation: {
        ...SHANGHAI_15.relation,
        id: 'jp-15e84d7cdd',
        kind: 'line',
        type: 'railway',
        name: '山陰本線',
        ref: null,
        master: null,
        wikidata: null,
        wikipedia: null,
        aliases: ['山陰線'],
        attribution: {
          text: '「国土数値情報（鉄道データ）」（国土交通省）を加工して作成',
          url: 'https://nlftp.mlit.go.jp/',
        },
      },
    };
    const { map, container } = createMap();
    installRouteHighlight(map as never);
    const panel = () => container.querySelector<HTMLElement>('.route-info-panel');

    selectRoute(container, {
      id: '3216458',
      color: null,
      label: '京广高速铁路 · 京广高铁',
      kind: 'line',
      name: '京广高速铁路',
      ref: '京广高铁',
    });
    expect(panel().querySelector('.route-info-title').textContent).toBe('京广高速铁路');
    expect(panel().querySelector('.route-info-summary').textContent).toBe('Railway line · 京广高铁');

    selectRoute(container, { id: 'jp-15e84d7cdd', color: null, label: '山陰本線', kind: 'line', name: '山陰本線' });
    // No OSM link for a line that is not an OSM relation, and its credit once the API answers.
    expect(panel().querySelector('.route-info-fields a')).toBeNull();
    await vi.waitFor(() => expect(panel().querySelector('.route-info-fields').textContent).toContain('国土数値情報'));
    expect(panel().querySelector<HTMLAnchorElement>('.route-info-fields a').href).toBe('https://nlftp.mlit.go.jp/');
    expect(panel().querySelector('.route-info-fields').textContent).toContain('山陰線');
  });

  it('ends the highlight when another panel opens beside the map', () => {
    const { map, container, state } = createMap();
    installRouteHighlight(map as never);
    selectRoute(container, ROUTE);
    container.dispatchEvent(new CustomEvent(UI_PANEL_OPEN_EVENT, { detail: { id: 'timetable' } }));
    expect(state[ROUTE_HIGHLIGHT_ID_STATE]).toBe('');
  });

  it('turns the highlight off when the same route is selected again', () => {
    const { map, container, state } = createMap();
    installRouteHighlight(map as never);
    const item = routeItem(container, ROUTE.id);

    selectRoute(item, ROUTE);
    selectRoute(item, ROUTE);
    expect(state[ROUTE_HIGHLIGHT_ID_STATE]).toBe('');
  });

  it('switches to another route and clears on Escape', () => {
    const { map, container, state } = createMap();
    installRouteHighlight(map as never);
    const item = routeItem(container, ROUTE.id);

    selectRoute(item, ROUTE);
    selectRoute(item, { id: '42', color: null, label: null });
    expect(state).toEqual({ [ROUTE_HIGHLIGHT_ID_STATE]: '42', [ROUTE_HIGHLIGHT_COLOR_STATE]: '' });
    expect(container.querySelector('.route-info-title').textContent).toBe('Route 42');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(state[ROUTE_HIGHLIGHT_ID_STATE]).toBe('');
  });
});

describe('zoomed-out trace', () => {
  it('traces the route through z7 tiles, from where it was picked, when the API does not have it', async () => {
    const { map, container } = createMap();
    map.getStyle = () =>
      ({
        layers: [{ id: 'route_highlight_line_0', source: 'openrailwaymap', minzoom: 7 }],
        sources: { openrailwaymap: { tiles: ['https://tiles.test/{z}/{x}/{y}.mvt'] } },
      }) as never;
    installRouteHighlight(map as never);
    // Picked near Zhengzhou while the view (createMap) is over Shanghai.
    // (An id no other test asks the API for: the client caches answers.)
    selectRoute(container, { ...ROUTE, id: '900821599', at: [113.6, 33.5] });
    const [[x, y]] = tilesInBounds(113.6, 33.5, 113.6, 33.5, 1);
    await vi.waitFor(() =>
      expect(fetched.find((url) => url.endsWith('.mvt'))).toBe(`https://tiles.test/7/${x}/${y}.mvt`),
    );
    expect(fetched[0]).toContain('/v1/relations/900821599');
    expect(container.querySelector('.route-info-status').textContent).toBe('No further details for this one.');
  });
});
