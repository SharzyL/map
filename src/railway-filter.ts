// Railway display filter: settings, persistence and the style rewrite that
// lets MapLibre global state drive it.
//
// The ORM style draws railway lines with ~350 layers. Rather than calling
// setFilter on each of them, the style is rewritten once at load time: every
// layer on a line or station source-layer gets an extra filter clause, and
// every layer on a railway source gets a visibility switch, all reading
// `global-state`. The panel then only flips global state properties. Line
// layers also get the alternative line colors from railway-colors.ts.

import {
  RAILWAY_COLOR_MODES,
  RAILWAY_COLOR_STATE,
  withRailwayLineColors,
  type RailwayColorMode,
} from './railway-colors.js';
import { readStoredSettings, writeStoredSettings } from './stored-settings.js';

export const RAILWAY_FILTER_STORAGE_KEY = 'atlas-realm:railway-filter';

export const RAILWAY_LINE_SOURCE_LAYERS = ['railway_line_high', 'standard_railway_line_low'];

// Station source-layers that say which kind of service they belong to, via
// `station` (stations) or `type` (stop positions, entrances). Platforms carry
// no such attribute and only follow the overlay.
export const RAILWAY_STATION_SOURCE_LAYERS = [
  'standard_railway_text_stations',
  'standard_railway_text_stations_low',
  'standard_railway_text_stations_med',
  'standard_railway_grouped_stations',
  'standard_railway_stop_positions',
  'standard_station_entrances',
];

// Interchange outlines grouping several stops; flagged with the kinds of
// station they contain.
export const RAILWAY_STATION_AREA_SOURCE_LAYER = 'standard_railway_grouped_station_areas';

export const RAILWAY_CATEGORIES = ['main', 'branch', 'industrial', 'service', 'urban', 'tourism', 'other'] as const;
export type RailwayCategory = (typeof RAILWAY_CATEGORIES)[number];

export const RAILWAY_STATUSES = [
  'showConstructionInfrastructure',
  'showProposedInfrastructure',
  'showAbandonedInfrastructure',
  'showRazedInfrastructure',
] as const;
export type RailwayStatus = (typeof RAILWAY_STATUSES)[number];

export const RAILWAY_ELECTRIFICATION_OPTIONS = ['any', 'electrified', 'not-electrified'] as const;
export type RailwayElectrification = (typeof RAILWAY_ELECTRIFICATION_OPTIONS)[number];

export const RAILWAY_MIN_SPEED_OPTIONS = [0, 80, 120, 160, 200, 250] as const;

export const RAILWAY_GAUGE_OPTIONS = ['any', 'standard', 'broad', 'narrow'] as const;
export type RailwayGauge = (typeof RAILWAY_GAUGE_OPTIONS)[number];

export const RAILWAY_TRAFFIC_OPTIONS = ['any', 'passenger', 'freight'] as const;
export type RailwayTraffic = (typeof RAILWAY_TRAFFIC_OPTIONS)[number];

export type RailwayFilterSettings = {
  overlay: boolean;
  // How line colors are chosen; not a filter, so resetting filters keeps it.
  colorBy: RailwayColorMode;
  // Fade tunnels and outline bridges; also kept by a reset.
  tunnelsAndBridges: boolean;
  categories: Record<RailwayCategory, boolean>;
  statuses: Record<RailwayStatus, boolean>;
  minSpeed: number;
  // Keep lines that lack the speed, gauge or traffic data being filtered on.
  includeUnknown: boolean;
  electrification: RailwayElectrification;
  gauge: RailwayGauge;
  traffic: RailwayTraffic;
  // Case-insensitive substring of the line's operator; empty means any.
  operator: string;
};

