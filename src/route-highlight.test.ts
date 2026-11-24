import {
  createExpression,
  featureFilter,
  latest,
  validateStyleMin,
  type StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import ormStyleText from '../public/orm/style/standard.json?raw';
import {
  addRouteHighlightToStyle,
  ROUTE_HIGHLIGHT_COLOR_STATE,
  ROUTE_HIGHLIGHT_ID_STATE,
  ROUTE_STOPS_STATE,
  routeListFilter,
  STOP_LABEL_ORDER,
  stopKeys,
  TRAIN_ROUTE_STATE,
  TRAIN_STOPS_STATE,
} from './route-highlight.js';

// Two Shanghai Metro line 11 routes on one segment (OpenRailwayMap tiles).
const LINE_ROUTES =
  '5611108\u001e#76232F\u001e11号线：迪士尼 -> 嘉定北\u001d5611110\u001e#76232F\u001e11号线：迪士尼 -> 花桥';

function onRoute(routeId: string, properties: Record<string, unknown>) {
  const filter = featureFilter(routeListFilter('line_routes') as never, { [ROUTE_HIGHLIGHT_ID_STATE]: routeId });
  return filter.filter({ zoom: 12 }, { type: 2, properties } as never);
}

describe('routeListFilter', () => {
  it('matches every route listed on a feature', () => {
    expect(onRoute('5611108', { line_routes: LINE_ROUTES })).toBe(true);
    expect(onRoute('5611110', { line_routes: LINE_ROUTES })).toBe(true);
  });

  it('matches whole route ids only', () => {
    expect(onRoute('561110', { line_routes: LINE_ROUTES })).toBe(false);
    expect(onRoute('611108', { line_routes: LINE_ROUTES })).toBe(false);
    expect(onRoute('76232F', { line_routes: LINE_ROUTES })).toBe(false);
  });

  it('matches nothing without a selected route or a route list', () => {
    expect(onRoute('', { line_routes: LINE_ROUTES })).toBe(false);
    expect(onRoute('5611108', {})).toBe(false);
  });
});

describe('addRouteHighlightToStyle', () => {
  const ormStyle = JSON.parse(ormStyleText) as StyleSpecification;
  const railwaySources = Object.entries(ormStyle.sources)
    .filter(([, source]) => source.type === 'vector' && typeof source.url === 'string' && source.url.startsWith('/'))
    .map(([name]) => name);
  const styled = addRouteHighlightToStyle(ormStyle, railwaySources);
  // The highlight's layers, a train route's among them; stop labels and the hovered stop go on top instead.
  const onTop = ['route_highlight_stop_labels', 'train_route_stop_labels', 'station_hover_ring', 'station_hover_label'];
  const highlight = styled.layers.filter(
    (layer) =>
      (layer.id.startsWith('route_highlight_') || layer.id.startsWith('train_route_')) && !onTop.includes(layer.id),
  );

  it('produces a valid style with the highlight state', () => {
    expect(validateStyleMin(styled)).toEqual([]);
    expect(styled.state?.[ROUTE_HIGHLIGHT_ID_STATE]).toEqual({ default: '' });
    expect(styled.state?.[ROUTE_HIGHLIGHT_COLOR_STATE]).toEqual({ default: '' });
  });

  it('places stop labels where the train was opened first, then the ends, then the busiest', () => {
    const order = createExpression(STOP_LABEL_ORDER as never);
    if (order.result !== 'success') throw new Error('invalid');
    const key = (properties: Record<string, unknown>) =>
      order.value.evaluate({ zoom: 10 }, { type: 1, properties, geometry: [] } as never) as number;
    const keys = [
      key({ here: true, end: false, rank: 0 }),
      key({ here: false, end: true, rank: 1 }),
      key({ here: false, end: false, rank: 40 }),
      key({ here: false, end: false, rank: 3 }),
      key({ here: false, end: false }),
    ];
    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
    expect(styled.layers.find((layer) => layer.id === 'route_highlight_stop_labels')).toMatchObject({
      layout: { 'symbol-sort-key': STOP_LABEL_ORDER },
    });
  });

  it('draws a train’s sketched route as its line will be drawn once it comes', () => {
    const layer = (id: string) => styled.layers.find((candidate) => candidate.id === id) as { paint?: unknown };
    expect(layer('train_route_sketch').paint).toEqual(layer('train_route_partial_line').paint);
    expect(layer('train_route_sketch_casing').paint).toEqual(layer('train_route_partial_casing').paint);
    expect(layer('train_route_sketch').paint).toEqual(layer('train_route_line_0').paint);
  });

  it('highlights lines and stations from every source and zoom that draws them', () => {
    const ranges = (prefix: string) =>
      highlight
        .filter((layer) => layer.id.startsWith(prefix))
        .map((layer) => 'source' in layer && [layer.source, layer['source-layer'], layer.minzoom, layer.maxzoom]);
    expect(ranges('route_highlight_line_')).toEqual([
      ['openrailwaymap_low', 'railway_line_high', 7, 8],
      ['high', 'railway_line_high', 8, 24],
    ]);
    expect(ranges('route_highlight_station_').map((range) => range && range[1])).toEqual([
      'standard_railway_text_stations_low',
      'standard_railway_text_stations_med',
      'standard_railway_text_stations',
    ]);
    for (const layer of highlight) {
      expect(JSON.stringify(layer.layout?.visibility)).toContain('railwayOverlay');
    }
  });

  it('highlights a line segment by its routes or its railway lines', () => {
    const line = highlight.find((layer) => layer.id === 'route_highlight_line_0');
    const matches = (id: string, properties: Record<string, unknown>) =>
      featureFilter((line as unknown as { filter: never }).filter, { [ROUTE_HIGHLIGHT_ID_STATE]: id }).filter(
        { zoom: 12 },
        {
          type: 2,
          properties,
        } as never,
      );
    const jinghu = '163022\u001e\u001e京沪线\u001e0002\u001d356778\u001e\u001e京沪高铁\u001e3002';
    expect(matches('5611108', { line_routes: LINE_ROUTES })).toBe(true);
    expect(matches('163022', { line_relations: jinghu })).toBe(true);
    expect(matches('356778', { line_routes: LINE_ROUTES, line_relations: jinghu })).toBe(true);
    expect(matches('16302', { line_relations: jinghu })).toBe(false);
    expect(matches('', { line_relations: jinghu })).toBe(false);
  });

  it('draws the highlight above every railway line and below the station labels', () => {
    const ids = styled.layers.map((layer) => layer.id);
    const first = ids.indexOf(highlight[0].id);
    expect(ids.slice(first, first + highlight.length)).toEqual(highlight.map((layer) => layer.id));
    const railwayLayer = (layer: (typeof styled.layers)[number]) =>
      'source' in layer && railwaySources.includes(layer.source as string);
    const before = styled.layers.slice(0, first);
    const after = styled.layers.slice(first + highlight.length);
    expect(before.some((layer) => railwayLayer(layer) && layer.id === 'railway_line_light_rail_tunnel_cover')).toBe(
      true,
    );
    expect(
      after.some(
        (layer) => railwayLayer(layer) && layer.type === 'line' && layer['source-layer'] === 'railway_line_high',
      ),
    ).toBe(false);
    expect(after.some((layer) => railwayLayer(layer) && layer.id === 'railway_text_stations_low1')).toBe(true);
    expect(after.some((layer) => railwayLayer(layer) && layer.id.includes('station') && layer.type === 'symbol')).toBe(
      true,
    );
  });

  it('labels the stops and marks the hovered one above every other layer', () => {
    expect(styled.layers.slice(-onTop.length).map((layer) => layer.id)).toEqual(onTop);
  });

  function opacity(
    layerId: string,
    property: string,
    routeId: string,
    properties: Record<string, unknown> = {},
    state: Record<string, unknown> = {},
  ) {
    const layer = styled.layers.find((candidate) => candidate.id === layerId);
    const value = (layer.paint as Record<string, unknown>)[property];
    const spec = latest[`paint_${layer.type}`][property];
    const expression = createExpression(value, spec);
    if (expression.result !== 'success') throw new Error(JSON.stringify(expression.value));
    return expression.value.evaluate(
      { zoom: 12, globalState: { [ROUTE_HIGHLIGHT_ID_STATE]: routeId, ...state } } as never,
      { type: 'Point', properties } as never,
    );
  }

  it('fades other railway layers only while a route is highlighted', () => {
    const line = styled.layers.find(
      (layer) => layer.type === 'line' && 'source' in layer && layer['source-layer'] === 'railway_line_high',
    );
    expect(opacity(line.id, 'line-opacity', '')).toBe(1);
    expect(opacity(line.id, 'line-opacity', '5611108')).toBeCloseTo(0.25);
  });

  // Whether a layer's filter keeps a feature.
  function shown(layerId: string, properties: Record<string, unknown>, state: Record<string, unknown> = {}) {
    const layer = styled.layers.find((candidate) => candidate.id === layerId);
    const filter = featureFilter((layer as { filter?: unknown }).filter as never, {
      [ROUTE_HIGHLIGHT_ID_STATE]: '',
      ...state,
    });
    return filter.filter({ zoom: 12 }, { type: 1, properties } as never);
  }

  it('keeps only the stations of the highlighted route or train', () => {
    const stations = styled.layers.filter(
      (layer) => 'source' in layer && layer['source-layer']?.startsWith('standard_railway_text_stations'),
    );
    expect(stations.length).toBeGreaterThan(2);
    const keys = stopKeys([{ name: '湖州东', elements: ['N123'] }]);
    const station = { railway: 'station', station_size: 'large', name: '长兴' };
    const onRoute = { ...station, station_routes: LINE_ROUTES };
    const drawing = stations.filter(({ id }) => shown(id, station));
    expect(drawing.length).toBeGreaterThan(0);
    for (const { id } of drawing) {
      expect(shown(id, onRoute, { [ROUTE_HIGHLIGHT_ID_STATE]: '5611108' })).toBe(true);
      expect(shown(id, onRoute, { [ROUTE_HIGHLIGHT_ID_STATE]: '42' })).toBe(false);
      expect(shown(id, station, { [ROUTE_HIGHLIGHT_ID_STATE]: '5611108' })).toBe(false);
      const train = { [TRAIN_ROUTE_STATE]: true, [TRAIN_STOPS_STATE]: keys };
      expect(shown(id, { ...station, name: '湖州东' }, train)).toBe(true);
      expect(shown(id, onRoute, train)).toBe(false);
    }
  });

  // A station layer's label for a feature, as text ('' when it has none).
  function stationLabel(layerId: string, properties: Record<string, unknown>, state: Record<string, unknown> = {}) {
    const layer = styled.layers.find((candidate) => candidate.id === layerId);
    const expression = createExpression(
      (layer.layout as Record<string, unknown>)['text-field'],
      latest.layout_symbol['text-field'],
    );
    if (expression.result !== 'success') throw new Error(JSON.stringify(expression.value));
    const value = expression.value.evaluate(
      {
        zoom: 12,
        globalState: { stationLowZoomLabel: 'name', [ROUTE_HIGHLIGHT_ID_STATE]: '', ...state },
      } as never,
      { type: 'Point', properties: { station_size: 'large', ...properties } } as never,
    ) as string | { sections: Array<{ text: string }> };
    return typeof value === 'string' ? value : value.sections.map(({ text }) => text).join('');
  }

  it('names the stations of a highlighted route or train by the stop labels where they can', () => {
    const stations = styled.layers.filter(
      (layer) =>
        layer.type === 'symbol' &&
        'source' in layer &&
        layer['source-layer']?.startsWith('standard_railway_text_stations') &&
        (layer.layout as Record<string, unknown>)['text-field'] !== undefined,
    );
    expect(stations.length).toBeGreaterThan(2);
    const keys = stopKeys([
      { name: '湖州东', elements: ['N123'] },
      { name: '麻城北', elements: null },
    ]);
    expect(keys).toEqual(['湖州东', 'N123', '麻城北']);
    const huzhou = { name: '湖州', localized_name: '湖州', osm_type: 'N', osm_id: '12', station_routes: LINE_ROUTES };
    const stop = { name: '湖州东', localized_name: '湖州东' };
    const other = { name: '长兴', localized_name: '长兴' };
    for (const { id } of stations) {
      // Nothing shown: every station is named.
      expect(stationLabel(id, other)).toBe('长兴');
      // A highlighted route: its stations are named, by the stop labels when
      // those name them (other stations go, see above).
      const route = { [ROUTE_HIGHLIGHT_ID_STATE]: '5611108', [ROUTE_STOPS_STATE]: keys };
      expect(stationLabel(id, huzhou, route)).toBe('湖州');
      expect(stationLabel(id, { ...stop, station_routes: LINE_ROUTES }, route)).toBe('');
      expect(stationLabel(id, { ...huzhou, osm_id: '123' }, route)).toBe('');
      // A train: its stops are named by the stop labels.
      const train = { [TRAIN_ROUTE_STATE]: true, [TRAIN_STOPS_STATE]: keys };
      expect(stationLabel(id, { name: 'Huzhou East', localized_name: '麻城北' }, train)).toBe('');
      // Their icons give way to the rings marking them.
      expect(opacity(id, 'icon-opacity', '', other)).toBe(1);
      expect(opacity(id, 'icon-opacity', '5611108', huzhou)).toBe(0);
      expect(opacity(id, 'icon-opacity', '', stop, train)).toBe(0);
    }
  });

  it('fades other labels a little while a route is highlighted', () => {
    const label = styled.layers.find(
      (layer) => layer.type === 'symbol' && 'source' in layer && !railwaySources.includes(layer.source as string),
    );
    expect(opacity(label.id, 'text-opacity', '')).toBe(1);
    expect(opacity(label.id, 'text-opacity', '5611108')).toBeCloseTo(0.6);
  });

  it('leaves the highlight and other non-railway layers at full opacity', () => {
    const original = new Map(ormStyle.layers.map((layer) => [layer.id, layer]));
    for (const layer of styled.layers) {
      if (layer.type !== 'symbol' && (!('source' in layer) || !railwaySources.includes(layer.source as string))) {
        if (original.has(layer.id)) expect(layer).toEqual(original.get(layer.id));
      }
    }
    for (const layer of highlight) expect(JSON.stringify(layer.paint)).not.toContain('0.25');
  });
});
