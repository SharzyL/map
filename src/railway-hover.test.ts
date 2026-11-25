import { createExpression, latest } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import ormStyleText from '../public/orm/style/standard.json?raw';
import { addRailwayHoverToStyle, RAILWAY_HOVER_SOURCE, railwayHoverLayers, setRailwayHover } from './railway-hover.js';

describe('the hover state', () => {
  it('is gone from the style: MapLibre replays it into every tile it loads', () => {
    expect(ormStyleText).not.toContain('feature-state');
  });
});

describe('addRailwayHoverToStyle', () => {
  const style = {
    sources: { orm: { type: 'vector' } },
    layers: [
      { id: 'background', type: 'background' },
      { id: 'line_low', type: 'line', source: 'orm', 'source-layer': 'standard_railway_line_low' },
      { id: 'line_high', type: 'line', source: 'orm', 'source-layer': 'railway_line_high' },
      { id: 'stations', type: 'symbol', source: 'orm', 'source-layer': 'standard_railway_text_stations' },
    ],
  };

  it('puts the hover layers over the last railway line and under the stations', () => {
    const added = addRailwayHoverToStyle(style, ['orm']);
    expect(added.layers.map(({ id }) => id)).toEqual([
      'background',
      'line_low',
      'line_high',
      'railway_hover_area',
      'railway_hover_line',
      'railway_hover_point',
      'stations',
    ]);
    expect(added.sources).toHaveProperty(RAILWAY_HOVER_SOURCE);
  });

  it('leaves a style without railway lines alone', () => {
    expect(addRailwayHoverToStyle(style, ['other'])).toBe(style);
  });

  it('has valid paint', () => {
    for (const layer of railwayHoverLayers()) {
      const spec = (latest as Record<string, Record<string, unknown>>)[`paint_${layer.type}`];
      for (const [name, value] of Object.entries(layer.paint as Record<string, unknown>)) {
        expect(createExpression(value, spec[name] as never).result, `${layer.id} ${name}`).toBe('success');
      }
    }
  });
});

describe('setRailwayHover', () => {
  it('draws the features given, as GeoJSON, skipping those without a geometry', () => {
    const data: unknown[] = [];
    const map = {
      getSource: (id: string) => (id === RAILWAY_HOVER_SOURCE ? { setData: (d: unknown) => data.push(d) } : null),
    };
    setRailwayHover(map, [
      { geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'A' } },
      { geometry: null, properties: {} },
    ]);
    setRailwayHover(map, []);
    expect(data).toEqual([
      {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'A' } }],
      },
      { type: 'FeatureCollection', features: [] },
    ]);
  });
});
