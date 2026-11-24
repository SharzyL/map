// Draws the track a train opened in the timetable runs on, from the norikae
// API's train route (norikae.ts): the railway ways it covers whole are the
// tiles' own features, picked by id with the train route layers' filter (set
// here per train, the one place a highlight edits layers), and the rest is a
// GeoJSON source: the outline below z7, the parts of ways it covers partly,
// legs without a path as dashed straight lines, and its stops. Until the route
// comes (sketch), its stops joined in order stand in for it, faint and dashed,
// and stay if it cannot be had. The layers and
// the dimming of other railways come with the route highlight's
// (route-highlight.ts), as does the mark on the stop hovered in the timetable.
import { decodePolyline, type TrainRoute } from './norikae.js';
import {
  NO_TRAIN_WAYS,
  setStationHover,
  stopFeatures,
  stopKeys,
  TRAIN_ROUTE_SOURCE,
  TRAIN_ROUTE_STATE,
  TRAIN_ROUTE_WAY_LAYER,
  TRAIN_STOPS_STATE,
} from './route-highlight.js';
import { setGlobalStatePropertyWhenReady } from './style-ready.js';

type Bounds = [[number, number], [number, number]];
type Stop = { name: string; position: [number, number] | null; elements?: string[] | null };
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
      ...stopFeatures(route.stops, here),
    ],
  };
}

// The stops joined in order, a guess at the route until it comes, with the
// stops themselves; `here` as in trainRouteFeatures.
export function sketchFeatures(stops: Stop[], here: string | null): GeoJSON.FeatureCollection {
  const points = stops.flatMap((stop) => (stop.position ? [stop.position] : []));
  return {
    type: 'FeatureCollection',
    features: [
      ...(points.length >= 2
        ? [
            {
              type: 'Feature' as const,
              properties: { kind: 'sketch' },
              geometry: { type: 'LineString' as const, coordinates: points },
            },
          ]
        : []),
      ...stopFeatures(stops, here),
    ],
  };
}

// The extent of points, or null without any.
function boundsOf(points: Array<[number, number]>): Bounds | null {
  if (points.length === 0) return null;
  const lons = points.map(([lon]) => lon);
  const lats = points.map(([, lat]) => lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

// Whether `inner` lies within `outer`, give or take a tenth of its size: the
// map framing the stops shows the route too, and need not move again.
export function framedBy(inner: Bounds, outer: Bounds) {
  const slack = Math.max(outer[1][0] - outer[0][0], outer[1][1] - outer[0][1]) * 0.1;
  return (
    inner[0][0] >= outer[0][0] - slack &&
    inner[0][1] >= outer[0][1] - slack &&
    inner[1][0] <= outer[1][0] + slack &&
    inner[1][1] <= outer[1][1] + slack
  );
}

// The way layers' filter: the tile features with the route's way ids.
export function trainWaysFilter(ways: number[]) {
  return ways.length ? ['match', ['to-number', ['get', 'osm_id'], -1], ways, true, false] : NO_TRAIN_WAYS;
}

export function installTrainRoute(map: TrainRouteMap) {
  const wayLayers = () => (map.getStyle().layers ?? []).filter(({ id }) => TRAIN_ROUTE_WAY_LAYER.test(id));
  let shown = false;
  let hovered = false;
  // What the sketch framed, until the route replaces it
  let sketched: Bounds | null = null;

  const draw = (drawn: { features: GeoJSON.FeatureCollection; ways: number[]; stops: Stop[] } | null) => {
    const filter = trainWaysFilter(drawn ? [...new Set(drawn.ways)] : []);
    for (const { id } of wayLayers()) map.setFilter(id, filter);
    (map.getSource(TRAIN_ROUTE_SOURCE) as GeoJsonSourceLike | undefined)?.setData(drawn ? drawn.features : EMPTY);
    if (shown !== Boolean(drawn)) setGlobalStatePropertyWhenReady(map, TRAIN_ROUTE_STATE, Boolean(drawn));
    if (drawn || shown) setGlobalStatePropertyWhenReady(map, TRAIN_STOPS_STATE, drawn ? stopKeys(drawn.stops) : []);
    shown = Boolean(drawn);
  };

  return {
    // Joins a train's stops while its route loads, and fits the map to them.
    sketch(stops: Stop[], here: string | null, padding: Padding) {
      const bounds = boundsOf(stops.flatMap((stop) => (stop.position ? [stop.position] : [])));
      if (!bounds) return;
      draw({ features: sketchFeatures(stops, here), ways: [], stops });
      sketched = bounds;
      map.fitBounds(bounds, { padding, maxZoom: 14, duration: 600 });
    },
    // Draws a train's route and fits the map to it, clear of the panel,
    // unless the sketch before it framed it already.
    show(route: TrainRoute, here: string | null, padding: Padding) {
      draw({ features: trainRouteFeatures(route, here), ways: route.ways, stops: route.stops });
      const [west, south, east, north] = route.bbox;
      const bounds: Bounds = [
        [west, south],
        [east, north],
      ];
      if (!sketched || !framedBy(bounds, sketched)) map.fitBounds(bounds, { padding, maxZoom: 14, duration: 600 });
      sketched = null;
    },
    // Marks the stop a pointer is on in the timetable, or none.
    hover(stop: { name: string; position: [number, number] | null } | null) {
      if (!stop && !hovered) return;
      hovered = Boolean(stop);
      setStationHover(map, stop);
    },
    clear() {
      this.hover(null);
      sketched = null;
      if (shown) draw(null);
    },
  };
}

export type TrainRouteDrawer = ReturnType<typeof installTrainRoute>;
