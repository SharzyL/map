// The railway features under the pointer (a whole line, or one station,
// platform or other feature; popup.ts picks them), drawn from a small GeoJSON
// source of their own over the railway lines and under the station labels:
// lines in the hover color (RAILWAY_HOVER_COLOR, which stands out from the
// line's own color in the current color mode), points with a glow, areas
// tinted.
//
// Not feature state: MapLibre keeps the state of every feature it ever held
// state for, even once removed, and replays all of it into every tile it
// loads, for each of the ~200 line layers reading it. After a while of moving
// the pointer over lines, each tile coming in while zooming or panning took
// hundreds of milliseconds on the main thread.
import { withRailwayOverlayVisibility } from './railway-filter.js';
import { RAILWAY_HOVER_COLOR } from './railway-colors.js';

export const RAILWAY_HOVER_SOURCE = 'railway-hover';
const LINE_SOURCE_LAYER = 'railway_line_high';

type StyleLayerLike = { id?: string; type?: string; source?: string; 'source-layer'?: string; [key: string]: unknown };
type StyleLike = { layers?: StyleLayerLike[]; sources?: unknown; [key: string]: unknown };

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const GEOMETRY = ['geometry-type'];

// A station's area (its grouped stations), hovered, took a deeper shade of its
// own color: 0.3 opaque instead of 0.2, about what this over it makes.
const AREA_LAYER = 'railway_grouped_stations';
const AREA_COLOR = '#535353';

export function railwayHoverLayers(areaColor: unknown = AREA_COLOR): StyleLayerLike[] {
  return [
    {
      id: 'railway_hover_area',
      type: 'fill',
      source: RAILWAY_HOVER_SOURCE,
      filter: ['==', GEOMETRY, 'Polygon'],
      paint: { 'fill-color': areaColor, 'fill-opacity': 0.13 },
    },
    {
      id: 'railway_hover_line',
      type: 'line',
      source: RAILWAY_HOVER_SOURCE,
      filter: ['==', GEOMETRY, 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': RAILWAY_HOVER_COLOR,
        // A little wider than the railway lines it covers (2-3 px)
        'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 0, 1, 7, 2.5, 16, 3.5],
      },
    },
    {
      id: 'railway_hover_point',
      type: 'circle',
      source: RAILWAY_HOVER_SOURCE,
      filter: ['==', GEOMETRY, 'Point'],
      paint: {
        'circle-color': ['case', ['==', ['global-state', 'theme'], 'light'], '#ffee00', '#e7e700'],
        'circle-opacity': 0.75,
        'circle-blur': 0.6,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 8, 12, 11, 16, 14],
      },
    },
  ];
}

// Adds the hover layers right above the last railway line layer, so a lit
// line covers the lines and the station icons and labels stay on top of it.
export function addRailwayHoverToStyle<T extends StyleLike>(style: T, railwaySources: readonly string[]): T {
  const layers = style.layers || [];
  const railway = new Set(railwaySources);
  const insertAt =
    layers.findLastIndex(
      (layer) =>
        !!layer.source &&
        railway.has(layer.source) &&
        layer.type === 'line' &&
        layer['source-layer'] === LINE_SOURCE_LAYER,
    ) + 1;
  if (insertAt === 0) return style;
  const sources = { ...((style.sources as Record<string, unknown>) || {}) };
  sources[RAILWAY_HOVER_SOURCE] = { type: 'geojson', data: EMPTY };
  const area = layers.find((layer) => layer.id === AREA_LAYER)?.paint as Record<string, unknown> | undefined;
  return {
    ...style,
    sources,
    layers: [
      ...layers.slice(0, insertAt),
      ...railwayHoverLayers(area?.['fill-color']).map(withRailwayOverlayVisibility),
      ...layers.slice(insertAt),
    ],
  };
}

type HoverSource = { setData(data: GeoJSON.FeatureCollection): unknown };
type HoverMap = { getSource?(id: string): unknown };

// What a queried feature is, as GeoJSON: MapLibre's features build their
// geometry on reading it.
export type HoverFeature = {
  geometry?: { type: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
};

export function toHoverFeature(feature: HoverFeature): GeoJSON.Feature | null {
  const geometry = feature.geometry;
  if (!geometry) return null;
  return { type: 'Feature', geometry: geometry as GeoJSON.Geometry, properties: feature.properties ?? {} };
}

// Draws the given features as hovered, none for an empty list.
export function setRailwayHover(map: HoverMap, features: HoverFeature[]) {
  const source = map.getSource?.(RAILWAY_HOVER_SOURCE) as HoverSource | undefined;
  source?.setData({ type: 'FeatureCollection', features: features.map(toHoverFeature).filter(Boolean) });
}
