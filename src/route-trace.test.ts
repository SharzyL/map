import Pbf from 'pbf';
import { describe, expect, it } from 'vitest';
import { routeListHasRoute, tilesInBounds, traceRoute } from './route-trace.js';

type TestFeature = { routes: string; line: Array<[number, number]> };

const zigzag = (value: number) => (value << 1) ^ (value >> 31);

// A minimal MVT with one `railway_line_high` layer of LineStrings carrying a
// `line_routes` attribute, enough for the tracer to read.
function encodeTile(features: TestFeature[]) {
  const values = [...new Set(features.map((feature) => feature.routes))];
  const pbf = new Pbf();
  pbf.writeMessage(
    3,
    (_: unknown, layer: Pbf) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, 'railway_line_high');
      features.forEach((feature, index) => {
        layer.writeMessage(
          2,
          (__: unknown, out: Pbf) => {
            out.writeVarintField(1, index + 1);
            out.writePackedVarint(2, [0, values.indexOf(feature.routes)]);
            out.writeVarintField(3, 2);
            const geometry = [(1 << 3) | 1];
            let [cx, cy] = [0, 0];
            feature.line.forEach(([x, y], pointIndex) => {
              if (pointIndex === 1) geometry.push(((feature.line.length - 1) << 3) | 2);
              geometry.push(zigzag(x - cx), zigzag(y - cy));
              [cx, cy] = [x, y];
            });
            out.writePackedVarint(4, geometry);
          },
          null,
        );
      });
      layer.writeStringField(3, 'line_routes');
      values.forEach((value) => layer.writeMessage(4, (__: unknown, out: Pbf) => out.writeStringField(1, value), null));
      layer.writeVarintField(5, 4096);
    },
    null,
  );
  const bytes = pbf.finish();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const ROUTE = '12231217\u001e#BBA786\u001e15号线：顾村公园 -> 紫竹高新区';
const OTHER = '42\u001e#000000\u001eOther';

describe('routeListHasRoute', () => {
  it('matches whole route ids in a route list', () => {
    expect(routeListHasRoute(`${OTHER}\u001d${ROUTE}`, '12231217')).toBe(true);
    expect(routeListHasRoute(ROUTE, '1223121')).toBe(false);
    expect(routeListHasRoute(undefined, '12231217')).toBe(false);
  });
});

describe('tilesInBounds', () => {
  it('lists the z7 tiles covering a box', () => {
    expect(tilesInBounds(121.2, 31.0, 121.6, 31.4)).toEqual([[107, 52]]);
    expect(tilesInBounds(-1, 50, 1, 51)).toEqual([
      [63, 42],
      [63, 43],
      [64, 42],
      [64, 43],
    ]);
  });
});

describe('traceRoute', () => {
  it('follows the route into neighbouring tiles and ignores other routes', async () => {
    const tiles: Record<string, ArrayBuffer> = {
      '7/107/52': encodeTile([
        {
          routes: ROUTE,
          line: [
            [1000, 2000],
            [4096 + 40, 2100],
          ],
        },
        {
          routes: OTHER,
          line: [
            [1000, 0],
            [1000, -40],
          ],
        },
      ]),
      '7/108/52': encodeTile([
        {
          routes: ROUTE,
          line: [
            [-40, 2100],
            [900, 4096 + 40],
          ],
        },
      ]),
      '7/108/53': encodeTile([
        {
          routes: ROUTE,
          line: [
            [900, -40],
            [1200, 300],
          ],
        },
      ]),
      '7/107/51': encodeTile([
        {
          routes: OTHER,
          line: [
            [0, 0],
            [10, 10],
          ],
        },
      ]),
    };
    const fetched: string[] = [];
    const geometry = await traceRoute('12231217', [[107, 52]], async (z, x, y) => {
      fetched.push(`${z}/${x}/${y}`);
      return tiles[`${z}/${x}/${y}`] ?? null;
    });
    expect(fetched.sort()).toEqual(['7/107/52', '7/108/52', '7/108/53']);
    expect(geometry.features).toHaveLength(3);
    const [start] = (geometry.features[0].geometry as GeoJSON.LineString).coordinates;
    expect(start[0]).toBeGreaterThan(120);
    expect(start[0]).toBeLessThan(123);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const geometry = await traceRoute('1', [[0, 0]], async () => encodeTile([]), controller.signal);
    expect(geometry.features).toEqual([]);
  });
});
