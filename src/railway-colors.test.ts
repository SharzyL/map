import { createExpression, latest, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import ormStyleText from '../public/orm/style/standard.json?raw';
import {
  RAILWAY_COLOR_CLASS_EXPRESSIONS,
  RAILWAY_COLOR_LEGENDS,
  RAILWAY_COLOR_STATE,
  RECOLOR_METADATA,
  applyRailwayColorMode,
  withRailwayLineColors,
  withRailwayStationColors,
  type RailwayColorMode,
  type RailwayLegendMode,
} from './railway-colors.js';

type Properties = Record<string, string | number | boolean>;

const CLASS_SPEC = {
  type: 'string',
  'property-type': 'data-driven',
  expression: { interpolated: false, parameters: ['zoom', 'feature'] },
};

function evaluate(
  value: unknown,
  spec: unknown,
  properties: Properties,
  state: Record<string, unknown> = {},
  featureState: Record<string, unknown> = {},
) {
  const parsed = createExpression(value, spec as never, state);
  expect(parsed.result).toBe('success');
  return (parsed.value as { evaluate(globals: object, feature: object, featureState: object): unknown }).evaluate(
    { zoom: 12 },
    { type: 2, properties },
    featureState,
  );
}

function classify(mode: RailwayLegendMode, properties: Properties) {
  return evaluate(RAILWAY_COLOR_CLASS_EXPRESSIONS[mode], CLASS_SPEC, properties);
}

function hex(color: unknown) {
  const { r, g, b } = color as { r: number; g: number; b: number };
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function legendColor(mode: RailwayLegendMode, key: string) {
  return RAILWAY_COLOR_LEGENDS[mode].find((entry) => entry.key === key).color;
}

describe('railway color classes', () => {
  it('bands speeds at the filter thresholds', () => {
    expect(classify('speed', { maxspeed: 60 })).toBe('lt80');
    expect(classify('speed', { maxspeed: 80 })).toBe('80');
    expect(classify('speed', { maxspeed: 199 })).toBe('160');
    expect(classify('speed', { maxspeed: 250 })).toBe('250');
    expect(classify('speed', { maxspeed: 300 })).toBe('300');
    expect(classify('speed', { maxspeed: 350 })).toBe('350');
    expect(classify('speed', { maxspeed: 380 })).toBe('gt350');
    expect(classify('speed', {})).toBe('unknown');
  });

  it('sorts electrified lines by system', () => {
    const present = { electrification_state: 'present' };
    expect(classify('electrification', { ...present, voltage: 25000, frequency: 50 })).toBe('ac25');
    expect(classify('electrification', { ...present, voltage: 20000, frequency: 60 })).toBe('ac25');
    expect(classify('electrification', { ...present, voltage: 15000, frequency: 16.7 })).toBe('ac15');
    expect(classify('electrification', { ...present, voltage: 15000 })).toBe('ac15');
    expect(classify('electrification', { ...present, voltage: 11000, frequency: 25 })).toBe('ac-other');
    expect(classify('electrification', { ...present, voltage: 3000, frequency: 0 })).toBe('dc3');
    expect(classify('electrification', { ...present, voltage: 1500, frequency: 0 })).toBe('dc1500');
    expect(classify('electrification', { ...present, voltage: 1500 })).toBe('dc1500');
    expect(classify('electrification', { ...present, voltage: 750, frequency: 0 })).toBe('dc-low');
    expect(classify('electrification', present)).toBe('electrified');
    expect(classify('electrification', { electrification_state: 'no' })).toBe('none');
    expect(classify('electrification', { electrification_state: 'deelectrified', voltage: 3000 })).toBe('none');
    expect(classify('electrification', {})).toBe('unknown');
  });

  it('sorts lines by their first gauge', () => {
    expect(classify('gauge', { gaugeint0: 600 })).toBe('narrow');
    expect(classify('gauge', { gaugeint0: 1000 })).toBe('metre');
    expect(classify('gauge', { gaugeint0: 1067 })).toBe('cape');
    expect(classify('gauge', { gaugeint0: 1372 })).toBe('scotch');
    expect(classify('gauge', { gaugeint0: 1435 })).toBe('standard');
    expect(classify('gauge', { gaugeint0: 1432 })).toBe('standard');
    expect(classify('gauge', { gaugeint0: 1520 })).toBe('russian');
    expect(classify('gauge', { gaugeint0: 1524 })).toBe('russian');
    expect(classify('gauge', { gaugeint0: 1600 })).toBe('irish');
    expect(classify('gauge', { gaugeint0: 1668, gaugeint1: 1435 })).toBe('iberian');
    expect(classify('gauge', { gaugeint0: 1676 })).toBe('iberian');
    expect(classify('gauge', { gaugeint0: 1200 })).toBe('other');
    expect(classify('gauge', { gaugeint0: 2000 })).toBe('other');
    expect(classify('gauge', {})).toBe('unknown');
  });

  it('sorts lines by their number of tracks', () => {
    expect(classify('tracks', { tracks: 1 })).toBe('1');
    expect(classify('tracks', { tracks: 2 })).toBe('2');
    expect(classify('tracks', { tracks: 3 })).toBe('3');
    expect(classify('tracks', { tracks: 6 })).toBe('4plus');
    expect(classify('tracks', { tracks: 0 })).toBe('unknown');
    expect(classify('tracks', {})).toBe('unknown');
  });

  it('has one legend entry per class', () => {
    for (const entries of Object.values(RAILWAY_COLOR_LEGENDS)) {
      const keys = entries.map(({ key }) => key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('withRailwayLineColors', () => {
  const ormStyle = JSON.parse(ormStyleText) as StyleSpecification;
  const layers = ormStyle.layers as Array<{ id: string; paint?: Record<string, unknown> }>;
  const layer = (id: string) => layers.find((candidate) => candidate.id === id);
  const lineColor = latest.paint_line['line-color'];
  const colorOf = (id: string, mode: RailwayColorMode, properties: Properties, hover = false) =>
    hex(
      evaluate(
        withRailwayLineColors(layer(id), mode).paint['line-color'],
        lineColor,
        properties,
        { [RAILWAY_COLOR_STATE]: mode, theme: 'light' },
        { hover },
      ),
    );

  it('recolors fills and direction arrows of lines in use only', () => {
    const recolored = layers
      .filter((candidate) => withRailwayLineColors(candidate, 'default') !== candidate)
      .map(({ id }) => id);
    expect(recolored).toContain('railway_line_main_low_fill_present');
    expect(recolored).toContain('railway_line_main_high_bridge_fill_construction');
    expect(recolored).toContain('railway_line_light_rail_tunnel_fill_proposed');
    expect(recolored).toContain('railway_line_main_high_preferred_direction');
    expect(recolored).not.toContain('railway_line_main_high_casing_present');
    expect(recolored).not.toContain('railway_line_abandoned_fill_abandoned');
    expect(recolored).not.toContain('railway_ferry_high_fill_present');
    expect(recolored.length).toBeGreaterThan(140);
  });

  it('keeps the usage colors and colors by the chosen attribute otherwise', () => {
    const id = 'railway_line_main_high_fill_present';
    const line = { feature: 'rail', usage: 'main', state: 'present', maxspeed: 300, gaugeint0: 1520 };
    const original = hex(evaluate(layer(id).paint['line-color'], lineColor, line, {}, { hover: false }));
    expect(colorOf(id, 'usage', line)).toBe(original);
    expect(colorOf(id, 'speed', line)).toBe(legendColor('speed', '300'));
    expect(colorOf(id, 'gauge', line)).toBe(legendColor('gauge', 'russian'));
    expect(colorOf(id, 'electrification', line)).toBe(legendColor('electrification', 'unknown'));
  });

  it('draws lines in their route color by default', () => {
    const id = 'railway_line_light_rail_fill_present';
    const line = { feature: 'subway', usage: 'main', state: 'present' };
    const usage = colorOf(id, 'usage', line);
    expect(colorOf(id, 'default', { ...line, line_color: '#178ABB' })).toBe('#178abb');
    expect(colorOf(id, 'default', { ...line, line_color: 'red' })).toBe('#ff0000');
    expect(colorOf(id, 'default', line)).toBe(usage);
    expect(colorOf(id, 'default', { ...line, line_color: 'Line 1 color' })).toBe(usage);
    // The export works line_color out, route lists included.
    expect(colorOf(id, 'default', { ...line, line_routes: '1\u001e#01AAAA\u001eThrough service' })).toBe(usage);
  });

  it('draws service tracks without a route color in gray by default', () => {
    const id = 'railway_line_light_rail_fill_present';
    const depot = { feature: 'subway', state: 'present', service: 'yard' };
    expect(colorOf(id, 'default', depot)).toBe('#9a9a9a');
    expect(colorOf(id, 'default', depot, true)).toBe('#ff0000');
    expect(colorOf(id, 'default', { ...depot, line_color: '#178ABB' })).toBe('#178abb');
    expect(colorOf(id, 'usage', depot)).toBe(colorOf(id, 'usage', { feature: 'subway', state: 'present' }));
  });

  it('hovers red routes in amber', () => {
    const id = 'railway_line_light_rail_fill_present';
    const line = { feature: 'subway', usage: 'main', state: 'present' };
    expect(colorOf(id, 'default', { ...line, line_color: '#c23a30' }, true)).toBe('#ffc107');
    expect(colorOf(id, 'default', { ...line, line_color: '#178ABB' }, true)).toBe('#ff0000');
    expect(colorOf(id, 'default', line, true)).toBe('#ff0000');
  });

  it('builds one mode at a time and switches through the original color it keeps', () => {
    const id = 'railway_line_main_high_fill_present';
    const original = layer(id).paint['line-color'];
    const built = withRailwayLineColors(layer(id), 'default') as {
      metadata?: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    expect(built.metadata?.[RECOLOR_METADATA]).toEqual({ property: 'line-color', original });
    expect(JSON.stringify(built.paint['line-color'])).not.toContain('railwayColorBy');
    expect(JSON.stringify(withRailwayLineColors(layer(id), 'usage').paint['line-color'])).toBe(
      JSON.stringify(original),
    );

    const painted: Array<[string, string, unknown]> = [];
    const styleLayers = new Map<string, { metadata?: unknown }>([
      [id, built],
      ['background', {}],
    ]);
    applyRailwayColorMode(
      {
        getLayersOrder: () => [...styleLayers.keys()],
        getLayer: (layerId) => styleLayers.get(layerId),
        setPaintProperty: (layerId, name, value) => painted.push([layerId, name, value]),
      },
      'speed',
    );
    expect(painted).toHaveLength(1);
    const [layerId, name, value] = painted[0];
    expect([layerId, name]).toEqual([id, 'line-color']);
    const line = { feature: 'rail', usage: 'main', state: 'present', maxspeed: 300 };
    expect(hex(evaluate(value, lineColor, line, { theme: 'light' }, { hover: false }))).toBe(
      legendColor('speed', '300'),
    );
  });

  it('draws lines in their operator color, gray without an operator', () => {
    const id = 'railway_line_main_high_fill_present';
    const line = { feature: 'rail', usage: 'main', state: 'present' };
    expect(colorOf(id, 'operator', { ...line, operator_color: '#e3001b' })).toBe('#e3001b');
    // Hashed hues come as hsl() from the database.
    expect(colorOf(id, 'operator', { ...line, operator_color: 'hsl(120, 100%, 30%)' })).toBe('#009900');
    expect(colorOf(id, 'operator', line)).toBe('#b8b8b8');
    expect(colorOf(id, 'operator', { ...line, operator_color: '#e3001b' }, true)).toBe('#ffc107');
    expect(colorOf(id, 'operator', { ...line, operator_color: '#0072b2' }, true)).toBe('#ff0000');
  });

  it('uses a hover color that stands out from the line color', () => {
    const id = 'railway_line_main_high_fill_present';
    const line = { feature: 'rail', usage: 'main', state: 'present', gaugeint0: 1435 };
    expect(colorOf(id, 'gauge', line, true)).toBe('#ff0000');
    expect(colorOf(id, 'gauge', { ...line, gaugeint0: 1520 }, true)).toBe('#ffc107');
  });
});

describe('withRailwayStationColors', () => {
  const ormStyle = JSON.parse(ormStyleText) as StyleSpecification;
  const station = withRailwayStationColors(
    ormStyle.layers.find(({ id }) => id === 'railway_text_stations') as unknown as {
      id: string;
      paint: Record<string, unknown>;
      layout: Record<string, unknown>;
    },
  );
  const state = (mode: RailwayColorMode) => ({ [RAILWAY_COLOR_STATE]: mode, theme: 'light' });
  const iconColor = (mode: RailwayColorMode, properties: Properties) =>
    hex(evaluate(station.paint['icon-color'], latest.paint_symbol['icon-color'], properties, state(mode), {}));
  const haloColor = (properties: Properties, hover = false) =>
    hex(
      evaluate(station.paint['icon-halo-color'], latest.paint_symbol['icon-halo-color'], properties, state('default'), {
        hover,
      }),
    );
  const iconImage = (mode: RailwayColorMode, properties: Properties) =>
    (
      evaluate(station.layout['icon-image'], latest.layout_symbol['icon-image'], properties, state(mode)) as {
        name: string;
      }
    ).name;
  const stop = { feature: 'station', state: 'present', station_size: 'normal' };
  const onLine = { ...stop, station_kind: 'line', station_color: '#178abb' };
  const interchange = { ...stop, station_kind: 'interchange', station_color: '#178abb' };

  it('draws a station on one line as a dot in the line color', () => {
    expect(iconImage('default', onLine)).toBe('sdf:general/station-normal');
    expect(iconColor('default', onLine)).toBe('#178abb');
    expect(haloColor(onLine)).toBe('#ffffff');
  });

  it('draws an interchange between lines of different colors as a ringed white dot', () => {
    expect(iconImage('default', interchange)).toBe('sdf:general/station-normal');
    expect(iconColor('default', interchange)).toBe('#ffffff');
    expect(haloColor(interchange)).toBe('#334155');
    expect(haloColor(interchange, true)).toBe('#ffff00');
  });

  it('draws other stations as gray dots', () => {
    expect(iconColor('usage', onLine)).toBe('#3f3f46');
    expect(iconColor('default', stop)).toBe('#3f3f46');
    expect(iconColor('default', { ...stop, station_kind: 'plain' })).toBe('#3f3f46');
    expect(iconColor('default', { ...stop, station_kind: 'inactive', state: 'construction' })).toBe('#a1a1aa');
    expect(iconImage('usage', { ...stop, station_size: 'small' })).toBe('sdf:general/station-normal');
  });

  it('rings interchanges in every mode', () => {
    expect(iconColor('speed', interchange)).toBe('#ffffff');
    expect(haloColor(interchange)).toBe('#334155');
  });
});
