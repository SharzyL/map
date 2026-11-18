import { describe, expect, it } from 'vitest';
import { edgePath, layoutGraph, related, SOURCE_PREFIX } from './layout.js';
import type { BuildState, GraphStep } from './model.js';

const step = (over: Partial<GraphStep>): GraphStep => ({
  about: '',
  sources: [],
  needs: [],
  after: [],
  outs: [],
  ...over,
});

// feed ── fetch ─┬─ pack ── publish        (publish also waits for tested,
//                └──────────── report       and report reads fetch two columns on)
const GRAPH: BuildState['graph'] = {
  sources: { feed: { about: '', manual: false } },
  steps: {
    fetch: step({ kind: 'build', sources: ['feed'], outs: ['data'] }),
    pack: step({ kind: 'build', needs: ['fetch/data'], outs: ['out'] }),
    publish: step({ kind: 'deploy', needs: ['pack/out'], after: ['tested'] }),
    report: step({ kind: 'build', needs: ['fetch/data', 'pack/out'], outs: ['report'] }),
    tested: step({ kind: 'check' }),
    loose: step({ kind: 'build', outs: ['x'] }),
  },
};

describe('layoutGraph', () => {
  const layout = layoutGraph(GRAPH, { column: 100, row: 50 });
  const node = (id: string) => layout.nodes.find((n) => n.id === id);

  it('puts each node a column after the last thing it waits for', () => {
    expect(node(SOURCE_PREFIX + 'feed')).toMatchObject({ kind: 'source', layer: 0, x: 0 });
    expect(['fetch', 'pack', 'publish', 'report'].map((id) => node(id).layer)).toEqual([1, 2, 3, 3]);
    // A step waiting for nothing sits right before the one waiting for it
    expect(node('tested')).toMatchObject({ kind: 'check', layer: 2 });
    expect(node('loose').layer).toBe(0);
    expect(layout.width).toBe(300);
  });

  it('keeps nodes of a column apart', () => {
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a !== b && a.layer === b.layer) expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(50);
      }
    }
  });

  it('draws one edge per dependency, long ones through every column between', () => {
    const edges = layout.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
    expect(edges).toEqual([
      'fetch>pack:reads',
      'fetch>report:reads',
      'pack>publish:reads',
      'pack>report:reads',
      'source:feed>fetch:reads',
      'tested>publish:after',
    ]);
    const long = layout.edges.find((e) => e.from === 'fetch' && e.to === 'report');
    expect(long.points.map(([x]) => x)).toEqual([100, 200, 300]);
    expect(long.points[0]).toEqual([node('fetch').x, node('fetch').y]);
  });

  it('gives the same layout every time', () => {
    expect(layoutGraph(GRAPH, { column: 100, row: 50 })).toEqual(layout);
  });

  it('traces what a node depends on and what depends on it', () => {
    expect([...related(layout, 'pack')].sort()).toEqual(['fetch', 'pack', 'publish', 'report', 'source:feed']);
    expect([...related(layout, 'tested')].sort()).toEqual(['publish', 'tested']);
  });
});

describe('edgePath', () => {
  it('runs level and bends just before a point at another height', () => {
    expect(
      edgePath([
        [0, 10],
        [100, 10],
      ]),
    ).toBe('M0,10 L100,10');
    expect(
      edgePath(
        [
          [0, 10],
          [100, 50],
          [200, 50],
        ],
        40,
      ),
    ).toBe('M0,10 L60,10 C80,10 80,50 100,50 L200,50');
  });
});
