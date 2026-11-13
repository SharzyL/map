// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
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

function createMap() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const state: Record<string, unknown> = {};
  const overview = { setData: vi.fn() };
  const map = {
    getContainer: () => container,
    isStyleLoaded: () => true,
    loaded: () => true,
    getStyle: () => ({ layers: [] as unknown[] }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    setGlobalStateProperty: vi.fn((name: string, value: unknown) => (state[name] = value)),
    getSource: () => overview,
    getBounds: () => ({ getWest: () => 121.2, getSouth: () => 31.0, getEast: () => 121.6, getNorth: () => 31.4 }),
  };
  return { map, container, state, overview };
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

  it('names a railway line with its number, and an official Japanese line by its source', () => {
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

    selectRoute(container, { id: 'jp-0123456789', color: null, label: '山陰本線', kind: 'line', name: '山陰本線' });
    expect(panel().querySelector('.route-info-fields a')).toBeNull();
    expect(panel().querySelector('.route-info-fields').textContent).toContain('国土数値情報');
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
  it('starts from the tile where the route was picked', async () => {
    const { map, container } = createMap();
    map.getStyle = () =>
      ({
        layers: [{ id: 'route_highlight_line_0', source: 'openrailwaymap', minzoom: 7 }],
        sources: { openrailwaymap: { tiles: ['https://tiles.test/{z}/{x}/{y}.mvt'] } },
      }) as never;
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url);
        return new Response(null, { status: 404 });
      }),
    );
    try {
      installRouteHighlight(map as never);
      // Picked near Zhengzhou while the view (createMap) is over Shanghai.
      selectRoute(container, { ...ROUTE, at: [113.6, 33.5] });
      const [[x, y]] = tilesInBounds(113.6, 33.5, 113.6, 33.5, 1);
      await vi.waitFor(() => expect(fetched[0]).toBe(`https://tiles.test/7/${x}/${y}.mvt`));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