type StyleLayerLike = {
  id?: string;
  source?: string;
  'source-layer'?: string;
  filter?: unknown;
  layout?: Record<string, unknown>;
  [key: string]: unknown;
};
type StyleLike = {
  layers?: StyleLayerLike[];
  state?: Record<string, { default?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
};

const OVERLAY_STATE = 'railwayOverlay';
const TUNNELS_AND_BRIDGES_STATE = 'railwayTunnelsAndBridges';
const MIN_SPEED_STATE = 'railwayMinSpeed';
const INCLUDE_UNKNOWN_STATE = 'railwayIncludeUnknown';
const ELECTRIFICATION_STATE = 'railwayElectrification';
const GAUGE_STATE = 'railwayGauge';
const TRAFFIC_STATE = 'railwayTraffic';
const OPERATOR_STATE = 'railwayOperator';

export function railwayCategoryStateName(category: RailwayCategory) {
  return `railwayShow${category[0].toUpperCase()}${category.slice(1)}`;
}

// Matches the style's own state defaults (main.ts STATE_DEFAULTS).
export function defaultRailwayFilterSettings(): RailwayFilterSettings {
  return {
    overlay: true,
    colorBy: 'default',
    tunnelsAndBridges: false,
    categories: Object.fromEntries(RAILWAY_CATEGORIES.map((category) => [category, true])) as Record<
      RailwayCategory,
      boolean
    >,
    statuses: {
      showConstructionInfrastructure: true,
      showProposedInfrastructure: true,
      showAbandonedInfrastructure: false,
      showRazedInfrastructure: false,
    },
    minSpeed: 0,
    includeUnknown: true,
    electrification: 'any',
    gauge: 'any',
    traffic: 'any',
    operator: '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Accepts anything (e.g. stale or hand-edited storage) and keeps only valid fields.
export function normalizeRailwayFilterSettings(value: unknown): RailwayFilterSettings {
  const settings = defaultRailwayFilterSettings();
  if (!isRecord(value)) return settings;
  if (typeof value.overlay === 'boolean') settings.overlay = value.overlay;
  if ((RAILWAY_COLOR_MODES as readonly unknown[]).includes(value.colorBy)) {
    settings.colorBy = value.colorBy as RailwayColorMode;
  }
  if (typeof value.tunnelsAndBridges === 'boolean') settings.tunnelsAndBridges = value.tunnelsAndBridges;
  if (isRecord(value.categories)) {
    for (const category of RAILWAY_CATEGORIES) {
      if (typeof value.categories[category] === 'boolean') settings.categories[category] = value.categories[category];
    }
  }
  if (isRecord(value.statuses)) {
    for (const status of RAILWAY_STATUSES) {
      if (typeof value.statuses[status] === 'boolean') settings.statuses[status] = value.statuses[status];
    }
  }
  if (typeof value.minSpeed === 'number' && (RAILWAY_MIN_SPEED_OPTIONS as readonly number[]).includes(value.minSpeed)) {
    settings.minSpeed = value.minSpeed;
  }
  if (typeof value.includeUnknown === 'boolean') settings.includeUnknown = value.includeUnknown;
  if ((RAILWAY_ELECTRIFICATION_OPTIONS as readonly unknown[]).includes(value.electrification)) {
    settings.electrification = value.electrification as RailwayElectrification;
  }
  if ((RAILWAY_GAUGE_OPTIONS as readonly unknown[]).includes(value.gauge)) settings.gauge = value.gauge as RailwayGauge;
  if ((RAILWAY_TRAFFIC_OPTIONS as readonly unknown[]).includes(value.traffic)) {
    settings.traffic = value.traffic as RailwayTraffic;
  }
  if (typeof value.operator === 'string') settings.operator = value.operator.trim();
  return settings;
}

export function loadRailwayFilterSettings(storage?: Pick<Storage, 'getItem'> | null) {
  return readStoredSettings(RAILWAY_FILTER_STORAGE_KEY, normalizeRailwayFilterSettings, storage);
}

export function saveRailwayFilterSettings(settings: RailwayFilterSettings, storage?: Pick<Storage, 'setItem'> | null) {
  writeStoredSettings(RAILWAY_FILTER_STORAGE_KEY, settings, storage);
}

export function railwayFilterGlobalState(settings: RailwayFilterSettings): Record<string, unknown> {
  const state: Record<string, unknown> = {
    [OVERLAY_STATE]: settings.overlay,
    [RAILWAY_COLOR_STATE]: settings.colorBy,
    [TUNNELS_AND_BRIDGES_STATE]: settings.tunnelsAndBridges,
    [MIN_SPEED_STATE]: settings.minSpeed,
    [INCLUDE_UNKNOWN_STATE]: settings.includeUnknown,
    [ELECTRIFICATION_STATE]: settings.electrification,
    [GAUGE_STATE]: settings.gauge,
    [TRAFFIC_STATE]: settings.traffic,
    [OPERATOR_STATE]: settings.operator.toLowerCase(),
  };
  for (const category of RAILWAY_CATEGORIES) {
    state[railwayCategoryStateName(category)] = settings.categories[category];
  }
  for (const status of RAILWAY_STATUSES) {
    state[status] = settings.statuses[status];
  }
  return state;
}

export function countActiveRailwayFilters(settings: RailwayFilterSettings) {
  const defaults = defaultRailwayFilterSettings();
  let count = RAILWAY_CATEGORIES.filter((category) => !settings.categories[category]).length;
  count += RAILWAY_STATUSES.filter((status) => settings.statuses[status] !== defaults.statuses[status]).length;
  if (settings.minSpeed > 0) count += 1;
  if (settings.electrification !== 'any') count += 1;
  if (settings.gauge !== 'any') count += 1;
  if (settings.traffic !== 'any') count += 1;
  if (settings.operator) count += 1;
  return count;
}

const URBAN_FEATURES = ['tram', 'subway', 'light_rail', 'monorail', 'funicular'];
const INDUSTRIAL_USAGES = ['industrial', 'military', 'freight', 'test'];

// Category precedence: urban transit by feature, then service tracks
// (sidings, yards, spurs, crossovers), then the line's usage.
export const RAILWAY_CATEGORY_EXPRESSION = [
  'case',
  ['match', ['get', 'feature'], URBAN_FEATURES, true, false],
  'urban',
  ['has', 'service'],
  'service',
  ['==', ['get', 'usage'], 'main'],
  'main',
  ['==', ['get', 'usage'], 'branch'],
  'branch',
  ['match', ['get', 'usage'], INDUSTRIAL_USAGES, true, false],
  'industrial',
  ['any', ['==', ['get', 'usage'], 'tourism'], ['==', ['get', 'feature'], 'miniature']],
  'tourism',
  'other',
];

const MIN_SPEED = ['to-number', ['global-state', MIN_SPEED_STATE]];
const INCLUDE_UNKNOWN = ['to-boolean', ['global-state', INCLUDE_UNKNOWN_STATE]];

// Standard gauge is 1435 mm; a few lines are tagged a couple of mm off.
const GAUGE_RANGES: Record<Exclude<RailwayGauge, 'any'>, [number, number]> = {
  standard: [1430, 1440],
  broad: [1440.5, 10000],
  narrow: [0, 1429.5],
};

// Dual and triple gauge lines match when any of their gauges is in range.
function gaugeInRange([min, max]: [number, number]) {
  return [
    'any',
    ...[0, 1, 2].map((index) => {
      const gauge = ['to-number', ['get', `gaugeint${index}`]];
      return ['all', ['has', `gaugeint${index}`], ['>=', gauge, min], ['<=', gauge, max]];
    }),
  ];
}

function categoryShown(category: RailwayCategory) {
  return ['to-boolean', ['global-state', railwayCategoryStateName(category)]];
}

export const RAILWAY_LINE_FILTER = [
  'all',
  [
    'match',
    RAILWAY_CATEGORY_EXPRESSION,
    ...RAILWAY_CATEGORIES.filter((category) => category !== 'other').flatMap((category) => [
      category,
      categoryShown(category),
    ]),
    categoryShown('other'),
  ],
  [
    'any',
    ['<=', MIN_SPEED, 0],
    ['case', ['has', 'maxspeed'], ['>=', ['to-number', ['get', 'maxspeed']], MIN_SPEED], INCLUDE_UNKNOWN],
  ],
  [
    'match',
    ['to-string', ['global-state', ELECTRIFICATION_STATE]],
    'electrified',
    ['==', ['get', 'electrification_state'], 'present'],
    'not-electrified',
    ['!=', ['get', 'electrification_state'], 'present'],
    true,
  ],
  [
    'match',
    ['to-string', ['global-state', GAUGE_STATE]],
    ...(['standard', 'broad', 'narrow'] as const).flatMap((gauge) => [
      gauge,
      ['case', ['has', 'gaugeint0'], gaugeInRange(GAUGE_RANGES[gauge]), INCLUDE_UNKNOWN],
    ]),
    true,
  ],
  [
    'match',
    ['to-string', ['global-state', TRAFFIC_STATE]],
    'passenger',
    [
      'case',
      ['has', 'traffic_mode'],
      ['match', ['get', 'traffic_mode'], ['passenger', 'mixed'], true, false],
      INCLUDE_UNKNOWN,
    ],
    'freight',
    [
      'case',
      ['has', 'traffic_mode'],
      ['match', ['get', 'traffic_mode'], ['freight', 'mixed'], true, false],
      INCLUDE_UNKNOWN,
    ],
    true,
  ],
  [
    'any',
    ['==', ['to-string', ['global-state', OPERATOR_STATE]], ''],
    [
      'in',
      ['to-string', ['global-state', OPERATOR_STATE]],
      ['downcase', ['to-string', ['coalesce', ['get', 'operator'], '']]],
    ],
  ],
];

const URBAN_STATION_TYPES = ['subway', 'light_rail', 'monorail', 'funicular', 'tram'];
// Line categories an ordinary rail station can belong to.
const RAIL_STATION_CATEGORIES = ['main', 'branch', 'industrial', 'tourism', 'other'] as const;
const SERVICE_STATION_FEATURES = ['yard', 'junction', 'spur_junction', 'service_station', 'crossover', 'site'];

// Stations follow the line category they serve: urban stops follow urban
// transit, yards and junctions follow service tracks, miniature railway
// stations follow tourism. Ordinary rail stations cannot be tied to a single
// line category, so they stay while any rail line category is shown. Track
// attributes (speed, electrification, gauge, traffic, operator) only apply to
// lines.
export const RAILWAY_STATION_FILTER = [
  'case',
  ['match', ['to-string', ['coalesce', ['get', 'station'], ['get', 'type'], '']], URBAN_STATION_TYPES, true, false],
  categoryShown('urban'),
  ['match', ['to-string', ['coalesce', ['get', 'feature'], '']], SERVICE_STATION_FEATURES, true, false],
  categoryShown('service'),
  ['==', ['get', 'station'], 'miniature'],
  categoryShown('tourism'),
  ['any', ...RAIL_STATION_CATEGORIES.map(categoryShown)],
];

// An interchange outline stays while any kind of station it contains is
// shown. Archives exported before the has_*_station flags existed fall back
// to hiding outlines only when every category is off.
export const RAILWAY_STATION_AREA_FILTER = [
  'case',
  ['has', 'has_urban_station'],
  [
    'any',
    ['all', ['==', ['get', 'has_urban_station'], true], categoryShown('urban')],
    ['all', ['==', ['get', 'has_rail_station'], true], ['any', ...RAIL_STATION_CATEGORIES.map(categoryShown)]],
  ],
  ['any', ...RAILWAY_CATEGORIES.map(categoryShown)],
];

// Hides a layer while the railway overlay is switched off.
export function withRailwayOverlayVisibility<T extends StyleLayerLike>(layer: T): T {
  const layout = { ...(layer.layout || {}) };
  const originalVisibility = structuredClone(layout.visibility ?? 'visible');
  layout.visibility = ['case', ['to-boolean', ['global-state', OVERLAY_STATE]], originalVisibility, 'none'];
  return { ...layer, layout };
}

// The style's tunnel and bridge marks: a pale cover over tunnels and dark
// railings along bridges, for current lines and OpenHistoricalMap ones alike.
const TUNNEL_AND_BRIDGE_MARK = /^railway_.*_(tunnel_cover|bridge_railing)$/;

// Hides a tunnel or bridge mark while those marks are switched off.
export function withTunnelAndBridgeMarks<T extends StyleLayerLike>(layer: T): T {
  if (!TUNNEL_AND_BRIDGE_MARK.test(layer.id || '')) return layer;
  const layout = { ...(layer.layout || {}) };
  const originalVisibility = structuredClone(layout.visibility ?? 'visible');
  layout.visibility = ['case', ['to-boolean', ['global-state', TUNNELS_AND_BRIDGES_STATE]], originalVisibility, 'none'];
  return { ...layer, layout };
}

function withFilter(layer: StyleLayerLike, clause: unknown[]): StyleLayerLike {
  const filter = layer.filter ? ['all', layer.filter, clause] : clause;
  return { ...layer, filter };
}

// Wires the filter into a style: layers on `railwaySources` follow the
// overlay switch, line and station layers get their filter clause (line
// layers also the alternative colors), tunnel and bridge marks follow their
// switch, and the global state defaults come from `settings` so the first
// render already matches them.
export function applyRailwayFilterToStyle<T extends StyleLike>(
  style: T,
  railwaySources: readonly string[],
  settings: RailwayFilterSettings,
): T {
  const sources = new Set(railwaySources);
  const lineSourceLayers = new Set(RAILWAY_LINE_SOURCE_LAYERS);
  const stationSourceLayers = new Set(RAILWAY_STATION_SOURCE_LAYERS);
  const layers = (style.layers || []).map((original) => {
    const layer = withTunnelAndBridgeMarks(original);
    if (!layer.source || !sources.has(layer.source)) return layer;
    const withVisibility = withRailwayOverlayVisibility(layer);
    const sourceLayer = layer['source-layer'] || '';
    if (lineSourceLayers.has(sourceLayer)) {
      return withFilter(withRailwayLineColors(withVisibility), RAILWAY_LINE_FILTER);
    }
    if (stationSourceLayers.has(sourceLayer)) return withFilter(withVisibility, RAILWAY_STATION_FILTER);
    if (sourceLayer === RAILWAY_STATION_AREA_SOURCE_LAYER)
      return withFilter(withVisibility, RAILWAY_STATION_AREA_FILTER);
    return withVisibility;
  });
  const state = { ...(style.state || {}) };
  for (const [name, value] of Object.entries(railwayFilterGlobalState(settings))) {
    state[name] = { ...(state[name] || {}), default: value };
  }
  return { ...style, layers, state };
}
