// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLoadStatus, loadGroups, loadStatusText, type GroupStatus, type LoadStatusMap } from './load-status.js';

const SOURCES = {
  openmaptiles: { type: 'vector' },
  satellite: { type: 'raster' },
  openrailwaymap: { type: 'vector' },
  openhistoricalmap: { type: 'vector' },
  route_highlight_overview: { type: 'geojson' },
  hillshadeSource: { type: 'raster-dem' },
  contourSource: { type: 'vector' },
};
const RAILWAYS = ['openrailwaymap', 'openhistoricalmap'];

type Listener = (event: object) => void;

// A map whose sources are loaded unless listed in `pending`; with
// `tileManagers`, its sources' tiles in view and their states.
function createMap({ tileManagers = false } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const listeners = new Map<string, Listener[]>();
  const pending = new Set<string>();
  const reloaded: string[] = [];
  const tileStates: Record<string, Record<string, string>> = {
    openmaptiles: {},
    satellite: {},
    openrailwaymap: {},
    openhistoricalmap: {},
  };
  const sources: Record<string, object> = {
    openmaptiles: { url: 'https://tiles.example/planet', setUrl: () => reloaded.push('openmaptiles') },
    satellite: {},
    openrailwaymap: { tiles: ['/tiles/{z}/{x}/{y}'], setTiles: () => reloaded.push('openrailwaymap') },
    openhistoricalmap: {},
  };
  const managers = Object.fromEntries(
    Object.keys(tileStates).map((id) => [
      id,
      { getIds: () => Object.keys(tileStates[id]), getTileByID: (tile: string) => ({ state: tileStates[id][tile] }) },
    ]),
  );
  const map: LoadStatusMap & { fire(type: string, event?: object): void } = {
    getContainer: () => container,
    getSource: (id) => sources[id],
    isSourceLoaded: (id) => !pending.has(id),
    on(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as Listener]);
    },
    fire(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    style: tileManagers ? { tileManagers: managers } : {},
  };
  const install = () => installLoadStatus(map, SOURCES, RAILWAYS, ['contourSource']);
  return { map, container, pending, reloaded, tileStates, install };
}

const chip = (container: HTMLElement) => container.querySelector<HTMLElement>('.load-status');
const shownText = (container: HTMLElement) =>
  chip(container).hidden ? null : chip(container).querySelector('.load-status-text').textContent;
const tileEvent = (sourceId: string, key: string, error?: Error) => ({ sourceId, tile: { tileID: { key } }, error });
const retry = (container: HTMLElement) => chip(container).querySelector<HTMLButtonElement>('.load-status-retry');

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  consoleError.mockRestore();
  document.body.replaceChildren();
});

describe('loadGroups', () => {
  it('splits tiled sources into railways and the base map, leaving local data and elevation out', () => {
    expect(loadGroups(SOURCES, RAILWAYS, ['contourSource'])).toEqual({
      railways: ['openrailwaymap', 'openhistoricalmap'],
      map: ['openmaptiles', 'satellite'],
    });
  });
});

describe('loadStatusText', () => {
  const idle: GroupStatus = { loading: false, pending: 0, failed: 0 };
  const loading = (pending: number | null): GroupStatus => ({ loading: true, pending, failed: 0 });
  it('names what is loading with the tiles left, and failures before loading', () => {
    expect(loadStatusText({ railways: idle, map: idle })).toBeNull();
    expect(loadStatusText({ railways: loading(12), map: idle })?.text).toBe('Loading railways… 12 tiles left');
    expect(loadStatusText({ railways: idle, map: loading(1) })?.text).toBe('Loading map… 1 tile left');
    expect(loadStatusText({ railways: loading(3), map: loading(4) })?.text).toBe(
      'Loading map and railways… 7 tiles left',
    );
    expect(loadStatusText({ railways: loading(null), map: idle })?.text).toBe('Loading railways…');
    expect(loadStatusText({ railways: { loading: true, pending: 2, failed: 3 }, map: loading(5) })).toEqual({
      text: '3 railway tiles failed to load',
      failed: true,
    });
    expect(loadStatusText({ railways: { ...idle, failed: 1 }, map: { ...idle, failed: 1 } })?.text).toBe(
      '2 map and railway tiles failed to load',
    );
  });
});

describe('installLoadStatus with tile managers', () => {
  it('counts the tiles left once loading has lasted a moment, and hides when they are in', () => {
    const { map, container, tileStates, install } = createMap({ tileManagers: true });
    install();
    tileStates.openrailwaymap = { a: 'loading', b: 'loading', c: 'loaded' };
    map.fire('sourcedataloading');
    vi.advanceTimersByTime(100);
    expect(shownText(container)).toBeNull();

    vi.advanceTimersByTime(400);
    expect(shownText(container)).toBe('Loading railways… 2 tiles left');

    tileStates.openrailwaymap = { a: 'loaded', b: 'reloading', c: 'loaded' };
    map.fire('data');
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBe('Loading railways… 1 tile left');

    tileStates.openrailwaymap = { a: 'loaded', b: 'loaded', c: 'loaded' };
    map.fire('idle');
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports failed tiles in view, forgets them once out of view, and Retry reloads their source', () => {
    const { map, container, tileStates, reloaded, install } = createMap({ tileManagers: true });
    install();
    tileStates.openrailwaymap = { a: 'errored', b: 'loaded' };
    map.fire('error', tileEvent('openrailwaymap', 'a'));
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBe('1 railway tile failed to load');
    expect(retry(container).hidden).toBe(false);

    retry(container).click();
    expect(reloaded).toEqual(['openrailwaymap']);

    tileStates.openrailwaymap = { b: 'loaded' };
    map.fire('movestart');
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBeNull();
  });
});

describe('installLoadStatus without tile managers', () => {
  it('logs one error and falls back to whether sources are loaded', () => {
    const { map, container, pending, install } = createMap();
    install();
    pending.add('openrailwaymap');
    map.fire('sourcedataloading');
    vi.advanceTimersByTime(500);
    expect(shownText(container)).toBe('Loading railways…');
    map.fire('data');
    vi.advanceTimersByTime(20);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('map.style.tileManagers');

    pending.delete('openrailwaymap');
    map.fire('idle');
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBeNull();
  });

  it('never shows for loads shorter than the delay', () => {
    const { map, container, pending, install } = createMap();
    install();
    pending.add('openmaptiles');
    map.fire('dataloading');
    vi.advanceTimersByTime(200);
    pending.delete('openmaptiles');
    map.fire('data');
    vi.advanceTimersByTime(1000);
    expect(shownText(container)).toBeNull();
  });

  it('remembers failed tiles from error events until they load or Retry', () => {
    const { map, container, reloaded, install } = createMap();
    install();
    map.fire('error', tileEvent('openrailwaymap', 'a'));
    map.fire('error', tileEvent('openrailwaymap', 'b'));
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBe('2 railway tiles failed to load');

    map.fire('sourcedata', tileEvent('openrailwaymap', 'a'));
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBe('1 railway tile failed to load');

    retry(container).click();
    vi.advanceTimersByTime(20);
    expect(reloaded).toEqual(['openrailwaymap']);
    expect(shownText(container)).toBeNull();
  });

  it('ignores cancelled requests and errors of other sources', () => {
    const { map, container, install } = createMap();
    install();
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    map.fire('error', tileEvent('openrailwaymap', 'a', aborted));
    map.fire('error', tileEvent('route_highlight_overview', 'b'));
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBeNull();
  });
});
