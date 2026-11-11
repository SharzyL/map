// Reads route and line ids from z7 tiles for the zoomed-out map, where tiles
// carry none. traceRoute collects the whole geometry of one route: starting
// from the tiles in view, every tile where a route segment runs off an edge
// pulls in the neighbour across that edge, until the route ends or the tile
// budget runs out. lineListsNear finds the routes and lines of a clicked line.
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
    const { line_routes, line_relations } = feature.properties;
    if (!routeListHasRoute(line_routes, routeId) && !routeListHasRoute(line_relations, routeId)) continue;
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

export type LineLists = { line_relations?: string; line_routes?: string };
export type LineListQuery = { lng: number; lat: number; radius: number; name?: string };

const METERS_PER_DEGREE = 111320;

// Meters from a point to a line geometry, on a local flat projection.
function distanceToGeometry(lng: number, lat: number, geometry: GeoJSON.Geometry) {
  const lines =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : [];
  const xScale = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const [ax, ay] = [(line[index - 1][0] - lng) * xScale, (line[index - 1][1] - lat) * METERS_PER_DEGREE];
      const [bx, by] = [(line[index][0] - lng) * xScale, (line[index][1] - lat) * METERS_PER_DEGREE];
      const [dx, dy] = [bx - ax, by - ay];
      const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

// Joins route or line lists, keeping each relation once.
function mergeRelationLists(values: unknown[]) {
  const items = new Map<string, string>();
  for (const value of values) {
    for (const item of String(value ?? '').split('\u001d')) {
      const id = item.split('\u001e')[0];
      if (id && !items.has(id)) items.set(id, item);
    }
  }
  return items.size > 0 ? [...items.values()].join('\u001d') : undefined;
}

// The line and route lists of the z7 segments near a point. Lines drawn below
// z7 come from a layer without them, so a click there looks them up here.
// Parallel lines can run within the click radius, so segments must share the
// clicked line's name; an unnamed line takes the nearest segment only.
export async function lineListsNear(
  { lng, lat, radius, name }: LineListQuery,
  fetchTile: TileFetcher,
  signal?: AbortSignal,
): Promise<LineLists> {
  const dLat = radius / METERS_PER_DEGREE;
  const dLng = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const near: Array<{ distance: number; properties: Record<string, unknown> }> = [];
  await Promise.all(
    tilesInBounds(lng - dLng, lat - dLat, lng + dLng, lat + dLat, 4).map(async ([x, y]) => {
      const buffer = await fetchTile(ROUTE_TRACE_ZOOM, x, y, signal).catch((): null => null);
      if (!buffer || signal?.aborted) return;
      const layer = new VectorTile(new Pbf(new Uint8Array(buffer))).layers[LINE_SOURCE_LAYER];
      for (let index = 0; index < (layer?.length ?? 0); index += 1) {
        const feature = layer.feature(index);
        if (name && feature.properties.name !== name) continue;
        const distance = distanceToGeometry(lng, lat, feature.toGeoJSON(x, y, ROUTE_TRACE_ZOOM).geometry);
        if (distance <= radius) near.push({ distance, properties: feature.properties });
      }
    }),
  );
  const chosen = name ? near : near.sort((a, b) => a.distance - b.distance).slice(0, 1);
  return {
    line_relations: mergeRelationLists(chosen.map(({ properties }) => properties.line_relations)),
    line_routes: mergeRelationLists(chosen.map(({ properties }) => properties.line_routes)),
  };
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
