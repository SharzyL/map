// Map display settings: base map (vector map, satellite, or satellite with
// roads and labels), base map saturation, label language, terrain layers and
// 3D terrain.
//
// Like the railway filter, every affected layer's visibility, colors and
// label text read `global-state`, set once when the style is built, so
// switching only flips global state properties. 3D terrain is a map setting
// rather than a layer and is applied with setTerrain.
import { readStoredSettings, writeStoredSettings } from './stored-settings.js';

export const MAP_LAYERS_STORAGE_KEY = 'atlas-realm:map-layers';

export const MAP_BASES = ['map', 'satellite', 'hybrid'] as const;
export type MapBase = (typeof MAP_BASES)[number];

// 'bilingual' keeps the base map's own Latin + local labels; 'local' shows each
// place's own name; the rest are languages with a fallback to the local name.
export const LABEL_LANGUAGES = ['bilingual', 'local', 'en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'ru'] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

export type MapLayerSettings = {
  base: MapBase;
  // Base map color saturation, 0 (grayscale) to 1 (original colors).
  saturation: number;
  // Draw the base map's roads in their own colors; off, they are gray so
  // railways stand out.
  highlightRoads: boolean;
  labels: LabelLanguage;
  hillshade: boolean;
  contours: boolean;
  terrain3d: boolean;
};

const BASE_STATE = 'baseMap';
const SATURATION_STATE = 'baseSaturation';
const HIGHLIGHT_ROADS_STATE = 'highlightRoads';
const LABEL_STATE = 'labelLanguage';
const HILLSHADE_STATE = 'showHillshade';
const CONTOURS_STATE = 'showContours';

export function defaultMapLayerSettings(): MapLayerSettings {
  return {
    base: 'map',
    saturation: 1,
    highlightRoads: false,
    labels: 'bilingual',
    hillshade: true,
    contours: true,
    terrain3d: false,
  };
}

export function normalizeMapLayerSettings(value: unknown): MapLayerSettings {
  const settings = defaultMapLayerSettings();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return settings;
  const record = value as Record<string, unknown>;
  if ((MAP_BASES as readonly unknown[]).includes(record.base)) settings.base = record.base as MapBase;
  if (typeof record.saturation === 'number' && Number.isFinite(record.saturation)) {
    settings.saturation = Math.min(1, Math.max(0, record.saturation));
  }
  if ((LABEL_LANGUAGES as readonly unknown[]).includes(record.labels)) settings.labels = record.labels as LabelLanguage;
  for (const key of ['highlightRoads', 'hillshade', 'contours', 'terrain3d'] as const) {
    if (typeof record[key] === 'boolean') settings[key] = record[key];
  }
  return settings;
}

export function loadMapLayerSettings(storage?: Pick<Storage, 'getItem'> | null) {
  return readStoredSettings(MAP_LAYERS_STORAGE_KEY, normalizeMapLayerSettings, storage);
}

export function saveMapLayerSettings(settings: MapLayerSettings, storage?: Pick<Storage, 'setItem'> | null) {
  writeStoredSettings(MAP_LAYERS_STORAGE_KEY, settings, storage);
}

export function mapLayerGlobalState(settings: MapLayerSettings): Record<string, unknown> {
  return {
    [BASE_STATE]: settings.base,
    [SATURATION_STATE]: settings.saturation,
    [HIGHLIGHT_ROADS_STATE]: settings.highlightRoads,
    [LABEL_STATE]: settings.labels,
    [HILLSHADE_STATE]: settings.hillshade,
    [CONTOURS_STATE]: settings.contours,
  };
}

type StyleLayerLike = {
  id?: string;
  type?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
};

// Base map layers kept over satellite imagery in hybrid mode: roads, rail,
// boundaries and every label. Fills, buildings and the background would hide
// the imagery.
export function isHybridBaseLayer(layer: StyleLayerLike) {
  if (layer.type === 'symbol') return true;
  const id = layer.id || '';
  // Road casings would outline every road in gray over the imagery.
  return layer.type === 'line' && /^(road|tunnel|bridge|boundary)_/.test(id) && !id.endsWith('_casing');
}

function withVisibility(layer: StyleLayerLike, visibleWhen: unknown) {
  const layout = { ...(layer.layout || {}) };
  const original = structuredClone(layout.visibility ?? 'visible');
  layout.visibility = ['case', visibleWhen, original, 'none'];
  return { ...layer, layout };
}

const base = ['to-string', ['global-state', BASE_STATE]];

export function withBaseMapVisibility<T extends StyleLayerLike>(layer: T): T {
  const bases = isHybridBaseLayer(layer) ? ['map', 'hybrid'] : ['map'];
  return withVisibility(layer, ['match', base, bases, true, false]) as T;
}

export function withSatelliteVisibility<T extends StyleLayerLike>(layer: T): T {
  return withVisibility(layer, ['match', base, ['satellite', 'hybrid'], true, false]) as T;
}

export function withHillshadeVisibility<T extends StyleLayerLike>(layer: T): T {
  return withVisibility(layer, ['to-boolean', ['global-state', HILLSHADE_STATE]]) as T;
}

export function withContourVisibility<T extends StyleLayerLike>(layer: T): T {
  return withVisibility(layer, ['to-boolean', ['global-state', CONTOURS_STATE]]) as T;
}

// --- Base map saturation ---------------------------------------------------

const SATURATION = ['to-number', ['global-state', SATURATION_STATE]];

// Mixes a color toward its gray (Rec. 601 luma) by the saturation setting.
function desaturate(color: unknown, saturation: unknown = SATURATION) {
  const channel = (index: number) => ['at', index, ['var', 'rgba']];
  const mix = (index: number) => [
    '+',
    ['var', 'gray'],
    ['*', ['var', 'saturation'], ['-', channel(index), ['var', 'gray']]],
  ];
  return [
    'let',
    'rgba',
    ['to-rgba', ['to-color', color]],
    'saturation',
    saturation,
    [
      'let',
      'gray',
      ['+', ['*', 0.299, channel(0)], ['*', 0.587, channel(1)], ['*', 0.114, channel(2)]],
      ['rgba', mix(0), mix(1), mix(2), channel(3)],
    ],
  ];
}

const ZOOM_CURVES = ['interpolate', 'interpolate-hcl', 'interpolate-lab', 'step'];

function isZoomCurve(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    ZOOM_CURVES.includes(value[0] as string) &&
    JSON.stringify(value[value[0] === 'step' ? 1 : 2]) === '["zoom"]'
  );
}

