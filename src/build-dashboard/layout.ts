// Lays the build graph out as a line diagram read left to right: the sources
// in the first column, each step in the column after the last thing it waits
// for, and edges as tracks that run level and bend just before they arrive.

import type { BuildState, GraphStep, StepKind } from './model.js';
import { stepKind } from './model.js';

export const SOURCE_PREFIX = 'source:';

export interface LayoutNode {
  id: string; // a step's name, or "source:<name>"
  name: string;
  kind: 'source' | StepKind;
  layer: number;
  x: number;
  y: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  // "after": the step only waits for the other, reading nothing of it
  kind: 'reads' | 'after';
  points: Array<[number, number]>;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  column?: number; // between columns
  row?: number; // least distance between nodes of a column
}

// What a step waits for: its sources and the steps it reads, then the steps
// it only comes after
function upstream(step: GraphStep): Array<[string, LayoutEdge['kind']]> {
  const reads = new Set([...step.sources.map((s) => SOURCE_PREFIX + s), ...step.needs.map((n) => n.split('/')[0])]);
  const after = step.after.filter((other) => !reads.has(other));
  return [
    ...[...reads].map((id): [string, LayoutEdge['kind']] => [id, 'reads']),
    ...after.map((id): [string, LayoutEdge['kind']] => [id, 'after']),
  ];
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function layoutGraph(graph: BuildState['graph'], options: LayoutOptions = {}): Layout {
  const column = options.column ?? 150;
  const row = options.row ?? 58;
  const thin = 14; // between two edges passing through a column
  const label = 46; // under a node, for its name and the line below it

  const kinds = new Map<string, LayoutNode['kind']>();
  for (const name of Object.keys(graph.sources)) kinds.set(SOURCE_PREFIX + name, 'source');
  for (const [name, step] of Object.entries(graph.steps)) kinds.set(name, stepKind(step));
  const before = new Map<string, Array<[string, LayoutEdge['kind']]>>();
  for (const id of kinds.keys()) before.set(id, []);
  for (const [name, step] of Object.entries(graph.steps)) {
    before.set(
      name,
      upstream(step).filter(([id]) => kinds.has(id)),
    );
  }
  const after = new Map<string, string[]>([...kinds.keys()].map((id): [string, string[]] => [id, []]));
  for (const [id, list] of before) for (const [other] of list) after.get(other).push(id);

  // Columns: one past the furthest thing a node waits for
  const layer = new Map<string, number>();
  const layerOf = (id: string): number => {
    if (!layer.has(id)) {
      layer.set(id, 0); // a cycle would stop here; the build refuses them anyway
      layer.set(id, Math.max(-1, ...before.get(id).map(([other]) => layerOf(other))) + 1);
    }
    return layer.get(id);
  };
  for (const id of kinds.keys()) layerOf(id);
  // A step that waits for nothing sits right before the first step waiting for it
  for (const id of kinds.keys()) {
    if (kinds.get(id) !== 'source' && !before.get(id).length && after.get(id).length) {
      layer.set(id, Math.max(0, Math.min(...after.get(id).map((other) => layer.get(other))) - 1));
    }
  }

  // Edges longer than a column pass through a slot in each column between,
  // so nothing is drawn across a node
  interface Slot {
    id: string;
    layer: number;
    left: string[];
    right: string[];
    y: number;
  }
  const slots = new Map<string, Slot>();
  const slot = (id: string, at: number) => {
    if (!slots.has(id)) slots.set(id, { id, layer: at, left: [], right: [], y: 0 });
    return slots.get(id);
  };
  for (const id of kinds.keys()) slot(id, layer.get(id));
  const chains: Array<{ from: string; to: string; kind: LayoutEdge['kind']; path: string[] }> = [];
  for (const [to, list] of before) {
    for (const [from, kind] of list) {
      const path = [from];
      for (let at = layer.get(from) + 1; at < layer.get(to); at++) path.push(slot(`${from}→${to}@${at}`, at).id);
      path.push(to);
      for (let i = 0; i + 1 < path.length; i++) {
        slots.get(path[i]).right.push(path[i + 1]);
        slots.get(path[i + 1]).left.push(path[i]);
      }
      chains.push({ from, to, kind, path });
    }
  }

  const depth = Math.max(0, ...[...slots.values()].map((s) => s.layer)) + 1;
  const columns: Slot[][] = Array.from({ length: depth }, (): Slot[] => []);
  for (const s of slots.values()) columns[s.layer].push(s);

  // Heights: each column stacked in its order and centred on the tallest,
  // a pass-through slot taking less room than a node
  const real = (s: Slot) => kinds.has(s.id);
  // A node's label hangs under it, so what comes below a node keeps clear of
  // it, while an edge may pass close above one
  const gap = (above: Slot, below: Slot) => {
    if (real(above)) return real(below) ? row : label;
    return real(below) ? thin + 6 : thin;
  };
  const stack = () => {
    const totals = columns.map((nodes) => {
      let y = 0;
      nodes.forEach((s, i) => {
        if (i) y += gap(nodes[i - 1], s);
        s.y = y;
      });
      return y;
    });
    const tallest = Math.max(0, ...totals);
    columns.forEach((nodes, i) => nodes.forEach((s) => (s.y += (tallest - totals[i]) / 2)));
  };

  // Order within columns: each node at the average height of its neighbours
  // in the column swept from, a few times each way, to uncross the edges
  stack();
  for (let sweep = 0; sweep < 12; sweep++) {
    const forward = sweep % 2 === 0;
    for (const nodes of forward ? columns.slice(1) : columns.slice(0, -1).reverse()) {
      const wanted = new Map(
        nodes.map((s) => {
          const beside = forward ? s.left : s.right;
          return [s.id, beside.length ? mean(beside.map((id) => slots.get(id).y)) : s.y];
        }),
      );
      nodes.sort((a, b) => wanted.get(a.id) - wanted.get(b.id));
      stack();
    }
  }
  for (const s of slots.values()) s.y = Math.round(s.y);

  const point = (id: string): [number, number] => [slots.get(id).layer * column, slots.get(id).y];
  const nodes = [...kinds.entries()].map(([id, kind]) => ({
    id,
    name: id.startsWith(SOURCE_PREFIX) ? id.slice(SOURCE_PREFIX.length) : id,
    kind,
    layer: slots.get(id).layer,
    x: point(id)[0],
    y: point(id)[1],
  }));
  return {
    nodes,
    edges: chains.map(({ from, to, kind, path }) => ({ from, to, kind, points: path.map(point) })),
    width: (depth - 1) * column,
    height: Math.max(0, ...[...slots.values()].map((s) => s.y)),
  };
}

// An edge as an SVG path: level along its row, then one smooth bend over the
// last `bend` px before each point at another height
export function edgePath(points: Array<[number, number]>, bend = 56): string {
  const [[x0, y0], ...rest] = points;
  let d = `M${x0},${y0}`;
  let [x, y] = [x0, y0];
  for (const [nx, ny] of rest) {
    if (ny === y) {
      d += ` L${nx},${ny}`;
    } else {
      const start = Math.max(x, nx - bend);
      const middle = (start + nx) / 2;
      d += ` L${start},${y} C${middle},${y} ${middle},${ny} ${nx},${ny}`;
    }
    [x, y] = [nx, ny];
  }
  return d;
}

// Everything a node depends on and everything depending on it, itself included
export function related(layout: Layout, id: string): Set<string> {
  const found = new Set([id]);
  const walk = (start: string, pick: (edge: LayoutEdge) => [string, string]) => {
    const queue = [start];
    while (queue.length) {
      const current = queue.pop();
      for (const edge of layout.edges) {
        const [here, there] = pick(edge);
        if (here === current && !found.has(there)) {
          found.add(there);
          queue.push(there);
        }
      }
    }
  };
  walk(id, (edge) => [edge.to, edge.from]);
  walk(id, (edge) => [edge.from, edge.to]);
  return found;
}
