import { createExpression, latest, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import ormStyleText from '../public/orm/style/standard.json?raw';
import {
  RAILWAY_COLOR_CLASS_EXPRESSIONS,
  RAILWAY_COLOR_LEGENDS,
  RAILWAY_COLOR_STATE,
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
        withRailwayLineColors(layer(id)).paint['line-color'],
        lineColor,
        properties,
        { [RAILWAY_COLOR_STATE]: mode },
        { hover },
      ),
    );

  it('recolors fills and direction arrows of lines in use only', () => {
    const recolored = layers.filter((candidate) => withRailwayLineColors(candidate) !== candidate).map(({ id }) => id);
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
    const routes = (...colors: string[]) =>
      colors.map((color, index) => `${index + 1}\u001e${color}\u001eLine ${index + 1}`).join('\u001d');
    expect(colorOf(id, 'default', { ...line, line_routes: routes('#178ABB', '#00997A') })).toBe('#178abb');
    expect(colorOf(id, 'default', { ...line, line_routes: routes('', '', 'red') })).toBe('#ff0000');
    expect(colorOf(id, 'default', line)).toBe(usage);
    expect(colorOf(id, 'default', { ...line, line_routes: routes('', '') })).toBe(usage);
    expect(colorOf(id, 'default', { ...line, line_routes: routes('', '', '', '', '#178ABB') })).toBe(usage);
    expect(colorOf(id, 'default', { ...line, line_routes: routes('Line 1 color') })).toBe(usage);
  });

  it('hovers red routes in amber', () => {
    const id = 'railway_line_light_rail_fill_present';
    const line = { feature: 'subway', usage: 'main', state: 'present' };
    const route = (color: string) => ({ ...line, line_routes: `1\u001e${color}\u001eLine 1` });
    expect(colorOf(id, 'default', route('#c23a30'), true)).toBe('#ffc107');
    expect(colorOf(id, 'default', route('#178ABB'), true)).toBe('#ff0000');
    expect(colorOf(id, 'default', line, true)).toBe('#ff0000');
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
  const routes = (...colors: string[]) =>
    colors.map((color, index) => `${index + 1}\u001e${color}\u001eRoute ${index + 1}`).join('\u001d');
  const stop = { feature: 'station', state: 'present', station_size: 'normal' };

  it('draws a station on one line as a dot in the line color', () => {
    // Two shades of the same line count as one.
    const properties = { ...stop, station_routes: routes('#178ABB', '', '#178abb', '#2a90c0') };
    expect(iconImage('default', properties)).toBe('sdf:general/station-normal');
    expect(iconColor('default', properties)).toBe('#178abb');
    expect(haloColor(properties)).toBe('#ffffff');
  });

  it('draws an interchange between lines of different colors as a ringed white dot', () => {
    const properties = { ...stop, station_routes: routes('#178ABB', '#178ABB', 'red') };
    expect(iconImage('default', properties)).toBe('sdf:general/station-normal');
    expect(iconColor('default', properties)).toBe('#ffffff');
    expect(haloColor(properties)).toBe('#334155');
    expect(haloColor(properties, true)).toBe('#ffff00');
  });

  it('draws other stations as gray dots', () => {
    const colored = { ...stop, station_routes: routes('#178ABB') };
    expect(iconColor('usage', colored)).toBe('#3f3f46');
    expect(iconColor('default', stop)).toBe('#3f3f46');
    expect(iconColor('default', { ...stop, station_routes: routes('', '') })).toBe('#3f3f46');
    expect(iconColor('default', { ...colored, state: 'construction' })).toBe('#a1a1aa');
    expect(iconImage('usage', { ...stop, station_size: 'small' })).toBe('sdf:general/station-normal');
    expect(iconImage('default', { ...colored, state: 'construction' })).toBe('sdf:general/station-normal');
  });

  it('rings interchanges in every mode', () => {
    const properties = { ...stop, station_routes: routes('#178ABB', 'red') };
    expect(iconColor('speed', properties)).toBe('#ffffff');
    expect(haloColor(properties)).toBe('#334155');
  });
});
