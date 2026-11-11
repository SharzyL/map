// Collects the whole geometry of one route for the zoomed-out map. Tiles below
// z7 carry no route ids, so the route is followed through z7 tiles instead:
// starting from the tiles in view, every tile where a route segment runs off
// an edge pulls in the neighbour across that edge, until the route ends or
// the tile budget runs out.
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

export const ROUTE_TRACE_ZOOM = 7;
const LINE_SOURCE_LAYER = 'railway_line_high';
const MAX_TILES = 48;
const CONCURRENCY = 4;

export type TileFetcher = (z: number, x: number, y: number, signal?: AbortSignal) => Promise<ArrayBuffer | null>;
export type RouteGeometry = { type: 'FeatureCollection'; features: GeoJSON.Feature<GeoJSON.Geometry>[] };
type TileKey = `${number}/${number}`;

export function routeListHasRoute(value: unknown, routeId: string) {
  return `\u001d${value ?? ''}`.includes(`\u001d${routeId}\u001e`);
}

// The z7 tiles covering a lon/lat box, at most `limit` of them.
export function tilesInBounds(west: number, south: number, east: number, north: number, limit = 16) {
  const n = 2 ** ROUTE_TRACE_ZOOM;
  const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const tileY = (lat: number) => {
    const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
    const rad = (clamped * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  };
  const tiles: Array<[number, number]> = [];
  for (let x = tileX(west); x <= tileX(east); x += 1) {
    for (let y = Math.max(0, tileY(north)); y <= Math.min(n - 1, tileY(south)); y += 1) {
      tiles.push([((x % n) + n) % n, y]);
      if (tiles.length >= limit) return tiles;
    }
  }
  return tiles;
}

function readTile(buffer: ArrayBuffer, x: number, y: number, routeId: string) {
  const layer = new VectorTile(new Pbf(new Uint8Array(buffer))).layers[LINE_SOURCE_LAYER];
  const features: GeoJSON.Feature<GeoJSON.Geometry>[] = [];
  const neighbours: Array<[number, number]> = [];
  if (!layer) return { features, neighbours };
  for (let index = 0; index < layer.length; index += 1) {
    const feature = layer.feature(index);
    if (!routeListHasRoute(feature.properties.line_routes, routeId)) continue;
    const geojson = feature.toGeoJSON(x, y, ROUTE_TRACE_ZOOM);
    features.push({ type: 'Feature', properties: {}, geometry: geojson.geometry });
    // Lines are clipped a little outside the tile, so a vertex on or past an
    // edge means the route continues in the neighbouring tile.
    for (const ring of feature.loadGeometry()) {
      for (const point of ring) {
        const dx = point.x <= 0 ? -1 : point.x >= layer.extent ? 1 : 0;
        const dy = point.y <= 0 ? -1 : point.y >= layer.extent ? 1 : 0;
        if (dx || dy) neighbours.push([x + dx, y + dy]);
      }
    }
  }
  return { features, neighbours };
}

export async function traceRoute(
  routeId: string,
  seeds: Array<[number, number]>,
  fetchTile: TileFetcher,
  signal?: AbortSignal,
): Promise<RouteGeometry> {
  const n = 2 ** ROUTE_TRACE_ZOOM;
  const seen = new Set<TileKey>();
  const queue: Array<[number, number]> = [];
  const enqueue = ([x, y]: [number, number]) => {
    const wrappedX = ((x % n) + n) % n;
    const key: TileKey = `${wrappedX}/${y}`;
    if (y < 0 || y >= n || seen.has(key) || seen.size >= MAX_TILES) return;
    seen.add(key);
    queue.push([wrappedX, y]);
  };
  seeds.forEach(enqueue);

  const features: GeoJSON.Feature<GeoJSON.Geometry>[] = [];
  const worker = async () => {
    while (queue.length > 0 && !signal?.aborted) {
      const [x, y] = queue.shift();
      const buffer = await fetchTile(ROUTE_TRACE_ZOOM, x, y, signal).catch((): null => null);
      if (!buffer || signal?.aborted) continue;
      const tile = readTile(buffer, x, y, routeId);
      features.push(...tile.features);
      tile.neighbours.forEach(enqueue);
    }
  };
  // Workers pick up tiles that others enqueue, so keep starting them while
  // the queue still has work.
  while (queue.length > 0 && !signal?.aborted) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  }
  return { type: 'FeatureCollection', features };
}
