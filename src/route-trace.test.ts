import Pbf from 'pbf';
import { describe, expect, it } from 'vitest';
import { lineListsNear, routeListHasRoute, tilesInBounds, traceRoute } from './route-trace.js';

type TestFeature = { routes: string; line: Array<[number, number]> };

const zigzag = (value: number) => (value << 1) ^ (value >> 31);

// A minimal MVT with one `railway_line_high` layer of LineStrings carrying a
// `line_routes` (or `line_relations`) attribute, enough for the tracer to read.
function encodeTile(features: TestFeature[], key = 'line_routes') {
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
      layer.writeStringField(3, key);
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

  it('follows a railway line through its line_relations', async () => {
    const jinghu = '163022\u001e\u001e京沪线\u001e0002';
    const tiles: Record<string, ArrayBuffer> = {
      '7/107/52': encodeTile(
        [
          {
            routes: jinghu,
            line: [
              [1000, 2000],
              [4096 + 40, 2100],
            ],
          },
        ],
        'line_relations',
      ),
      '7/108/52': encodeTile(
        [
          {
            routes: jinghu,
            line: [
              [-40, 2100],
              [900, 1200],
            ],
          },
        ],
        'line_relations',
      ),
    };
    const geometry = await traceRoute('163022', [[107, 52]], async (z, x, y) => tiles[`${z}/${x}/${y}`] ?? null);
    expect(geometry.features).toHaveLength(2);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const geometry = await traceRoute('1', [[0, 0]], async () => encodeTile([]), controller.signal);
    expect(geometry.features).toEqual([]);
  });
});

describe('lineListsNear', () => {
  // Three segments in z7 tile 107/52 (Shanghai): two named 京沪线 near the
  // point, one parallel line of another name just as close.
  const HERE = { lng: 121.5, lat: 31.2 };
  const tile = (features: Array<{ name: string; lines: string; routes?: string; line: Array<[number, number]> }>) => {
    // Tile pixel coordinates for a lon/lat in z7 tile 107/52.
    const px = ([lng, lat]: [number, number]) => {
      const n = 2 ** 7;
      const x = (((lng + 180) / 360) * n - 107) * 4096;
      const rad = (lat * Math.PI) / 180;
      const y = (((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n - 52) * 4096;
      return [Math.round(x), Math.round(y)] as [number, number];
    };
    const pbf = new Pbf();
    const keys = ['name', 'line_relations', 'line_routes'];
    const values = [...new Set(features.flatMap((f) => [f.name, f.lines, f.routes ?? '']))];
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
              const tags = [0, values.indexOf(feature.name), 1, values.indexOf(feature.lines)];
              if (feature.routes) tags.push(2, values.indexOf(feature.routes));
              out.writePackedVarint(2, tags);
              out.writeVarintField(3, 2);
              const points = feature.line.map(px);
              const geometry = [(1 << 3) | 1];
              let [cx, cy] = [0, 0];
              points.forEach(([x, y], pointIndex) => {
                if (pointIndex === 1) geometry.push(((points.length - 1) << 3) | 2);
                geometry.push(zigzag(x - cx), zigzag(y - cy));
                [cx, cy] = [x, y];
              });
              out.writePackedVarint(4, geometry);
            },
            null,
          );
        });
        keys.forEach((key) => layer.writeStringField(3, key));
        values.forEach((value) =>
          layer.writeMessage(4, (__: unknown, out: Pbf) => out.writeStringField(1, value), null),
        );
        layer.writeVarintField(5, 4096);
      },
      null,
    );
    const bytes = pbf.finish();
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };
  const JINGHU = '163022\u001e\u001e京沪线\u001e0002';
  const OTHER = '99\u001e\u001e沪宁城际线\u001e3015';
  const fetchTile = async () =>
    tile([
      {
        name: '京沪线',
        lines: JINGHU,
        routes: '7\u001e#f00\u001eG7',
        line: [
          [121.48, 31.21],
          [121.52, 31.21],
        ],
      },
      {
        name: '京沪线',
        lines: JINGHU,
        line: [
          [121.52, 31.21],
          [121.56, 31.22],
        ],
      },
      {
        name: '沪宁城际线',
        lines: OTHER,
        line: [
          [121.48, 31.19],
          [121.52, 31.19],
        ],
      },
    ]);

  it('takes the lists of nearby segments that share the clicked name', async () => {
    expect(await lineListsNear({ ...HERE, radius: 3000, name: '京沪线' }, fetchTile)).toEqual({
      line_relations: JINGHU,
      line_routes: '7\u001e#f00\u001eG7',
    });
  });

  it('takes only the nearest segment of an unnamed line', async () => {
    const lists = await lineListsNear({ lng: 121.5, lat: 31.1905, radius: 3000 }, fetchTile);
    expect(lists.line_relations).toBe(OTHER);
  });

  it('finds nothing beyond the radius', async () => {
    expect(await lineListsNear({ ...HERE, radius: 500, name: '京沪线' }, fetchTile)).toEqual({
      line_relations: undefined,
      line_routes: undefined,
    });
  });
});
