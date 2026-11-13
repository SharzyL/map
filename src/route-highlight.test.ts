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
  routeListFilter,
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

  function opacity(layerId: string, property: string, routeId: string, properties: Record<string, unknown> = {}) {
    const layer = styled.layers.find((candidate) => candidate.id === layerId);
    const value = (layer.paint as Record<string, unknown>)[property];
    const spec = latest[`paint_${layer.type}`][property];
    const expression = createExpression(value, spec);
    if (expression.result !== 'success') throw new Error(JSON.stringify(expression.value));
    return expression.value.evaluate(
      { zoom: 12, globalState: { [ROUTE_HIGHLIGHT_ID_STATE]: routeId } } as never,
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

  it('keeps the stations of the highlighted route fully visible and others readable', () => {
    const station = styled.layers.find(
      (layer) =>
        layer.type === 'symbol' && 'source' in layer && layer['source-layer'] === 'standard_railway_text_stations',
    );
    const onRoute = { station_routes: LINE_ROUTES };
    expect(opacity(station.id, 'text-opacity', '5611108', onRoute)).toBe(1);
    expect(opacity(station.id, 'text-opacity', '42', onRoute)).toBeCloseTo(0.6);
    expect(opacity(station.id, 'text-opacity', '', {})).toBe(1);
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
