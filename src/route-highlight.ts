// Highlights one route or line on the map: a route (e.g. a metro line in one
// direction) or a railway line (route=railway, e.g. 京沪线; in Japan an official
// line, id jp-…). Line segments carry the routes and lines they belong to as
// `line_routes` / `line_relations`, and stations their routes as
// `station_routes`: groups of `id\x1Ecolor\x1Elabel` (lines add `\x1Eref`)
// joined by `\x1D`. No id is in both lists, so one selected id matches in
// either. The highlight layers sit on the same
// railway sources and keep only features whose lists contain the selected id,
// so the whole route or line shows wherever tiles load, not just the clicked
// segment. Below z7 no tiles carry these ids, so route-trace.ts collects the
// geometry from z7 tiles and a GeoJSON overlay draws it.
import { mapZoomOutputs } from './map-layers.js';
import { createPanelShell, el } from './map-panel.js';
import { withRailwayOverlayVisibility } from './railway-filter.js';
import { decodePolyline, relationDetails, type RelationDetails } from './norikae.js';
import { ROUTE_TRACE_ZOOM, tilesInBounds, traceRoute, type RouteGeometry } from './route-trace.js';
import { setGlobalStatePropertyWhenReady } from './style-ready.js';
import { emitUiPanelOpen, isOtherUiPanelOpen, UI_PANEL_OPEN_EVENT } from './ui-panels.js';

export const ROUTE_HIGHLIGHT_ID_STATE = 'highlightedRouteId';
export const ROUTE_HIGHLIGHT_COLOR_STATE = 'highlightedRouteColor';
// A train's route (train-route.ts) is drawn by these layers: on the railway
// line tiles, the ways it covers whole, whose ids the layers' filter lists
// (set per train, starting with none); in a GeoJSON source, its outline below
// z7, the parts of ways it covers partly, legs without a path (dashed) and its
// stops. While it shows, other railways dim as for a highlight.
export const TRAIN_ROUTE_STATE = 'trainRouteShown';
export const TRAIN_ROUTE_SOURCE = 'train_route';
export const TRAIN_ROUTE_WAY_LAYER = /^train_route_(casing|line)_\d+$/;
export const NO_TRAIN_WAYS = ['==', ['get', 'osm_id'], -1];
const TRAIN_COLOR = '#2563eb';
// Dispatched (bubbling) by popup route list items; detail is a RouteSelection.
export const ROUTE_SELECT_EVENT = 'orm:routeselect';

const FALLBACK_COLOR = '#e6007e';
const OVERVIEW_SOURCE = 'route_highlight_overview';
const EMPTY_GEOMETRY: RouteGeometry = { type: 'FeatureCollection', features: [] };
const LINE_SOURCE_LAYER = 'railway_line_high';
const STATION_SOURCE_LAYER_PREFIX = 'standard_railway_text_stations';

// `at` is where it was picked ([lng, lat]), so the zoomed-out trace can start there.
// `kind` says whether it is a transit route or a railway line (route=railway,
// or in Japan an official line with a jp- id); `name` and `ref` are the list
// entry's label and number.
export type RouteSelection = {
  id: string;
  color: string | null;
  label: string | null;
  at?: [number, number];
  kind?: 'route' | 'line';
  name?: string | null;
  ref?: string | null;
};

