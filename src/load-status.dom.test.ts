// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLoadStatus, loadGroups, loadStatusText, type LoadStatusMap } from './load-status.js';

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

function createMap() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const listeners = new Map<string, Listener[]>();
  const pending = new Set<string>();
  const reloaded: string[] = [];
  const sources: Record<string, object> = {
    openmaptiles: {
      url: 'https://tiles.example/planet',
      setUrl: (url: string) => reloaded.push(`openmaptiles ${url}`),
    },
    satellite: {},
    openrailwaymap: { tiles: ['/tiles/{z}/{x}/{y}'], setTiles: () => reloaded.push('openrailwaymap') },
    openhistoricalmap: {},
  };
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
  };
  return { map, container, pending, reloaded };
}

const chip = (container: HTMLElement) => container.querySelector<HTMLElement>('.load-status');
const shownText = (container: HTMLElement) =>
  chip(container).hidden ? null : chip(container).querySelector('.load-status-text').textContent;
const tileEvent = (sourceId: string, key: string, error?: Error) => ({ sourceId, tile: { tileID: { key } }, error });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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
  const none = { railways: false, map: false };
  it('names what is loading, and failures before loading', () => {
    expect(loadStatusText({ loading: none, failed: none })).toBeNull();
    expect(loadStatusText({ loading: { railways: true, map: false }, failed: none })?.text).toBe('Loading railways…');
    expect(loadStatusText({ loading: { railways: false, map: true }, failed: none })?.text).toBe('Loading map…');
    expect(loadStatusText({ loading: { railways: true, map: true }, failed: none })?.text).toBe(
      'Loading map and railways…',
    );
    expect(loadStatusText({ loading: { railways: true, map: true }, failed: { railways: true, map: false } })).toEqual({
      text: 'Some railway tiles failed to load',
      failed: true,
    });
  });
});

describe('installLoadStatus', () => {
  it('shows loading once it has lasted a moment, and hides when the tiles are in', () => {
    const { map, container, pending } = createMap();
    installLoadStatus(map, SOURCES, RAILWAYS, ['contourSource']);
    pending.add('openrailwaymap');
    map.fire('sourcedataloading');
    vi.advanceTimersByTime(100);
    expect(shownText(container)).toBeNull();

    vi.advanceTimersByTime(400);
    expect(shownText(container)).toBe('Loading railways…');

    pending.delete('openrailwaymap');
    map.fire('idle');
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBeNull();
  });

  it('never shows for loads shorter than the delay', () => {
    const { map, container, pending } = createMap();
    installLoadStatus(map, SOURCES, RAILWAYS, ['contourSource']);
    pending.add('openmaptiles');
    map.fire('dataloading');
    vi.advanceTimersByTime(200);
    pending.delete('openmaptiles');
    map.fire('data');
    vi.advanceTimersByTime(1000);
    expect(shownText(container)).toBeNull();
  });

  it('reports failed tiles until they load or Retry reloads their source', () => {
    const { map, container, reloaded } = createMap();
    installLoadStatus(map, SOURCES, RAILWAYS, ['contourSource']);
    map.fire('error', tileEvent('openrailwaymap', 'a'));
    map.fire('error', tileEvent('openrailwaymap', 'b'));
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBe('Some railway tiles failed to load');
    expect(chip(container).querySelector<HTMLElement>('.load-status-retry').hidden).toBe(false);

    map.fire('sourcedata', tileEvent('openrailwaymap', 'a'));
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBe('Some railway tiles failed to load');

    chip(container).querySelector<HTMLButtonElement>('.load-status-retry').click();
    vi.advanceTimersByTime(20);
    expect(reloaded).toEqual(['openrailwaymap']);
    expect(shownText(container)).toBeNull();
  });

  it('ignores cancelled requests and errors of local sources', () => {
    const { map, container } = createMap();
    installLoadStatus(map, SOURCES, RAILWAYS, ['contourSource']);
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    map.fire('error', tileEvent('openrailwaymap', 'a', aborted));
    map.fire('error', tileEvent('route_highlight_overview', 'b'));
    vi.advanceTimersByTime(20);
    expect(shownText(container)).toBeNull();
  });
});
