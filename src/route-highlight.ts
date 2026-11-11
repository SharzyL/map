// Highlights one OSM relation on the map: a route (e.g. a metro line in one
// direction) or a railway line (route=railway, e.g. 京沪线). Line segments carry
// the routes and lines they belong to as `line_routes` / `line_relations`, and
// stations their routes as `station_routes`: groups of `id\x1Ecolor\x1Elabel`
// (lines add `\x1Eref`) joined by `\x1D`. Both are relation ids, so one
// selected id matches in either list. The highlight layers sit on the same
// railway sources and keep only features whose lists contain the selected id,
// so the whole route or line shows wherever tiles load, not just the clicked
// segment. Below z7 no tiles carry these ids, so route-trace.ts collects the
// geometry from z7 tiles and a GeoJSON overlay draws it.
import { mapZoomOutputs } from './map-layers.js';
import { el, stopMapControlPropagation } from './map-panel.js';
import { withRailwayOverlayVisibility } from './railway-filter.js';
import { ROUTE_TRACE_ZOOM, tilesInBounds, traceRoute, type RouteGeometry } from './route-trace.js';
import { setGlobalStatePropertyWhenReady } from './style-ready.js';

export const ROUTE_HIGHLIGHT_ID_STATE = 'highlightedRouteId';
export const ROUTE_HIGHLIGHT_COLOR_STATE = 'highlightedRouteColor';
// Dispatched (bubbling) by popup route list items; detail is a RouteSelection.
export const ROUTE_SELECT_EVENT = 'orm:routeselect';

const FALLBACK_COLOR = '#e6007e';
const OVERVIEW_SOURCE = 'route_highlight_overview';
const EMPTY_GEOMETRY: RouteGeometry = { type: 'FeatureCollection', features: [] };
const LINE_SOURCE_LAYER = 'railway_line_high';
const STATION_SOURCE_LAYER_PREFIX = 'standard_railway_text_stations';

export type RouteSelection = { id: string; color: string | null; label: string | null };

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
  getSource(id: string): unknown;
  getStyle(): { layers?: StyleLayerLike[]; sources?: Record<string, object> };
};

const SELECTED_ID = ['to-string', ['global-state', ROUTE_HIGHLIGHT_ID_STATE]];
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
    return ['case', ['==', SELECTED_ID, ''], 1, DIMMED_OPACITY];
  }
  return ['case', ['==', SELECTED_ID, ''], 1, routeListFilter('station_routes'), 1, DIMMED_STATION_OPACITY];
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
  };
  const sources = { ...((style.sources as Record<string, unknown>) || {}) };
  sources[OVERVIEW_SOURCE] = { type: 'geojson', data: EMPTY_GEOMETRY };
  return {
    ...style,
    sources,
    layers: [...dimmed.slice(0, insertAt), ...highlight, ...dimmed.slice(insertAt)],
    state,
  };
}

// A chip naming the highlighted route, with a button to clear it.
class RouteHighlightChip {
  readonly element: HTMLElement;
  private _marker: HTMLElement;
  private _label: HTMLElement;

  constructor(onClear: () => void) {
    this.element = el('div', 'route-highlight-chip');
    this.element.hidden = true;
    this.element.setAttribute('role', 'status');
    stopMapControlPropagation(this.element);
    this._marker = el('span', 'orm-color-marker', this.element);
    this._label = el('span', 'route-highlight-label', this.element);
    const clear = el('button', 'route-highlight-clear', this.element);
    clear.type = 'button';
    clear.title = 'Clear highlight';
    clear.setAttribute('aria-label', 'Clear highlight');
    clear.textContent = 'x';
    clear.addEventListener('click', onClear);
  }

  show(route: RouteSelection | null) {
    this.element.hidden = !route;
    if (!route) return;
    this._marker.style.backgroundColor = route.color || FALLBACK_COLOR;
    this._label.textContent = route.label || `Route ${route.id}`;
    this.element.title = this._label.textContent;
  }
}

export function installRouteHighlight(map: RouteHighlightMap) {
  const container = map.getContainer();
  let selected: RouteSelection | null = null;
  const chip = new RouteHighlightChip(() => select(null));
  container.appendChild(chip.element);

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

  async function traceOverview(routeId: string, signal: AbortSignal) {
    const template = z7TileUrl();
    if (!template) return;
    const bounds = map.getBounds();
    const seeds = tilesInBounds(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth());
    const geometry = await traceRoute(
      routeId,
      seeds,
      async (z, x, y, abort) => {
        const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const response = await fetch(url, { signal: abort });
        return response.status === 200 ? response.arrayBuffer() : null;
      },
      signal,
    );
    if (!signal.aborted) overview()?.setData(geometry);
  }

  function select(route: RouteSelection | null) {
    selected = route;
    trace?.abort();
    trace = null;
    overview()?.setData(EMPTY_GEOMETRY);
    setGlobalStatePropertyWhenReady(map, ROUTE_HIGHLIGHT_COLOR_STATE, route?.color || '');
    setGlobalStatePropertyWhenReady(map, ROUTE_HIGHLIGHT_ID_STATE, route?.id || '');
    chip.show(route);
    markListItems();
    if (route) {
      trace = new AbortController();
      traceOverview(route.id, trace.signal).catch(() => {});
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
