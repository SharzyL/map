// Hovering a railway line lights up the whole line, not just the way under the
// pointer. The line is
//
// - the hovered segment's railway line (a `line_relations` id, preferring one
//   named like the segment), else its first transit route (`line_routes`, so
//   a metro track lights its metro line): segments listing that id belong;
// - its name: segments without relation lists belong by name. The zoomed-out
//   layer carries no lists, so there the line is the segments of that name.
//
// The pointer handler (popup.ts) sets the line layers' `hover` feature state
// on the line's features in the loaded tiles. Feature state only updates the
// features it changes; a global state read by the line layers' colors made
// every line layer of every tile re-evaluate on each hover, several times
// slower.
export const HOVER_LINE_SOURCE_LAYERS = ['railway_line_high', 'standard_railway_line_low'];

export type HoveredLine = { id: string; name: string };

const groups = (value: unknown) =>
  String(value ?? '')
    .split('\u001d')
    .filter(Boolean)
    .map((group) => group.split('\u001e'));

// The line a hovered segment belongs to.
export function hoveredLineOf(properties: Record<string, unknown>): HoveredLine {
  const name = String(properties.name ?? '');
  // line_relations groups are id, color, name, ref; line_routes groups id, color, label.
  const lines = groups(properties.line_relations);
  const line = lines.find(([, , lineName]) => lineName && lineName === name) ?? lines[0];
  const route = groups(properties.line_routes)[0];
  return { id: (line ?? route)?.[0] ?? '', name };
}

const listHas = (property: string, id: string) => [
  'in',
  `\u001d${id}\u001e`,
  ['concat', '\u001d', ['to-string', ['coalesce', ['get', property], '']]],
];

// A filter for the line's segments, or null for no line.
export function lineFilter({ id, name }: HoveredLine): unknown[] | null {
  const byName = name ? ['==', ['to-string', ['coalesce', ['get', 'name'], '']], name] : false;
  if (!id) return byName ? byName : null;
  return [
    'case',
    ['any', ['has', 'line_relations'], ['has', 'line_routes']],
    ['any', listHas('line_relations', id), listHas('line_routes', id)],
    byName,
  ];
}