type StyleLayerLike = {
  id?: string;
  type?: string;
  source?: string;
  'source-layer'?: string;
  minzoom?: number;
  maxzoom?: number;
  [key: string]: unknown;
};
type StyleLike = {
  layers?: StyleLayerLike[];
  state?: Record<string, { default?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
};
type SourceRange = { source: string; sourceLayer: string; minzoom: number; maxzoom: number };
type GeoJsonSourceLike = { setData(data: RouteGeometry): void };
type BoundsLike = { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
export type RouteHighlightMap = Parameters<typeof setGlobalStatePropertyWhenReady>[0] & {
  getContainer(): HTMLElement;
  getBounds(): BoundsLike;
  fitBounds?(bounds: [[number, number], [number, number]], options?: Record<string, unknown>): unknown;
  flyTo?(options: { center: [number, number]; zoom: number }): unknown;
  getZoom?(): number;
  getSource(id: string): unknown;
  getStyle(): { layers?: StyleLayerLike[]; sources?: Record<string, object> };
};

const SELECTED_ID = ['to-string', ['global-state', ROUTE_HIGHLIGHT_ID_STATE]];
const DIMMING = ['any', ['!=', SELECTED_ID, ''], ['to-boolean', ['global-state', TRAIN_ROUTE_STATE]]];
// Line segment attributes listing the relations a segment belongs to.
export const LINE_LIST_PROPERTIES = ['line_routes', 'line_relations'] as const;
const ROUTE_COLOR = ['to-color', ['global-state', ROUTE_HIGHLIGHT_COLOR_STATE], FALLBACK_COLOR];

export function routeListFilter(property: string) {
  return [
    'all',
    ['!=', SELECTED_ID, ''],
    [
      'in',
      ['concat', '\u001d', SELECTED_ID, '\u001e'],
      ['concat', '\u001d', ['to-string', ['coalesce', ['get', property], '']]],
    ],
  ];
}

// The zoom range each source serves a source layer at, read from the layers
// that draw it (railway_line_high comes from one source at z7-8 and another
// from z8).
function sourceRanges(layers: StyleLayerLike[], matches: (sourceLayer: string) => boolean): SourceRange[] {
  const ranges = new Map<string, SourceRange>();
  for (const layer of layers) {
    const sourceLayer = layer['source-layer'];
    if (!layer.source || !sourceLayer || !matches(sourceLayer)) continue;
    const key = `${layer.source}\u0000${sourceLayer}`;
    const range = ranges.get(key) || { source: layer.source, sourceLayer, minzoom: 24, maxzoom: 0 };
    range.minzoom = Math.min(range.minzoom, layer.minzoom ?? 0);
    range.maxzoom = Math.max(range.maxzoom, layer.maxzoom ?? 24);
    ranges.set(key, range);
  }
  return [...ranges.values()];
}

function zoomRange({ source, sourceLayer, minzoom, maxzoom }: SourceRange) {
  return { source, 'source-layer': sourceLayer, minzoom, maxzoom };
}

const LINE_LAYOUT = { 'line-join': 'round', 'line-cap': 'round' };
// Other railway lines are dimmed meanwhile, so a thin dark outline is enough
// to keep light route colors visible on the base map.
const CASING_PAINT = {
  'line-color': '#1e293b',
  'line-opacity': 0.85,
  'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3.5, 10, 5, 16, 8],
};
const LINE_PAINT = {
  'line-color': ROUTE_COLOR,
  'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2, 10, 3, 16, 5],
};

function trainRouteLayers(lineRanges: SourceRange[]): StyleLayerLike[] {
  const linePaint = { ...LINE_PAINT, 'line-color': TRAIN_COLOR };
  const kind = (value: string) => ['==', ['get', 'kind'], value];
  const geojson = { source: TRAIN_ROUTE_SOURCE, layout: LINE_LAYOUT };
  return [
    ...lineRanges.flatMap((range, index) => [
      {
        id: `train_route_casing_${index}`,
        type: 'line',
        ...zoomRange(range),
        filter: NO_TRAIN_WAYS,
        layout: LINE_LAYOUT,
        paint: CASING_PAINT,
      },
    ]),
    ...lineRanges.map((range, index) => ({
      id: `train_route_line_${index}`,
      type: 'line',
      ...zoomRange(range),
      filter: NO_TRAIN_WAYS,
      layout: LINE_LAYOUT,
      paint: linePaint,
    })),
    {
      id: 'train_route_overview_casing',
      type: 'line',
      ...geojson,
      maxzoom: ROUTE_TRACE_ZOOM,
      filter: kind('overview'),
      paint: CASING_PAINT,
    },
    {
      id: 'train_route_overview_line',
      type: 'line',
      ...geojson,
      maxzoom: ROUTE_TRACE_ZOOM,
      filter: kind('overview'),
      paint: linePaint,
    },
    {
      id: 'train_route_partial_casing',
      type: 'line',
      ...geojson,
      minzoom: ROUTE_TRACE_ZOOM,
      filter: kind('partial'),
      paint: CASING_PAINT,
    },
    {
      id: 'train_route_partial_line',
      type: 'line',
      ...geojson,
      minzoom: ROUTE_TRACE_ZOOM,
      filter: kind('partial'),
      paint: linePaint,
    },
    {
      id: 'train_route_straight',
      type: 'line',
      source: TRAIN_ROUTE_SOURCE,
      filter: kind('straight'),
      paint: { ...linePaint, 'line-dasharray': [1.5, 1.5] },
    },
    {
      id: 'train_route_stops',
      type: 'circle',
      source: TRAIN_ROUTE_SOURCE,
      filter: kind('stop'),
      paint: {
        'circle-color': ['case', ['==', ['get', 'here'], true], TRAIN_COLOR, '#ffffff'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 10, 4, 16, 7],
        'circle-stroke-color': '#1e293b',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 16, 2.5],
      },
    },
  ];
}

function routeHighlightLayers(layers: StyleLayerLike[]): StyleLayerLike[] {
  const lineRanges = sourceRanges(layers, (sourceLayer) => sourceLayer === LINE_SOURCE_LAYER);
  const stationRanges = sourceRanges(layers, (sourceLayer) => sourceLayer.startsWith(STATION_SOURCE_LAYER_PREFIX));
  const filter = ['any', ...LINE_LIST_PROPERTIES.map(routeListFilter)];
  const overview = { source: OVERVIEW_SOURCE, maxzoom: ROUTE_TRACE_ZOOM, layout: LINE_LAYOUT };
  return [
    { id: 'route_highlight_overview_casing', type: 'line', ...overview, paint: CASING_PAINT },
    { id: 'route_highlight_overview_line', type: 'line', ...overview, paint: LINE_PAINT },
    ...lineRanges.map((range, index) => ({
      id: `route_highlight_casing_${index}`,
      type: 'line',
      ...zoomRange(range),
      filter,
      layout: LINE_LAYOUT,
      paint: CASING_PAINT,
    })),
    ...lineRanges.map((range, index) => ({
      id: `route_highlight_line_${index}`,
      type: 'line',
      ...zoomRange(range),
      filter,
      layout: LINE_LAYOUT,
      paint: LINE_PAINT,
    })),
    ...trainRouteLayers(lineRanges),
    ...stationRanges.map((range, index) => ({
      id: `route_highlight_station_${index}`,
      type: 'circle',
      ...zoomRange(range),
      filter: routeListFilter('station_routes'),
      paint: {
        'circle-color': '#ffffff',
        // Small while zoomed out, where metro stops sit only a few pixels apart.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 10, 3, 16, 6],
        'circle-stroke-color': '#1e293b',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 1, 16, 2.5],
      },
    })),
  ];
}

