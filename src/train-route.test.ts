import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it, vi } from 'vitest';
import { decodePolyline, type TrainRoute } from './norikae.js';
import { NO_TRAIN_WAYS, TRAIN_ROUTE_SOURCE, TRAIN_ROUTE_STATE } from './route-highlight.js';
import { installTrainRoute, trainRouteFeatures, trainWaysFilter } from './train-route.js';

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
    expect(features[3].properties).toEqual({ kind: 'stop', name: '北京南', here: true });
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
});
