import { createExpression, featureFilter, latest, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import ormStyleText from '../public/orm/style/standard.json?raw';
import {
  applyMapLayerState,
  defaultMapLayerSettings,
  isHybridBaseLayer,
  loadMapLayerSettings,
  mapLayerGlobalState,
  normalizeMapLayerSettings,
  saveMapLayerSettings,
  withBaseMapLabelLanguage,
  withBaseMapSaturation,
  withBaseMapVisibility,
  withContourVisibility,
  withHybridStyling,
  withShadedReliefFade,
  withHillshadeVisibility,
  withRailwayLabelLanguage,
  withSatelliteVisibility,
  type MapBase,
  type MapLayerSettings,
} from './map-layers.js';

type Layer = { id: string; type: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> };

const paintLayer = (layer: Layer) => layer;

// Evaluates a layer's visibility expression the way MapLibre does for a
// given global state, by reusing the `case` condition as a filter.
function isVisible(layer: Layer, settings: Partial<MapLayerSettings> = {}) {
  const visibility = layer.layout?.visibility as unknown[];
  expect(visibility[0]).toBe('case');
  const state = mapLayerGlobalState({ ...defaultMapLayerSettings(), ...settings });
  const shown = featureFilter(visibility[1] as never, state).filter({ zoom: 10 }, { type: 1, properties: {} } as never);
  return shown && visibility[2] !== 'none';
}

const ROAD = { id: 'road_motorway', type: 'line' };
const BOUNDARY = { id: 'boundary_2', type: 'line' };
const LABEL = { id: 'label_city', type: 'symbol' };
const WATER = { id: 'water', type: 'fill' };
const WATERWAY = { id: 'waterway_river', type: 'line' };
const BACKGROUND = { id: 'background', type: 'background' };

describe('base map visibility', () => {
  it('keeps roads, boundaries and labels over imagery in hybrid mode', () => {
    expect([ROAD, BOUNDARY, LABEL].every(isHybridBaseLayer)).toBe(true);
    expect([WATER, WATERWAY, BACKGROUND].some(isHybridBaseLayer)).toBe(false);
  });

  it('shows the right layers for each base map', () => {
    const visible = (layer: Layer, base: MapBase) => isVisible(withBaseMapVisibility(layer), { base });
    for (const layer of [ROAD, LABEL, WATER, BACKGROUND]) expect(visible(layer, 'map')).toBe(true);
    for (const layer of [ROAD, LABEL, WATER, BACKGROUND]) expect(visible(layer, 'satellite')).toBe(false);
    expect(visible(ROAD, 'hybrid')).toBe(true);
    expect(visible(LABEL, 'hybrid')).toBe(true);
    expect(visible(WATER, 'hybrid')).toBe(false);
    expect(visible(BACKGROUND, 'hybrid')).toBe(false);

    const satellite = withSatelliteVisibility({ id: 'satellite-layer', type: 'raster' });
    expect(isVisible(satellite, { base: 'map' })).toBe(false);
    expect(isVisible(satellite, { base: 'satellite' })).toBe(true);
    expect(isVisible(satellite, { base: 'hybrid' })).toBe(true);
  });

  it('keeps a layer hidden by its own style hidden in every mode', () => {
    const hidden = withBaseMapVisibility({ ...LABEL, layout: { visibility: 'none' } });
    expect(isVisible(hidden, { base: 'map' })).toBe(false);
  });
});

describe('terrain layer visibility', () => {
  it('keeps the built-in shaded relief at low zoom and fades it out with hillshade off', () => {
    // OpenFreeMap's natural_earth raster.
    const relief = withShadedReliefFade(
      paintLayer({
        id: 'natural_earth',
        type: 'raster',
        paint: { 'raster-opacity': ['interpolate', ['exponential', 1.5], ['zoom'], 0, 0.6, 6, 0.1] },
      }),
    );
    const opacity = (zoom: number, hillshade: boolean) =>
      evaluate(
        relief.paint['raster-opacity'],
        latest.paint_raster['raster-opacity'],
        { hillshade },
        {},
        zoom,
      ) as number;
    expect(opacity(0, false)).toBeCloseTo(0.6);
    expect(opacity(2, false)).toBeCloseTo(opacity(2, true));
    expect(opacity(5, true)).toBeGreaterThan(0.1);
    expect(opacity(4.5, false)).toBe(0);
    expect(opacity(6, false)).toBe(0);
    expect(isVisible(withBaseMapVisibility({ id: 'natural_earth', type: 'raster' }), { hillshade: false })).toBe(true);
  });

  it('follows the hillshade and contour switches independently', () => {
    const hillshade = withHillshadeVisibility({ id: 'trip-hillshade', type: 'hillshade' });
    const contours = withContourVisibility({ id: 'trip-contour-lines', type: 'line' });
    expect(isVisible(hillshade)).toBe(true);
    expect(isVisible(hillshade, { hillshade: false })).toBe(false);
    expect(isVisible(contours, { hillshade: false })).toBe(true);
    expect(isVisible(contours, { contours: false })).toBe(false);
  });
});

function evaluate(
  value: unknown,
  spec: unknown,
  settings: Partial<MapLayerSettings>,
  properties: object = {},
  zoom = 10,
) {
  const state = mapLayerGlobalState({ ...defaultMapLayerSettings(), ...settings });
  const parsed = createExpression(value, spec as never, state);
  expect(parsed.result).toBe('success');
  return (parsed.value as { evaluate(globals: object, feature: object): unknown }).evaluate(
    { zoom },
    { type: 1, properties },
  );
}

function rgb(color: unknown) {
  const { r, g, b } = color as { r: number; g: number; b: number };
  return [r, g, b].map((channel) => Math.round(channel * 255));
}

describe('base map saturation', () => {
  const fillColor = latest.paint_fill['fill-color'];

  it('keeps original colors at full saturation and turns them gray at zero', () => {
    const water = withBaseMapSaturation({ id: 'water', type: 'fill', paint: { 'fill-color': 'rgb(158,189,255)' } });
    expect(rgb(evaluate(water.paint['fill-color'], fillColor, { saturation: 1 }))).toEqual([158, 189, 255]);
    expect(rgb(evaluate(water.paint['fill-color'], fillColor, { saturation: 0 }))).toEqual([187, 187, 187]);
    expect(rgb(evaluate(water.paint['fill-color'], fillColor, { saturation: 0.5 }))).toEqual([173, 188, 221]);
  });

  it('desaturates zoom curves and legacy stop functions stop by stop', () => {
    const curve = withBaseMapSaturation({
      id: 'park',
      type: 'fill',
      paint: { 'fill-color': ['interpolate', ['linear'], ['zoom'], 5, '#ff0000', 10, 'hsl(120, 100%, 50%)'] },
    });
    const curveColor = curve.paint['fill-color'] as unknown[];
    expect(curveColor.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
    const red = rgb(evaluate(curveColor, fillColor, { saturation: 0 }, {}, 5));
    expect(red[0]).toBe(red[1]);

    const legacy = withBaseMapSaturation(
      paintLayer({
        id: 'road',
        type: 'line',
        paint: {
          'line-color': {
            base: 1.2,
            stops: [
              [5, '#ff0000'],
              [12, '#0000ff'],
            ],
          },
        },
      }),
    );
    expect((legacy.paint['line-color'] as unknown[]).slice(0, 3)).toEqual([
      'interpolate',
      ['exponential', 1.2],
      ['zoom'],
    ]);
  });

  it('drives raster saturation for imagery and leaves other paint alone', () => {
    const imagery = withBaseMapSaturation(
      paintLayer({ id: 'satellite-layer', type: 'raster', paint: { 'raster-opacity': 1 } }),
    );
    const spec = latest.paint_raster['raster-saturation'];
    expect(evaluate(imagery.paint['raster-saturation'], spec, { saturation: 1 })).toBe(0);
    expect(evaluate(imagery.paint['raster-saturation'], spec, { saturation: 0 })).toBe(-1);
    expect(imagery.paint['raster-opacity']).toBe(1);
  });
});

describe('hybrid styling', () => {
  const lineColor = latest.paint_line['line-color'];
  const lineWidth = latest.paint_line['line-width'];

  it('drops road casings over imagery', () => {
    expect(isHybridBaseLayer({ id: 'road_motorway_casing', type: 'line' })).toBe(false);
    expect(isVisible(withBaseMapVisibility({ id: 'road_motorway_casing', type: 'line' }), { base: 'hybrid' })).toBe(
      false,
    );
  });

  it('restyles roads only in hybrid mode', () => {
    const road = withHybridStyling(
      paintLayer({
        id: 'road_trunk_primary',
        type: 'line',
        paint: {
          'line-color': '#ffeeaa',
          'line-width': ['interpolate', ['exponential', 1.2], ['zoom'], 5, 0.4, 20, 30],
        },
      }),
    );
    expect(rgb(evaluate(road.paint['line-color'], lineColor, { base: 'map' }))).toEqual([255, 238, 170]);
    // MapLibre colors are premultiplied by alpha.
    const hybridColor = evaluate(road.paint['line-color'], lineColor, { base: 'hybrid' }) as { a: number };
    expect(hybridColor.a).toBeCloseTo(0.85);
    expect(rgb(hybridColor).map((channel) => Math.round(channel / hybridColor.a))).toEqual([255, 214, 102]);
    expect(evaluate(road.paint['line-width'], lineWidth, { base: 'map' }, {}, 20)).toBe(30);
    expect(evaluate(road.paint['line-width'], lineWidth, { base: 'hybrid' }, {}, 20)).toBeCloseTo(16.5);
  });

  it('gives labels white text with a dark halo in hybrid mode', () => {
    const label = withHybridStyling(
      paintLayer({
        id: 'label_city',
        type: 'symbol',
        layout: { 'text-field': '{name}' },
        paint: { 'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 0.8 },
      }),
    );
    const textColor = latest.paint_symbol['text-color'];
    expect(rgb(evaluate(label.paint['text-color'], textColor, { base: 'map' }))).toEqual([51, 51, 51]);
    expect(rgb(evaluate(label.paint['text-color'], textColor, { base: 'hybrid' }))).toEqual([255, 255, 255]);
    expect(evaluate(label.paint['text-halo-width'], latest.paint_symbol['text-halo-width'], { base: 'hybrid' })).toBe(
      1.2,
    );
  });

  it('leaves layers hidden in hybrid mode alone', () => {
    const water = paintLayer({ id: 'water', type: 'fill', paint: { 'fill-color': '#9ebdff' } });
    expect(withHybridStyling(water)).toBe(water);
  });
});

describe('label language', () => {
  const textField = latest.layout_symbol['text-field'];
  // OpenFreeMap's bilingual city label.
  const BILINGUAL = [
    'case',
    ['has', 'name:nonlatin'],
    ['concat', ['get', 'name:latin'], '\n', ['get', 'name:nonlatin']],
    ['coalesce', ['get', 'name_en'], ['get', 'name']],
  ];
  const SHANGHAI = { name: '上海市', 'name:zh': '上海', 'name:latin': 'Shanghai', 'name:nonlatin': '上海市' };
  const text = (value: unknown, settings: Partial<MapLayerSettings>, properties: object) =>
    (evaluate(value, textField, settings, properties) as { sections: Array<{ text: string }> }).sections
      .map((section) => section.text)
      .join('');

  it('switches base map labels between the bilingual default, local names and a fixed language', () => {
    const label = withBaseMapLabelLanguage({ id: 'label_city', type: 'symbol', layout: { 'text-field': BILINGUAL } });
    const field = label.layout['text-field'];
    expect(text(field, { labels: 'bilingual' }, SHANGHAI)).toBe('Shanghai\n上海市');
    expect(text(field, { labels: 'local' }, SHANGHAI)).toBe('上海市');
    expect(text(field, { labels: 'zh' }, SHANGHAI)).toBe('上海');
    expect(text(field, { labels: 'de' }, { name: 'Paris', name_de: 'Paris (de)' })).toBe('Paris (de)');
    expect(text(field, { labels: 'ja' }, { name: 'Paris' })).toBe('Paris');
  });

  it('leaves labels that do not show names alone', () => {
    const shield = { id: 'road_shield', type: 'symbol', layout: { 'text-field': ['to-string', ['get', 'ref']] } };
    expect(withBaseMapLabelLanguage(shield)).toBe(shield);
  });

  it('prefers translated station names when the tiles carry them', () => {
    const station = withRailwayLabelLanguage({
      id: 'stations',
      type: 'symbol',
      layout: { 'text-field': ['step', ['zoom'], ['get', 'label'], 10, ['get', 'localized_name']] },
    });
    const field = station.layout['text-field'];
    expect(text(field, { labels: 'en' }, { localized_name: '上海', 'name:en': 'Shanghai' })).toBe('Shanghai');
    expect(text(field, { labels: 'en' }, { localized_name: '上海' })).toBe('上海');
    expect(text(field, { labels: 'local' }, { localized_name: '上海', 'name:en': 'Shanghai' })).toBe('上海');
  });

  it('keeps the generated railway style valid', () => {
    const orm = JSON.parse(ormStyleText);
    orm.layers = orm.layers.map(withRailwayLabelLanguage);
    expect(validateStyleMin(applyMapLayerState(orm, defaultMapLayerSettings()))).toEqual([]);
  });
});

describe('map layer settings', () => {
  it('seeds global state defaults from the settings', () => {
    const style = applyMapLayerState(
      { state: {} },
      { base: 'hybrid', saturation: 0.4, labels: 'en', hillshade: false, contours: true, terrain3d: true },
    );
    expect(style.state).toEqual({
      baseMap: { default: 'hybrid' },
      baseSaturation: { default: 0.4 },
      labelLanguage: { default: 'en' },
      showHillshade: { default: false },
      showContours: { default: true },
    });
  });

  it('normalizes stored values and survives broken storage', () => {
    expect(
      normalizeMapLayerSettings({ base: 'terrain', hillshade: 'yes', terrain3d: true, saturation: 3, labels: 'xx' }),
    ).toEqual({ ...defaultMapLayerSettings(), terrain3d: true, saturation: 1 });
    expect(normalizeMapLayerSettings({ saturation: 0.25, labels: 'ja' })).toMatchObject({
      saturation: 0.25,
      labels: 'ja',
    });
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const settings: MapLayerSettings = {
      base: 'satellite',
      saturation: 0.3,
      labels: 'local',
      hillshade: false,
      contours: false,
      terrain3d: true,
    };
    saveMapLayerSettings(settings, storage);
    expect(loadMapLayerSettings(storage)).toEqual(settings);
    const throwing = {
      getItem: (): string => {
        throw new Error('blocked');
      },
    };
    expect(loadMapLayerSettings(throwing)).toEqual(defaultMapLayerSettings());
  });
});