// While a route is highlighted every other railway layer fades to this
// opacity; stations on the route stay fully visible. Other stations fade only
// a little: route stop lists in OSM are often incomplete, so a station the
// route serves may not list it and must stay readable.
const DIMMED_OPACITY = 0.25;
const DIMMED_STATION_OPACITY = 0.6;
const OPACITY_PROPERTIES: Record<string, string[]> = {
  line: ['line-opacity'],
  fill: ['fill-opacity'],
  circle: ['circle-opacity', 'circle-stroke-opacity'],
  symbol: ['icon-opacity', 'text-opacity'],
};

function dimmedOpacity(layer: StyleLayerLike) {
  if (!layer['source-layer']?.startsWith(STATION_SOURCE_LAYER_PREFIX)) {
    return ['case', DIMMING, DIMMED_OPACITY, 1];
  }
  return ['case', ['!', DIMMING], 1, routeListFilter('station_routes'), 1, DIMMED_STATION_OPACITY];
}

function withRouteDimming(layer: StyleLayerLike): StyleLayerLike {
  const properties = OPACITY_PROPERTIES[layer.type || ''];
  if (!properties) return layer;
  const factor = dimmedOpacity(layer);
  const paint = { ...((layer.paint as Record<string, unknown>) || {}) };
  for (const property of properties) {
    paint[property] = mapZoomOutputs(paint[property] ?? 1, (output) => ['*', output, factor]);
  }
  return { ...layer, paint };
}

// Adds the highlight layers right above the last line layer drawing railway
// lines (tunnel covers included) and below every railway label, so station
// names stay readable over the highlight, and lets the other railway layers
// fade while a route is highlighted.
export function addRouteHighlightToStyle<T extends StyleLike>(style: T, railwaySources: readonly string[]): T {
  const layers = style.layers || [];
  const railway = new Set(railwaySources);
  const isRailway = (layer: StyleLayerLike) => !!layer.source && railway.has(layer.source);
  const highlight = routeHighlightLayers(layers.filter(isRailway)).map(withRailwayOverlayVisibility);
  if (highlight.length === 0) return style;
  const dimmed = layers.map((layer) => (isRailway(layer) ? withRouteDimming(layer) : layer));
  const insertAt =
    layers.findLastIndex(
      (layer) => isRailway(layer) && layer.type === 'line' && layer['source-layer'] === LINE_SOURCE_LAYER,
    ) + 1;
  const state = {
    ...(style.state || {}),
    [ROUTE_HIGHLIGHT_ID_STATE]: { default: '' },
    [ROUTE_HIGHLIGHT_COLOR_STATE]: { default: '' },
    [TRAIN_ROUTE_STATE]: { default: false },
  };
  const sources = { ...((style.sources as Record<string, unknown>) || {}) };
  sources[OVERVIEW_SOURCE] = { type: 'geojson', data: EMPTY_GEOMETRY };
  sources[TRAIN_ROUTE_SOURCE] = { type: 'geojson', data: EMPTY_GEOMETRY };
  return {
    ...style,
    sources,
    layers: [...dimmed.slice(0, insertAt), ...highlight, ...dimmed.slice(insertAt)],
    state,
  };
}

