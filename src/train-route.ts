// Draws the track a train opened in the timetable runs on, from the norikae
// API's train route (norikae.ts): the railway ways it covers whole are the
// tiles' own features, picked by id with the train route layers' filter (set
// here per train, the one place a highlight edits layers), and the rest is a
// GeoJSON source: the outline below z7, the parts of ways it covers partly,
// legs without a path as dashed straight lines, and its stops. The layers and
// the dimming of other railways come with the route highlight's
// (route-highlight.ts).
import { decodePolyline, type TrainRoute } from './norikae.js';
import { NO_TRAIN_WAYS, TRAIN_ROUTE_SOURCE, TRAIN_ROUTE_STATE, TRAIN_ROUTE_WAY_LAYER } from './route-highlight.js';
import { setGlobalStatePropertyWhenReady } from './style-ready.js';

type Bounds = [[number, number], [number, number]];
type Padding = { top: number; right: number; bottom: number; left: number };
type GeoJsonSourceLike = { setData(data: GeoJSON.FeatureCollection): void };
export type TrainRouteMap = Parameters<typeof setGlobalStatePropertyWhenReady>[0] & {
  getStyle(): { layers?: Array<{ id: string }> };
  getSource(id: string): unknown;
  setFilter(layerId: string, filter: unknown): void;
  fitBounds(bounds: Bounds, options?: Record<string, unknown>): unknown;
};

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const line = (kind: string, encoded: string): GeoJSON.Feature => ({
  type: 'Feature',
  properties: { kind },
  geometry: { type: 'LineString', coordinates: decodePolyline(encoded) },
});

// The route's GeoJSON part; `here` is the name of the stop the train was opened at.
export function trainRouteFeatures(route: TrainRoute, here: string | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      ...route.overview.map((encoded) => line('overview', encoded)),
      ...route.partial.map((encoded) => line('partial', encoded)),
      ...route.legs.flatMap((leg) =>
        leg.method === 'straight' && leg.straight ? [line('straight', leg.straight)] : [],
      ),
      ...route.stops.flatMap((stop): GeoJSON.Feature[] =>
        stop.position
          ? [
              {
                type: 'Feature',
                properties: { kind: 'stop', name: stop.name, here: stop.name === here },
                geometry: { type: 'Point', coordinates: stop.position },
              },
            ]
          : [],
      ),
    ],
  };
}

// The way layers' filter: the tile features with the route's way ids.
export function trainWaysFilter(ways: number[]) {
  return ways.length ? ['match', ['to-number', ['get', 'osm_id'], -1], ways, true, false] : NO_TRAIN_WAYS;
}

export function installTrainRoute(map: TrainRouteMap) {
  const wayLayers = () => (map.getStyle().layers ?? []).filter(({ id }) => TRAIN_ROUTE_WAY_LAYER.test(id));
  let shown = false;

  const draw = (route: TrainRoute | null, here: string | null = null) => {
    const filter = trainWaysFilter(route ? [...new Set(route.ways)] : []);
    for (const { id } of wayLayers()) map.setFilter(id, filter);
    (map.getSource(TRAIN_ROUTE_SOURCE) as GeoJsonSourceLike | undefined)?.setData(
      route ? trainRouteFeatures(route, here) : EMPTY,
    );
    if (shown !== Boolean(route)) setGlobalStatePropertyWhenReady(map, TRAIN_ROUTE_STATE, Boolean(route));
    shown = Boolean(route);
  };

  return {
    // Draws a train's route and fits the map to it, clear of the panel.
    show(route: TrainRoute, here: string | null, padding: Padding) {
      draw(route, here);
      const [west, south, east, north] = route.bbox;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding, maxZoom: 14, duration: 600 },
      );
    },
    clear() {
      if (shown) draw(null);
    },
  };
}

export type TrainRouteDrawer = ReturnType<typeof installTrainRoute>;