// Rewrites a paint/layout value through `wrap`. MapLibre only allows a zoom
// curve at the top of an expression, so curves are rewritten stop by stop and
// legacy {stops} functions become curves.
export function mapZoomOutputs(value: unknown, wrap: (output: unknown) => unknown): unknown {
  if (value === undefined || value === null) return value;
  if (isZoomCurve(value)) {
    const firstOutput = value[0] === 'step' ? 2 : 4;
    return value.map((item, index) =>
      index >= firstOutput && (index - firstOutput) % 2 === 0 ? mapZoomOutputs(item, wrap) : item,
    );
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const fn = value as { stops?: Array<[number, unknown]>; base?: number; property?: string };
    if (!fn.stops || fn.property) return value;
    return [
      'interpolate',
      ['exponential', fn.base ?? 1],
      ['zoom'],
      ...fn.stops.flatMap(([zoom, output]) => [zoom, mapZoomOutputs(output, wrap)]),
    ];
  }
  return wrap(value);
}

function desaturateColorValue(value: unknown): unknown {
  return mapZoomOutputs(value, desaturate);
}

// Applies the saturation setting to a base map layer's colors; raster layers
// (imagery) use MapLibre's own raster-saturation.
export function withBaseMapSaturation<T extends StyleLayerLike>(layer: T): T {
  const paint = { ...(layer.paint || {}) };
  if (layer.type === 'raster') {
    const original = paint['raster-saturation'] ?? 0;
    paint['raster-saturation'] = ['max', -1, ['min', 1, ['+', original, ['-', SATURATION, 1]]]];
  } else {
    for (const key of Object.keys(paint)) {
      if (key.endsWith('-color')) paint[key] = desaturateColorValue(paint[key]);
    }
  }
  return { ...layer, paint };
}

// --- Built-in shaded relief ------------------------------------------------

