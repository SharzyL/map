// Locate control: a pin button that shows the coordinates and ground elevation
// under the mouse pointer, or at the last tapped point on touch screens.
//
// Elevation comes from the same terrarium DEM tiles the contour lines use.
// Decoded tiles are kept on the main thread, so moving the pointer only reads
// memory; a tile not loaded yet is fetched once the pointer rests.
import MapPinIcon from 'lucide/dist/esm/icons/map-pin.mjs';
import { createPanelButton, el } from './map-panel.js';

export type DemTileLike = { width: number; height: number; data: Float32Array };
export type FetchDemTile = (z: number, x: number, y: number) => Promise<DemTileLike>;

type LngLat = { lng: number; lat: number };
type MapPointerEvent = { lngLat: LngLat };
type LocateControl = {
  onAdd(map: LocateMap): HTMLElement;
  onRemove(): void;
};
export type LocateMap = {
  addControl(control: LocateControl, position?: string): void;
  getContainer(): HTMLElement;
  getCanvasContainer(): HTMLElement;
  getZoom(): number;
  on(event: 'mousemove' | 'click', listener: (event: MapPointerEvent) => void): unknown;
  off(event: 'mousemove' | 'click', listener: (event: MapPointerEvent) => void): unknown;
};

// Highest DEM zoom with worldwide coverage, about 19 m per pixel at the equator.
const DEM_MAX_ZOOM = 12;
// Two zooms past the view, so zoomed-out peaks are not averaged away.
const DEM_EXTRA_ZOOM = 2;
const TILE_CACHE_SIZE = 16;
const FETCH_DELAY_MS = 120;

