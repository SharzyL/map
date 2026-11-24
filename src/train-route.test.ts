import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it, vi } from 'vitest';
import { decodePolyline, type TrainRoute } from './norikae.js';
import { NO_TRAIN_WAYS, TRAIN_ROUTE_SOURCE, TRAIN_ROUTE_STATE, TRAIN_STOPS_STATE } from './route-highlight.js';
import { framedBy, installTrainRoute, sketchFeatures, trainRouteFeatures, trainWaysFilter } from './train-route.js';

const ROUTE: TrainRoute = {
  data_version: '2026-11-12T16:00:00Z',
  bbox: [116.3, 31.19, 121.33, 39.87],
  ways: [43046288, 43046300, 43046288],
  partial: ['_p~iF~ps|U_ulLnnqC'],
  overview: ['_p~iF~ps|U_ulLnnqC_mqNvxq`@'],
  stops: [
    { name: '北京南', position: [116.37, 39.86], elements: ['N539260172'] },
    { name: '济南西', position: null, elements: null },
  ],
  legs: [
    { from: '北京南', to: '济南西', line: '京沪高速线', method: 'line' },
    { from: '济南西', to: '上海虹桥', line: null, method: 'straight', straight: '_p~iF~ps|U_ulLnnqC' },
  ],
};

describe('decodePolyline', () => {
  it('decodes precision 6 and other precisions as [lon, lat]', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
    expect(decodePolyline('_p~iF~ps|U')).toEqual([[-12.02, 3.85]]);
  });
});

describe('trainRouteFeatures', () => {
  it('draws the outline, partial ways, straight legs and placed stops', () => {
    const features = trainRouteFeatures(ROUTE, '北京南').features;
    expect(features.map(({ properties }) => properties.kind)).toEqual(['overview', 'partial', 'straight', 'stop']);
    expect(features[3].properties).toEqual({
      kind: 'stop',
      name: '北京南',
      elements: 'N539260172',
      rank: 0,
      here: true,
      end: true,
    });
  });
});

// The stops of a train from 北京南 to 上海虹桥, one without a place
const STOPS = [
  { name: '北京南', position: [116.38, 39.86] as [number, number], elements: ['N539260172'] },
  { name: '济南西', position: null, elements: null },
  { name: '南京南', position: [118.8, 31.97] as [number, number], elements: ['N2'] },
  { name: '上海虹桥', position: [121.32, 31.19] as [number, number], elements: ['N3'] },
];

describe('sketchFeatures', () => {
  it('joins the placed stops in order, until the route comes', () => {
    const { features } = sketchFeatures(STOPS, '北京南');
    expect(features.map(({ properties }) => properties.kind)).toEqual(['sketch', 'stop', 'stop', 'stop']);
    expect(features[0].geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [116.38, 39.86],
        [118.8, 31.97],
        [121.32, 31.19],
      ],
    });
    // One placed stop: nothing to join
    expect(sketchFeatures(STOPS.slice(0, 2), null).features.map(({ properties }) => properties.kind)).toEqual(['stop']);
  });

  it('tells a route the stops framed from one going further', () => {
    const stops: [[number, number], [number, number]] = [
      [116.38, 31.19],
      [121.32, 39.86],
    ];
    expect(
      framedBy(
        [
          [116.3, 31.0],
          [121.5, 39.9],
        ],
        stops,
      ),
    ).toBe(true);
    expect(
      framedBy(
        [
          [113.0, 31.0],
          [121.5, 39.9],
        ],
        stops,
      ),
    ).toBe(false);
  });
});

describe('trainWaysFilter', () => {
  const picks = (filter: unknown, osmId: number) =>
    featureFilter(filter as never).filter({ zoom: 12 }, { type: 2, properties: { osm_id: osmId } } as never);

  it('picks the route’s ways from the tiles, or none', () => {
    expect(picks(trainWaysFilter([43046288, 43046300]), 43046300)).toBe(true);
    expect(picks(trainWaysFilter([43046288, 43046300]), 1)).toBe(false);
    expect(trainWaysFilter([])).toEqual(NO_TRAIN_WAYS);
  });
});

