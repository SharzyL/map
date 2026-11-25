// Which zoom of a vector source's tiles the map draws where.
//
// On the globe MapLibre picks each tile's zoom by its distance from the camera
// (calculateTileZoom), and near the middle of the view that comes out about
// 0.08 above the map's zoom: at z7.98 the middle takes z8 tiles. A tile only
// holds the layers drawn at its own zoom, so a z8 tile has none of the layers
// that end at z8, while those starting at z8 stay hidden below it: just under
// an integer zoom where layers hand over (the railway lines' groups at 7 and
// 8), the middle of the map showed no railway at all, though the tiles were in
// (the hover overlay found the lines). So a tile within half a zoom level of
// the map's zoom takes the map's zoom, and only those MapLibre would fetch
// coarser for a pitched view's distance keep its choice.
import type * as maplibregl from 'maplibre-gl';

type TileZoomFunction = maplibregl.CalculateTileZoomFunction;

// MapLibre's own level of detail (src/geo/projection/covering_tiles.ts)
const MAX_ZOOM_LEVELS_ON_SCREEN = 9.314;
const TILE_COUNT_MAX_MIN_RATIO = 3;
const SNAP = 0.5;

export function steadyTileZoom(lod: TileZoomFunction): TileZoomFunction {
  return (centerZoom, ...rest) => {
    const zoom = lod(centerZoom, ...rest);
    return zoom >= centerZoom - SNAP ? centerZoom : zoom;
  };
}

type TileZoomMap = {
  getStyle(): { sources?: Record<string, { type?: string }> };
  getSource(id: string): unknown;
  setSourceTileLodParams(maxZoomLevelsOnScreen: number, tileCountMaxMinRatio: number, sourceId?: string): unknown;
};

export function installSteadyTileZoom(map: TileZoomMap) {
  for (const [id, source] of Object.entries(map.getStyle().sources ?? {})) {
    if (source.type !== 'vector') continue;
    // Sets MapLibre's default function on the source, to wrap
    map.setSourceTileLodParams(MAX_ZOOM_LEVELS_ON_SCREEN, TILE_COUNT_MAX_MIN_RATIO, id);
    const target = map.getSource(id) as { calculateTileZoom?: TileZoomFunction } | undefined;
    if (target?.calculateTileZoom) target.calculateTileZoom = steadyTileZoom(target.calculateTileZoom);
  }
}
