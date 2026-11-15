// The view the map was last left at, kept in localStorage so a URL without a
// view in its hash (a bookmark of the bare address) reopens there. A hash
// with a view (#zoom/lat/lng, which MapLibre keeps in sync) wins: shared and
// bookmarked places open where they point.
import { readStoredSettings, writeStoredSettings } from './stored-settings.js';

export const MAP_VIEW_STORAGE_KEY = 'atlas-realm:map-view';
// Moves end in bursts while flying or dragging; save once they settle.
const SAVE_DELAY_MS = 500;

export type MapView = { center: [number, number]; zoom: number; bearing: number; pitch: number };
type ViewMap = {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  on(type: 'moveend', listener: () => void): void;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function normalizeMapView(value: unknown): MapView | null {
  if (!value || typeof value !== 'object') return null;
  const { center, zoom, bearing, pitch } = value as Record<string, unknown>;
  if (!Array.isArray(center) || center.length !== 2 || !center.every(finite) || !finite(zoom)) return null;
  const [lng, lat] = center as [number, number];
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90 || zoom < 0 || zoom > 24) return null;
  return {
    center: [lng, lat],
    zoom,
    bearing: finite(bearing) ? bearing : 0,
    pitch: finite(pitch) ? Math.min(85, Math.max(0, pitch)) : 0,
  };
}

// Whether the URL's hash holds a view MapLibre will open at: #zoom/lat/lng,
// optionally with bearing and pitch.
export function hashHasView(hash: string) {
  return /^#-?\d+(\.\d+)?\/-?\d+(\.\d+)?\/-?\d+(\.\d+)?(\/|$)/.test(hash);
}

export function loadMapView(storage?: Pick<Storage, 'getItem'> | null) {
  return readStoredSettings(MAP_VIEW_STORAGE_KEY, normalizeMapView, storage);
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

export function rememberMapView(map: ViewMap, storage?: Pick<Storage, 'setItem'> | null) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  map.on('moveend', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const { lng, lat } = map.getCenter();
      const view: MapView = {
        center: [round(lng, 5), round(lat, 5)],
        zoom: round(map.getZoom(), 2),
        bearing: round(map.getBearing(), 1),
        pitch: round(map.getPitch(), 1),
      };
      writeStoredSettings(MAP_VIEW_STORAGE_KEY, view, storage);
    }, SAVE_DELAY_MS);
  });
}