describe('installTrainRoute', () => {
  it('filters the way layers, fills the source, dims other railways and fits the map, then clears', () => {
    const source = { setData: vi.fn() };
    const state: Record<string, unknown> = {};
    const map = {
      _styleInitialized: true,
      isStyleLoaded: () => true,
      once: () => {},
      setGlobalStateProperty: (name: string, value: unknown) => (state[name] = value),
      getStyle: () => ({ layers: [{ id: 'train_route_casing_0' }, { id: 'train_route_line_0' }, { id: 'other' }] }),
      getSource: (id: string) => (id === TRAIN_ROUTE_SOURCE ? source : undefined),
      setFilter: vi.fn(),
      fitBounds: vi.fn(),
    };
    const drawer = installTrainRoute(map);
    drawer.show(ROUTE, '北京南', { top: 1, right: 2, bottom: 3, left: 4 });
    expect(map.setFilter.mock.calls.map(([id]) => id)).toEqual(['train_route_casing_0', 'train_route_line_0']);
    expect(map.setFilter.mock.calls[0][1]).toEqual(trainWaysFilter([43046288, 43046300]));
    expect(state[TRAIN_ROUTE_STATE]).toBe(true);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [116.3, 31.19],
        [121.33, 39.87],
      ],
      expect.objectContaining({ padding: { top: 1, right: 2, bottom: 3, left: 4 } }),
    );
    drawer.clear();
    expect(map.setFilter).toHaveBeenLastCalledWith('train_route_line_0', NO_TRAIN_WAYS);
    expect(source.setData).toHaveBeenLastCalledWith({ type: 'FeatureCollection', features: [] });
    expect(state[TRAIN_ROUTE_STATE]).toBe(false);
  });

  it('sketches the stops first, then puts the route in their place without moving the map again', () => {
    const source = { setData: vi.fn() };
    const state: Record<string, unknown> = {};
    const map = {
      _styleInitialized: true,
      isStyleLoaded: () => true,
      once: () => {},
      setGlobalStateProperty: (name: string, value: unknown) => (state[name] = value),
      getStyle: () => ({ layers: [{ id: 'train_route_line_0' }] }),
      getSource: (id: string) => (id === TRAIN_ROUTE_SOURCE ? source : undefined),
      setFilter: vi.fn(),
      fitBounds: vi.fn(),
    };
    const padding = { top: 1, right: 2, bottom: 3, left: 4 };
    const drawer = installTrainRoute(map);
    drawer.sketch(STOPS, '北京南', padding);
    expect(source.setData.mock.lastCall[0].features[0].properties.kind).toBe('sketch');
    expect(map.setFilter).toHaveBeenLastCalledWith('train_route_line_0', NO_TRAIN_WAYS);
    // Other railways dim, and the stops' own labels give way, as for the route
    expect(state[TRAIN_ROUTE_STATE]).toBe(true);
    expect(state[TRAIN_STOPS_STATE]).toEqual(['北京南', 'N539260172', '济南西', '南京南', 'N2', '上海虹桥', 'N3']);
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.fitBounds).toHaveBeenLastCalledWith(
      [
        [116.38, 31.19],
        [121.32, 39.86],
      ],
      expect.objectContaining({ padding }),
    );
    // The route lies where the stops are: drawn, the map stays
    drawer.show(ROUTE, '北京南', padding);
    expect(source.setData.mock.lastCall[0].features.map((f: GeoJSON.Feature) => f.properties.kind)).not.toContain(
      'sketch',
    );
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    // A route going well past its stops' frame moves it
    drawer.sketch(STOPS.slice(2), null, padding);
    drawer.show({ ...ROUTE, bbox: [110, 25, 121.33, 39.87] }, null, padding);
    expect(map.fitBounds).toHaveBeenCalledTimes(3);
    // Once the route has replaced the sketch, a failure has nothing to dash
    source.setData.mockClear();
    drawer.unrouted();
    expect(source.setData).not.toHaveBeenCalled();
    // A route that cannot be had leaves the sketch, dashed as a leg without a path
    drawer.sketch(STOPS, '北京南', padding);
    drawer.unrouted();
    const kinds = source.setData.mock.lastCall[0].features.map((f: GeoJSON.Feature) => f.properties.kind);
    expect(kinds).toEqual(['straight', 'stop', 'stop', 'stop']);
    expect(state[TRAIN_ROUTE_STATE]).toBe(true);
    // No placed stop, no sketch
    drawer.clear();
    source.setData.mockClear();
    drawer.sketch([{ name: '济南西', position: null }], null, padding);
    expect(source.setData).not.toHaveBeenCalled();
  });
});
