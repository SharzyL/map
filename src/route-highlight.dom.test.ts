// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import {
  installRouteHighlight,
  ROUTE_HIGHLIGHT_COLOR_STATE,
  ROUTE_HIGHLIGHT_ID_STATE,
  ROUTE_SELECT_EVENT,
  type RouteSelection,
} from './route-highlight.js';

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
  it('highlights the selected route and names it in a clearable chip', () => {
    const { map, container, state } = createMap();
    installRouteHighlight(map as never);
    const item = routeItem(container, ROUTE.id);

    selectRoute(item, ROUTE);
    expect(state).toEqual({ [ROUTE_HIGHLIGHT_ID_STATE]: ROUTE.id, [ROUTE_HIGHLIGHT_COLOR_STATE]: ROUTE.color });
    const chip = container.querySelector<HTMLElement>('.route-highlight-chip');
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toContain(ROUTE.label);
    expect(item.getAttribute('aria-pressed')).toBe('true');

    container.querySelector<HTMLButtonElement>('.route-highlight-clear').click();
    expect(state[ROUTE_HIGHLIGHT_ID_STATE]).toBe('');
    expect(chip.hidden).toBe(true);
    expect(item.getAttribute('aria-pressed')).toBe('false');
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
    expect(container.querySelector('.route-highlight-chip').textContent).toContain('Route 42');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(state[ROUTE_HIGHLIGHT_ID_STATE]).toBe('');
  });
});