export function formatCoordinates({ lng, lat }: LngLat) {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  const latText = `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lngText = `${Math.abs(wrapped).toFixed(5)}° ${wrapped >= 0 ? 'E' : 'W'}`;
  return `${latText}, ${lngText}`;
}

export function formatElevation(meters: number) {
  return `${Math.round(meters).toLocaleString('en-US')} m`;
}

export function demZoom(mapZoom: number) {
  return Math.max(0, Math.min(DEM_MAX_ZOOM, Math.floor(mapZoom) + DEM_EXTRA_ZOOM));
}

// Web Mercator tile holding a point, with the point's position inside it (0-1).
export function demTilePosition({ lng, lat }: LngLat, z: number) {
  const n = 2 ** z;
  const sin = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  const x = ((lng + 180) / 360) * n;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n;
  const tileX = Math.max(0, Math.min(n - 1, Math.floor(x)));
  const tileY = Math.max(0, Math.min(n - 1, Math.floor(y)));
  return { x: tileX, y: tileY, fx: x - tileX, fy: y - tileY };
}

// Bilinear interpolation between the centers of the four nearest pixels.
export function sampleDemTile(tile: DemTileLike, fx: number, fy: number) {
  const px = Math.max(0, Math.min(tile.width - 1, fx * tile.width - 0.5));
  const py = Math.max(0, Math.min(tile.height - 1, fy * tile.height - 0.5));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, tile.width - 1);
  const y1 = Math.min(y0 + 1, tile.height - 1);
  const at = (x: number, y: number) => tile.data[y * tile.width + x];
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (px - x0);
  const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (px - x0);
  return top + (bottom - top) * (py - y0);
}

// Decoded tiles by z/x/y, most recently used last; a failed fetch is kept as
// null so it is not retried on every move.
export class DemTileCache {
  _tiles = new Map<string, DemTileLike | null>();
  _pending = new Map<string, Promise<void>>();
  _fetchTile: FetchDemTile;

  constructor(fetchTile: FetchDemTile) {
    this._fetchTile = fetchTile;
  }

  // The elevation if its tile is loaded, null if the tile has none, undefined
  // if it still has to be fetched.
  elevationAt(point: LngLat, z: number): number | null | undefined {
    const { x, y, fx, fy } = demTilePosition(point, z);
    const key = `${z}/${x}/${y}`;
    if (!this._tiles.has(key)) return undefined;
    const tile = this._tiles.get(key);
    this._tiles.delete(key);
    this._tiles.set(key, tile);
    return tile ? sampleDemTile(tile, fx, fy) : null;
  }

  load(point: LngLat, z: number): Promise<void> {
    const { x, y } = demTilePosition(point, z);
    const key = `${z}/${x}/${y}`;
    if (this._tiles.has(key)) return Promise.resolve();
    if (!this._pending.has(key)) {
      const request = this._fetchTile(z, x, y)
        .then(
          (tile) => this._store(key, tile),
          () => this._store(key, null),
        )
        .finally(() => this._pending.delete(key));
      this._pending.set(key, request);
    }
    return this._pending.get(key);
  }

  _store(key: string, tile: DemTileLike | null) {
    this._tiles.set(key, tile);
    while (this._tiles.size > TILE_CACHE_SIZE) this._tiles.delete(this._tiles.keys().next().value);
  }
}

class Locate {
  _cache: DemTileCache;
  _map: LocateMap;
  _control: HTMLElement;
  _button: HTMLButtonElement;
  _readout: HTMLElement;
  _coordinates: HTMLElement;
  _elevation: HTMLElement;
  _enabled = false;
  _point: LngLat | null = null;
  _fetchTimer: ReturnType<typeof setTimeout> | null = null;
  _boundPointer: (event: MapPointerEvent) => void;
  _boundLeave: () => void;

  constructor(fetchTile: FetchDemTile) {
    this._cache = new DemTileCache(fetchTile);
    this._boundPointer = (event) => this._show(event.lngLat);
    this._boundLeave = () => this._show(null);
  }

  onAdd(map: LocateMap) {
    this._map = map;
    ({ control: this._control, button: this._button } = createPanelButton(
      'maplibregl-ctrl-locate',
      'Locate',
      MapPinIcon,
      'locate-icon',
    ));
    this._button.title = 'Show coordinates and elevation under the pointer';
    this._button.addEventListener('click', () => this.setEnabled(!this._enabled));

    this._readout = el('div', 'cursor-position', map.getContainer());
    this._readout.setAttribute('role', 'status');
    this._coordinates = el('div', 'cursor-position-coordinates', this._readout);
    this._elevation = el('div', 'cursor-position-elevation', this._readout);

    // Taps fire click without mousemove, so touch screens show the tapped point.
    map.on('mousemove', this._boundPointer);
    map.on('click', this._boundPointer);
    map.getCanvasContainer().addEventListener('mouseleave', this._boundLeave);
    this._sync();
    return this._control;
  }

  onRemove() {
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    this._map.off('mousemove', this._boundPointer);
    this._map.off('click', this._boundPointer);
    this._map.getCanvasContainer().removeEventListener('mouseleave', this._boundLeave);
    this._readout?.remove();
    this._control?.remove();
    this._map = undefined;
  }

  setEnabled(enabled: boolean) {
    this._enabled = enabled;
    if (!enabled) this._point = null;
    this._sync();
  }

  _show(point: LngLat | null) {
    if (!this._enabled) return;
    this._point = point;
    this._sync();
  }

  _sync() {
    this._button.classList.toggle('maplibregl-ctrl-locate-enabled', this._enabled);
    this._button.setAttribute('aria-pressed', this._enabled ? 'true' : 'false');
    this._readout.hidden = !this._enabled;
    if (!this._enabled) return;
    const point = this._point;
    if (!point) {
      this._coordinates.textContent = 'Point at the map';
      this._elevation.textContent = '';
      return;
    }
    this._coordinates.textContent = formatCoordinates(point);
    const z = demZoom(this._map.getZoom());
    const elevation = this._cache.elevationAt(point, z);
    this._elevation.textContent =
      elevation === undefined
        ? 'Elevation …'
        : elevation === null
          ? 'Elevation unavailable'
          : `Elevation ${formatElevation(elevation)}`;
    if (elevation === undefined) this._scheduleFetch(point, z);
  }

  _scheduleFetch(point: LngLat, z: number) {
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    this._fetchTimer = setTimeout(() => {
      this._fetchTimer = null;
      void this._cache.load(point, z).then(() => {
        if (this._point === point) this._sync();
      });
    }, FETCH_DELAY_MS);
  }
}

export function installLocate(map: LocateMap, fetchTile: FetchDemTile) {
  map.addControl(new Locate(fetchTile), 'top-right');
}