const OSM_RELATION = 'https://www.openstreetmap.org/relation/';
const OSM_EDIT = 'https://www.openstreetmap.org/edit?relation=';

// Encoded outline polylines as the zoomed-out highlight's geometry.
function overviewGeometry(lines: string[]): RouteGeometry {
  return {
    type: 'FeatureCollection',
    features: lines.map((line) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: decodePolyline(line) },
    })),
  };
}

// The extent of a traced route, or null before the trace has any of it.
function geometryBounds(geometry: RouteGeometry): [[number, number], [number, number]] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number') {
      const [lng, lat] = value as number[];
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      return;
    }
    value.forEach(visit);
  };
  for (const feature of geometry.features) {
    if ('coordinates' in feature.geometry) visit(feature.geometry.coordinates);
  }
  return west <= east
    ? [
        [west, south],
        [east, north],
      ]
    : null;
}

type Bounds = [[number, number], [number, number]];
type PanelActions = {
  close(): void;
  zoomTo(bounds: Bounds): void;
  flyTo(position: [number, number]): void;
};

const KIND_LABELS: Record<string, string> = {
  train: 'Train route',
  subway: 'Subway route',
  light_rail: 'Light rail route',
  tram: 'Tram route',
  monorail: 'Monorail route',
  funicular: 'Funicular route',
};