// OpenFreeMap draws low zooms with a Natural Earth II raster that bakes land
// colors and shaded relief into one image. It is heavy: one zoom-4 view on a
// high-DPI screen fetched 77 of its tiles, about 12 MB. Our own hillshade
// covers relief, so with Hillshade on the raster is hidden; hiding it through
// visibility (not opacity) also stops its tiles from downloading. With
// Hillshade off it still gives land its colors below zoom 4, where the vector
// tiles hold little besides water, and fades out by zoom 4.5, where the layer
// now ends so no fully transparent tiles are fetched above it.
export function isShadedReliefLayer(layer: StyleLayerLike) {
  return layer.type === 'raster' && layer.id === 'natural_earth';
}

const RELIEF_FADE_START = 3.5;
const RELIEF_FADE_END = 4.5;

// Evaluates a number or a numeric zoom interpolation (linear/exponential) at a zoom.
function numberAtZoom(value: unknown, zoom: number): number | null {
  if (typeof value === 'number') return value;
  if (!Array.isArray(value) || value[0] !== 'interpolate' || JSON.stringify(value[2]) !== '["zoom"]') return null;
  const [, interpolation, , ...stops] = value as [string, unknown[], unknown, ...number[]];
  const base = interpolation[0] === 'exponential' ? Number(interpolation[1]) : 1;
  if (stops.some((stop) => typeof stop !== 'number')) return null;
  if (zoom <= stops[0]) return stops[1];
  for (let index = 0; index + 3 < stops.length; index += 2) {
    const [z0, v0, z1, v1] = stops.slice(index, index + 4);
    if (zoom > z1) continue;
    const t = base === 1 ? (zoom - z0) / (z1 - z0) : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
    return v0 + (v1 - v0) * t;
  }
  return stops[stops.length - 1];
}

export function withShadedRelief<T extends StyleLayerLike>(layer: T): T {
  if (!isShadedReliefLayer(layer)) return layer;
  const hidden = withVisibility(layer, ['!', ['to-boolean', ['global-state', HILLSHADE_STATE]]]) as T;
  const original = layer.paint?.['raster-opacity'] ?? 1;
  const zooms = [0, 1, 2, 3, RELIEF_FADE_START];
  if (zooms.some((zoom) => numberAtZoom(original, zoom) === null)) return hidden;
  const stops = [...zooms.flatMap((zoom) => [zoom, numberAtZoom(original, zoom)]), RELIEF_FADE_END, 0];
  return {
    ...hidden,
    maxzoom: RELIEF_FADE_END,
    paint: { ...layer.paint, 'raster-opacity': ['interpolate', ['linear'], ['zoom'], ...stops] },
  };
}

// --- Hybrid styling ----------------------------------------------------------

// The base map's road and label colors are made for a plain light map. Over
// imagery its pale minor roads vanish, its major roads become opaque bands and
// its light label halos smear, so hybrid mode restyles them.
const IS_HYBRID = ['==', base, 'hybrid'];
// [color, width factor] by road class; major roads are thinned the most
// because the base map draws them widest.
const HYBRID_ROADS: Array<[RegExp, string, number]> = [
  [/motorway|trunk|primary/, 'rgba(255, 214, 102, 0.85)', 0.55],
  [/secondary|tertiary|street|link/, 'rgba(255, 255, 255, 0.75)', 0.7],
  [/./, 'rgba(255, 255, 255, 0.5)', 0.7],
];
const HYBRID_TEXT = '#ffffff';
const HYBRID_TEXT_HALO = 'rgba(0, 0, 0, 0.75)';

function inHybrid(value: unknown, hybridValue: unknown) {
  return mapZoomOutputs(value, (output) => ['case', IS_HYBRID, hybridValue, output]);
}

export function withHybridStyling<T extends StyleLayerLike>(layer: T): T {
  if (!isHybridBaseLayer(layer)) return layer;
  const id = layer.id || '';
  if (isRoadLayer(layer)) {
    const paint = { ...(layer.paint || {}) };
    const [, color, widthFactor] = HYBRID_ROADS.find(([pattern]) => pattern.test(id));
    paint['line-color'] = inHybrid(paint['line-color'], color);
    if (paint['line-width'] !== undefined) {
      paint['line-width'] = mapZoomOutputs(paint['line-width'], (output) => [
        '*',
        output,
        ['case', IS_HYBRID, widthFactor, 1],
      ]);
    }
    return { ...layer, paint };
  }
  if (layer.type === 'symbol' && layer.layout?.['text-field'] !== undefined) {
    const paint = { ...(layer.paint || {}) };
    paint['text-color'] = inHybrid(paint['text-color'] ?? '#000000', HYBRID_TEXT);
    paint['text-halo-color'] = inHybrid(paint['text-halo-color'] ?? 'rgba(0, 0, 0, 0)', HYBRID_TEXT_HALO);
    paint['text-halo-width'] = mapZoomOutputs(paint['text-halo-width'] ?? 0, (output) => [
      'case',
      IS_HYBRID,
      ['max', output, 1.2],
      output,
    ]);
    return { ...layer, paint };
  }
  return layer;
}

