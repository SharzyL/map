import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMapView, MAP_VIEW_STORAGE_KEY, normalizeMapView, rememberMapView } from './map-view.js';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the remembered map view', () => {
  it('is saved once the map settles, and read back', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const listeners: Array<() => void> = [];
    const map = {
      getCenter: () => ({ lng: 116.378512345, lat: 39.865123456 }),
      getZoom: () => 13.456,
      getBearing: () => 12.34,
      getPitch: () => 40,
      on: (_type: 'moveend', listener: () => void) => {
        listeners.push(listener);
      },
    };
    rememberMapView(map, storage);
    listeners[0]();
    listeners[0]();
    expect(storage.items.size).toBe(0);
    vi.advanceTimersByTime(500);
    expect(JSON.parse(storage.items.get(MAP_VIEW_STORAGE_KEY))).toEqual({
      center: [116.37851, 39.86512],
      zoom: 13.46,
      bearing: 12.3,
      pitch: 40,
    });
    expect(loadMapView(storage)).toEqual({ center: [116.37851, 39.86512], zoom: 13.46, bearing: 12.3, pitch: 40 });
  });

  it('is nothing when missing or not a view', () => {
    expect(loadMapView(memoryStorage())).toBeNull();
    expect(normalizeMapView({ center: [200, 10], zoom: 5 })).toBeNull();
    expect(normalizeMapView({ center: ['a', 10], zoom: 5 })).toBeNull();
    expect(normalizeMapView({ center: [139.7, 35.7] })).toBeNull();
    expect(normalizeMapView({ center: [139.7, 35.7], zoom: 9 })).toEqual({
      center: [139.7, 35.7],
      zoom: 9,
      bearing: 0,
      pitch: 0,
    });
  });
});