function wikipediaUrl(tag: string) {
  const [lang, ...title] = tag.split(':');
  return title.length ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.join(':'))}` : null;
}

// A panel describing the highlighted route or line, beside the map like the
// timetable; closing it clears the highlight. It opens with what the tiles'
// route lists hold (name, number, color) and fills in from the railway
// relations API (norikae.ts): operator, network, ends, length, links and the
// stations in order, each a button that flies the map there.
class RoutePanel {
  readonly panel: HTMLElement;
  private readonly _container: HTMLElement;
  private readonly _title: HTMLElement;
  private readonly _summary: HTMLElement;
  private readonly _body: HTMLElement;
  private readonly _actions: PanelActions;
  private _zoom: HTMLButtonElement | null = null;
  private _status: HTMLElement | null = null;
  private _bounds: Bounds | null = null;

  constructor(container: HTMLElement, actions: PanelActions) {
    this._container = container;
    this._actions = actions;
    const shell = createPanelShell(container, 'route-info', {
      title: 'Route',
      label: 'Highlighted route',
      closeLabel: 'Clear highlight',
      onClose: () => actions.close(),
    });
    this.panel = shell.panel;
    this._title = this.panel.querySelector('.route-info-title');
    this._summary = shell.summary;
    this._body = shell.body;
    this.panel.inert = true;
  }

  // Opens on a selection with what the tiles know; fill() adds the rest.
  show(route: RouteSelection | null) {
    this._bounds = null;
    this.panel.classList.toggle('route-info-panel-visible', Boolean(route));
    this.panel.setAttribute('aria-hidden', route ? 'false' : 'true');
    this.panel.inert = !route;
    if (!route) return;
    emitUiPanelOpen(this._container, 'route');
    const line = route.kind === 'line';
    this._title.textContent = route.name || route.label || `${line ? 'Line' : 'Route'} ${route.id}`;
    this._summary.textContent = [line ? 'Railway line' : 'Transit route', route.ref].filter(Boolean).join(' · ');
    const fields = this._fields();
    if (route.ref) this._row(fields, 'Number').textContent = route.ref;
    if (route.color) this._color(fields, route.color);
    if (!route.id.startsWith('jp-')) this._osm(fields, route.id);
    this._body.replaceChildren(fields, this._zoomButton(line));
    this._status = el('div', 'route-info-status', this._body);
    this._status.textContent = 'Loading details…';
  }

  fill(details: RelationDetails) {
    const { relation } = details;
    const line = relation.kind === 'line';
    this._title.textContent = relation.name || this._title.textContent;
    this._summary.textContent = [
      line
        ? 'Railway line'
        : relation.kind === 'master'
          ? 'Route master'
          : (KIND_LABELS[relation.type] ?? 'Transit route'),
      relation.ref,
    ]
      .filter(Boolean)
      .join(' · ');
    const fields = this._fields();
    if (relation.ref) this._row(fields, 'Number').textContent = relation.ref;
    if (relation.from || relation.to) {
      this._row(fields, 'From – to').textContent = `${relation.from ?? '?'} → ${relation.to ?? '?'}`;
    }
    if (relation.operator) this._row(fields, 'Operator').textContent = relation.operator;
    if (relation.network) this._row(fields, 'Network').textContent = relation.network.split(';').join(', ');
    if (details.length_m) this._row(fields, 'Length').textContent = `${(details.length_m / 1000).toFixed(1)} km`;
    if (relation.colour) this._color(fields, relation.colour);
    if (relation.aliases?.length) this._row(fields, 'Also called').textContent = relation.aliases.join(', ');
    if (relation.attribution) {
      this._link(this._row(fields, 'Source'), relation.attribution.text, relation.attribution.url);
    } else {
      this._osm(fields, String(relation.id));
    }
    if (relation.master) {
      this._link(this._row(fields, 'Route master'), `relation ${relation.master}`, OSM_RELATION + relation.master);
    }
    const links = [
      relation.wikidata && (['Wikidata', `https://www.wikidata.org/wiki/${relation.wikidata}`] as const),
      relation.wikipedia &&
        wikipediaUrl(relation.wikipedia) &&
        (['Wikipedia', wikipediaUrl(relation.wikipedia)] as const),
    ].filter(Boolean);
    if (links.length) {
      const dd = this._row(fields, 'Links');
      links.forEach(([text, href], index) => {
        if (index) dd.append(' · ');
        this._link(dd, text, href);
      });
    }
    const [west, south, east, north] = details.bbox;
    this._bounds = [
      [west, south],
      [east, north],
    ];
    this._body.replaceChildren(fields, this._zoomButton(line));
    if (this._zoom) this._zoom.disabled = false;
    const stops = details.stops ?? [];
    if (stops.length) {
      el('h3', 'route-info-heading', this._body).textContent = `Stations (${stops.length})`;
      const list = el('ol', 'route-info-stations', this._body);
      for (const stop of stops) {
        const item = el('li', undefined, list);
        const name = el(stop.position ? 'button' : 'span', 'route-info-station', item);
        name.textContent = stop.name;
        if (stop.km !== null && stop.km !== undefined) el('span', 'route-info-km', item).textContent = `${stop.km} km`;
        const position = stop.position;
        if (position && name instanceof HTMLButtonElement) {
          name.type = 'button';
          name.title = `Show ${stop.name} on the map`;
          name.addEventListener('click', () => this._actions.flyTo(position));
        }
      }
    }
  }

  // The API could not describe it: keep what the tiles gave.
  failed() {
    if (this._status) this._status.textContent = 'No further details for this one.';
  }

  // The traced route's extent, while the API has given none.
  setGeometry(geometry: RouteGeometry) {
    if (this._bounds) return;
    this._bounds = geometryBounds(geometry);
    if (this._zoom) this._zoom.disabled = !this._bounds;
  }

  private _fields() {
    return el('dl', 'route-info-fields');
  }

  private _row(fields: HTMLElement, label: string) {
    el('dt', undefined, fields).textContent = label;
    return el('dd', undefined, fields);
  }

  private _color(fields: HTMLElement, color: string) {
    const dd = this._row(fields, 'Color');
    el('span', 'route-info-swatch', dd).style.background = color;
    dd.append(color);
  }

  private _link(parent: HTMLElement, text: string, href: string) {
    const a = el('a', undefined, parent);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
  }

  private _osm(fields: HTMLElement, id: string) {
    const dd = this._row(fields, 'OpenStreetMap');
    this._link(dd, `relation ${id}`, OSM_RELATION + id);
    dd.append(' · ');
    this._link(dd, 'edit', OSM_EDIT + id);
  }

  private _zoomButton(line: boolean) {
    this._zoom = el('button', 'route-info-zoom');
    this._zoom.type = 'button';
    this._zoom.textContent = `Show the whole ${line ? 'line' : 'route'}`;
    this._zoom.disabled = !this._bounds;
    this._zoom.addEventListener('click', () => this._bounds && this._actions.zoomTo(this._bounds));
    return this._zoom;
  }
}