// --- Gray roads ------------------------------------------------------------

// The base map's yellow and orange roads compete with the railway overlay, so
// unless highlighted, roads keep their brightness but lose their color. Applied over
// the hybrid styling, which keeps its own road colors over imagery; both
// branches are colors, since the saturation rewrite wraps the result.
const GRAY_ROADS = ['all', ['!', ['to-boolean', ['global-state', HIGHLIGHT_ROADS_STATE]]], ['!', IS_HYBRID]];

export function isRoadLayer(layer: StyleLayerLike) {
  const id = layer.id || '';
  return layer.type === 'line' && /^(road|tunnel|bridge)_/.test(id) && !/_rail/.test(id);
}

export function withGrayRoads<T extends StyleLayerLike>(layer: T): T {
  if (!isRoadLayer(layer) || layer.paint?.['line-color'] === undefined) return layer;
  const color = mapZoomOutputs(layer.paint['line-color'], (output) => [
    'case',
    GRAY_ROADS,
    desaturate(output, 0),
    ['to-color', output],
  ]);
  return { ...layer, paint: { ...layer.paint, 'line-color': color } };
}

// --- Label language --------------------------------------------------------

const LANGUAGE = ['to-string', ['global-state', LABEL_STATE]];

// name:xx is the OpenMapTiles/OpenStreetMap tag; name_xx is the older
// OpenMapTiles attribute some tiles still carry.
function localizedName(fallback: unknown) {
  return ['coalesce', ['get', ['concat', 'name:', LANGUAGE]], ['get', ['concat', 'name_', LANGUAGE]], fallback];
}

function mentionsName(value: unknown) {
  return /"name[":_]/.test(JSON.stringify(value) ?? '');
}

// Base map labels: the style's own label for 'bilingual', the plain name for
// 'local', otherwise the chosen language falling back to the local name.
export function withBaseMapLabelLanguage<T extends StyleLayerLike>(layer: T): T {
  const original = layer.layout?.['text-field'];
  if (layer.type !== 'symbol' || original === undefined || !mentionsName(original)) return layer;
  const layout = {
    ...layer.layout,
    'text-field': [
      'match',
      LANGUAGE,
      'bilingual',
      original,
      'local',
      ['coalesce', ['get', 'name'], original],
      localizedName(['get', 'name']),
    ],
  };
  return { ...layer, layout };
}

function replaceGet(value: unknown, property: string, replacement: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length === 2 && value[0] === 'get' && value[1] === property) return replacement;
  return value.map((item) => replaceGet(item, property, replacement));
}

// Railway station labels show `localized_name`; in a fixed language they
// prefer a name:xx attribute when the tiles carry one.
export function withRailwayLabelLanguage<T extends StyleLayerLike>(layer: T): T {
  const original = layer.layout?.['text-field'];
  if (layer.type !== 'symbol' || !Array.isArray(original) || !JSON.stringify(original).includes('"localized_name"')) {
    return layer;
  }
  const localized = [
    'match',
    LANGUAGE,
    ['bilingual', 'local'],
    ['get', 'localized_name'],
    localizedName(['get', 'localized_name']),
  ];
  return { ...layer, layout: { ...layer.layout, 'text-field': replaceGet(original, 'localized_name', localized) } };
}

// Seeds the global state so the first render already matches the settings.
export function applyMapLayerState<T extends { state?: Record<string, { default?: unknown }> }>(
  style: T,
  settings: MapLayerSettings,
): T {
  const state = { ...(style.state || {}) };
  for (const [name, value] of Object.entries(mapLayerGlobalState(settings))) {
    state[name] = { ...(state[name] || {}), default: value };
  }
  return { ...style, state };
}