export function installRouteHighlight(map: RouteHighlightMap) {
  const container = map.getContainer();
  let selected: RouteSelection | null = null;
  const panel = new RoutePanel(container, {
    close: () => select(null),
    zoomTo: (bounds) =>
      map.fitBounds?.(bounds, { padding: { top: 64, right: 72, bottom: 48, left: 380 }, maxZoom: 14 }),
    flyTo: (center) => map.flyTo?.({ center, zoom: Math.max(map.getZoom?.() ?? 0, 14) }),
  });

  function markListItems() {
    for (const item of container.querySelectorAll<HTMLElement>('[data-route-id]')) {
      item.setAttribute('aria-pressed', String(item.dataset.routeId === selected?.id));
    }
  }

  let trace: AbortController | null = null;
  const overview = () => map.getSource(OVERVIEW_SOURCE) as GeoJsonSourceLike | undefined;

  // The z7 tile URL of the source the z7 highlight layer draws from.
  function z7TileUrl() {
    const style = map.getStyle();
    const layer = style.layers?.find(
      (candidate) => candidate.id?.startsWith('route_highlight_line_') && (candidate.minzoom ?? 0) <= ROUTE_TRACE_ZOOM,
    );
    const source = layer?.source ? (style.sources?.[layer.source] as { tiles?: string[] }) : undefined;
    return source?.tiles?.[0] || null;
  }

  async function traceOverview(route: RouteSelection, signal: AbortSignal) {
    const template = z7TileUrl();
    if (!template) return;
    const bounds = map.getBounds();
    // Zoomed out, the view spans more z7 tiles than the seed budget and the
    // route may miss the ones taken, so start from where it was picked.
    const picked = route.at ? tilesInBounds(route.at[0], route.at[1], route.at[0], route.at[1], 1) : [];
    const seeds = [
      ...picked,
      ...tilesInBounds(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()),
    ];
    const geometry = await traceRoute(
      route.id,
      seeds,
      async (z, x, y, abort) => {
        const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const response = await fetch(url, { signal: abort });
        return response.status === 200 ? response.arrayBuffer() : null;
      },
      signal,
    );
    if (signal.aborted) return;
    overview()?.setData(geometry);
    panel.setGeometry(geometry);
  }

  // Details and the zoomed-out outline from the railway relations API; without
  // them (an error, or a relation it does not have), the outline is traced
  // from z7 tiles.
  async function describe(route: RouteSelection, signal: AbortSignal) {
    let details: RelationDetails | null = null;
    try {
      details = await relationDetails(route.id, signal);
    } catch {
      if (signal.aborted) return;
      panel.failed();
      await traceOverview(route, signal);
      return;
    }
    if (signal.aborted) return;
    panel.fill(details);
    overview()?.setData(overviewGeometry(details.overview));
  }

  function select(route: RouteSelection | null) {
    selected = route;
    trace?.abort();
    trace = null;
    overview()?.setData(EMPTY_GEOMETRY);
    setGlobalStatePropertyWhenReady(map, ROUTE_HIGHLIGHT_COLOR_STATE, route?.color || '');
    setGlobalStatePropertyWhenReady(map, ROUTE_HIGHLIGHT_ID_STATE, route?.id || '');
    panel.show(route);
    markListItems();
    if (route) {
      trace = new AbortController();
      describe(route, trace.signal).catch(() => {});
    }
  }

  container.addEventListener(ROUTE_SELECT_EVENT, (event) => {
    const route = (event as CustomEvent<RouteSelection>).detail;
    if (!route?.id) return;
    // Selecting the highlighted route again turns the highlight off.
    select(route.id === selected?.id ? null : route);
  });
  // Popups opened later show which of their routes is highlighted.
  new MutationObserver((records) => {
    if (selected && records.some((record) => record.addedNodes.length > 0)) markListItems();
  }).observe(container, { childList: true, subtree: true });
  // Another panel taking the place beside the map ends the highlight.
  container.addEventListener(UI_PANEL_OPEN_EVENT, (event) => {
    if (selected && isOtherUiPanelOpen(event, 'route')) select(null);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selected && !(event.target instanceof HTMLInputElement)) select(null);
  });

  return {
    select,
    get selected() {
      return selected;
    },
  };
}
