// Alternative railway line colors: by route color, maximum speed,
// electrification or gauge instead of the style's usage colors.
//
// Like the railway filter, the style is rewritten once at load time: the fill
// of every active railway line layer and its direction arrows get a `match` on
// global state that keeps the original color for 'usage'. 'default' draws a
// line in its route's color and falls back to the usage colors. The other
// modes first sort a line into a legend class, so the map and the panel legend
// read the same table.
//
// The palettes were checked for color vision deficiency: speed follows
// viridis, darkening from yellow to blue with the high-speed purple at 350
// km/h and a dark plum above it (the three fastest bands stay apart under
// protan and deutan simulation), electrification and gauge keep every pair of
// hues apart, and grays mark lines without data.
import { mapZoomOutputs } from './map-layers.js';

export const RAILWAY_COLOR_MODES = ['default', 'usage', 'speed', 'electrification', 'gauge'] as const;
export type RailwayColorMode = (typeof RAILWAY_COLOR_MODES)[number];
export type RailwayLegendMode = Exclude<RailwayColorMode, 'default' | 'usage'>;

export const RAILWAY_COLOR_STATE = 'railwayColorBy';

export type RailwayColorClass = {
  key: string;
  label: string;
  color: string;
  // Hover color for classes the default red hover would not stand out from.
  hover?: string;
};

const HOVER = '#ff0000';
const ALTERNATIVE_HOVER = '#ffc107';
const NO_DATA = '#b8b8b8';

export const RAILWAY_COLOR_LEGENDS: Record<RailwayLegendMode, RailwayColorClass[]> = {
  // The filter's minimum speed options, then finer steps for high-speed lines.
  speed: [
    { key: 'lt80', label: 'Under 80 km/h', color: '#ddad09' },
    { key: '80', label: '80–119 km/h', color: '#93ad05' },
    { key: '120', label: '120–159 km/h', color: '#15a64f' },
    { key: '160', label: '160–199 km/h', color: '#058b77' },
    { key: '200', label: '200–249 km/h', color: '#02717e' },
    { key: '250', label: '250–299 km/h', color: '#005783' },
    { key: '300', label: '300–349 km/h', color: '#122ba2' },
    { key: '350', label: '350 km/h', color: '#9b19d4' },
    { key: 'gt350', label: 'Over 350 km/h', color: '#3c013c' },
    { key: 'unknown', label: 'No speed data', color: NO_DATA },
  ],
  electrification: [
    { key: 'ac25', label: 'AC 20–25 kV', color: '#a90017', hover: ALTERNATIVE_HOVER },
    { key: 'ac15', label: 'AC 15 kV 16.7 Hz', color: '#68cb6e' },
    { key: 'ac-other', label: 'Other AC', color: '#b58300' },
    { key: 'dc3', label: 'DC 3 kV', color: '#75aaff' },
    { key: 'dc1500', label: 'DC 1.5 kV', color: '#008caa' },
    { key: 'dc-low', label: 'DC up to 1 kV', color: '#891e90' },
    { key: 'electrified', label: 'Electrified, system unknown', color: '#3d3d3d' },
    { key: 'none', label: 'Not electrified', color: '#8f8f8f' },
    { key: 'unknown', label: 'No electrification data', color: NO_DATA },
  ],
  // By a line's first gauge; the popup lists every gauge of dual-gauge lines.
  gauge: [
    { key: 'narrow', label: 'Narrow (under 900 mm)', color: '#ef82e7' },
    { key: 'metre', label: 'Metre (900–1049 mm)', color: '#623bab' },
    { key: 'cape', label: 'Cape (1050–1099 mm)', color: '#76c963' },
    { key: 'scotch', label: 'Scotch (1372 mm)', color: '#9769dc' },
    { key: 'standard', label: 'Standard (1435 mm)', color: '#3b4252' },
    { key: 'russian', label: 'Russian (1520 mm)', color: '#a90017', hover: ALTERNATIVE_HOVER },
    { key: 'irish', label: 'Irish (1600 mm)', color: '#b86000' },
    { key: 'iberian', label: 'Iberian & Indian (1668–1676 mm)', color: '#008f90' },
    { key: 'other', label: 'Other gauges', color: '#8f8f8f' },
    { key: 'unknown', label: 'No gauge data', color: NO_DATA },
  ],
};

const SPEED_CLASS = [
  'case',
  ['has', 'maxspeed'],
  // 350 is its own band: Chinese high-speed lines run at exactly 350 km/h.
  [
    'step',
    ['to-number', ['get', 'maxspeed'], 0],
    'lt80',
    80,
    '80',
    120,
    '120',
    160,
    '160',
    200,
    '200',
    250,
    '250',
    300,
    '300',
    350,
    '350',
    350.5,
    'gt350',
  ],
  'unknown',
];

const VOLTAGE = ['to-number', ['coalesce', ['get', 'voltage'], 0], 0];
const FREQUENCY = ['to-number', ['coalesce', ['get', 'frequency'], 0], 0];
// Lines tagged without a frequency: high voltages are AC, low ones DC.
const IS_AC = ['case', ['has', 'frequency'], ['>', FREQUENCY, 0], ['>=', VOLTAGE, 6000]];

// The low-zoom tiles carry no voltage, so zoomed far out electrified lines
// only show as electrified.
const ELECTRIFICATION_CLASS = [
  'match',
  ['to-string', ['coalesce', ['get', 'electrification_state'], '']],
  'present',
  [
    'case',
    ['<=', VOLTAGE, 0],
    'electrified',
    IS_AC,
    [
      'case',
      ['>=', VOLTAGE, 20000],
      'ac25',
      [
        'all',
        ['>=', VOLTAGE, 14000],
        ['<=', VOLTAGE, 16000],
        ['any', ['!', ['has', 'frequency']], ['<', FREQUENCY, 20]],
      ],
      'ac15',
      'ac-other',
    ],
    ['>=', VOLTAGE, 3000],
    'dc3',
    ['>', VOLTAGE, 1000],
    'dc1500',
    'dc-low',
  ],
  // Construction and proposed are electrification planned on a line without it.
  ['no', 'deelectrified', 'abandoned', 'construction', 'proposed'],
  'none',
  'unknown',
];

// Ranges match the railway filter's: standard gauge covers lines tagged a few
// mm off 1435.
const GAUGE_CLASS = [
  'case',
  ['has', 'gaugeint0'],
  [
    'step',
    ['to-number', ['get', 'gaugeint0'], 0],
    'unknown',
    1,
    'narrow',
    900,
    'metre',
    1050,
    'cape',
    1100,
    'other',
    1360,
    'scotch',
    1385,
    'other',
    1430,
    'standard',
    1440.5,
    'other',
    1495,
    'russian',
    1535,
    'other',
    1580,
    'irish',
    1610.5,
    'other',
    1660,
    'iberian',
    1690.5,
    'other',
  ],
  'unknown',
];

export const RAILWAY_COLOR_CLASS_EXPRESSIONS: Record<RailwayLegendMode, unknown[]> = {
  speed: SPEED_CLASS,
  electrification: ELECTRIFICATION_CLASS,
  gauge: GAUGE_CLASS,
};

const MODE = ['to-string', ['global-state', RAILWAY_COLOR_STATE]];
const LEGEND_MODES = Object.keys(RAILWAY_COLOR_LEGENDS) as RailwayLegendMode[];

function byMode(valueFor: (mode: RailwayLegendMode) => unknown, fallback: string) {
  return ['match', MODE, ...LEGEND_MODES.flatMap((mode) => [mode, valueFor(mode)]), fallback];
}

const COLOR = byMode(
  (mode) => [
    'match',
    RAILWAY_COLOR_CLASS_EXPRESSIONS[mode],
    ...RAILWAY_COLOR_LEGENDS[mode].flatMap(({ key, color }) => [key, color]),
    NO_DATA,
  ],
  NO_DATA,
);

const HOVER_COLOR = byMode((mode) => {
  const alternatives = RAILWAY_COLOR_LEGENDS[mode].filter(({ hover }) => hover);
  if (alternatives.length === 0) return HOVER;
  return [
    'match',
    RAILWAY_COLOR_CLASS_EXPRESSIONS[mode],
    ...alternatives.flatMap(({ key, hover }) => [key, hover]),
    HOVER,
  ];
}, HOVER);

const IS_HOVERED = ['boolean', ['feature-state', 'hover'], false];

export const RAILWAY_ATTRIBUTE_COLOR = ['case', IS_HOVERED, HOVER_COLOR, COLOR];

// A line's route color (OSM `colour`) is the first one set among its first few
// `line_routes`: groups of `id\x1Ecolor\x1Elabel` joined by `\x1D` and sorted
// by route id, so track shared by several routes takes the color of one of
// them. Lines without a colored route, including every line in the low-zoom
// tiles (they carry no routes), get an empty string.
const ROUTES_CHECKED = 4;
const ROUTES = ['var', 'routes'];
const routeColorAt = (index: number) => ['at', 1, ['split', ['at', index, ROUTES], '\u001e']];

const ROUTE_COLOR = [
  'case',
  ['has', 'line_routes'],
  [
    'let',
    'routes',
    ['split', ['to-string', ['get', 'line_routes']], '\u001d'],
    [
      'case',
      ...Array.from({ length: ROUTES_CHECKED }, (_, index) => [
        ['all', ['>', ['length', ROUTES], index], ['!=', routeColorAt(index), '']],
        routeColorAt(index),
      ]).flat(),
      '',
    ],
  ],
  '',
];

const ROUTE_RGBA = ['var', 'routeRgba'];

// Red routes hover in amber, like the red legend classes.
const ROUTE_HOVER_COLOR = [
  'let',
  'routeRgba',
  ['to-rgba', ['to-color', ['var', 'routeColor'], NO_DATA]],
  [
    'case',
    ['all', ['>=', ['at', 0, ROUTE_RGBA], 150], ['<', ['at', 1, ROUTE_RGBA], 110], ['<', ['at', 2, ROUTE_RGBA], 110]],
    ALTERNATIVE_HOVER,
    HOVER,
  ],
];

// Service tracks (yards, sidings, spurs, crossovers) without a route color are
// gray rather than their usage color, such as the metro blue for metro depots.
const SERVICE_TRACK_COLOR = ['case', ['==', ['global-state', 'theme'], 'light'], '#9a9a9a', '#6b6b6b'];

// A route color MapLibre cannot parse also keeps the original color.
function withRouteColor(original: unknown) {
  return [
    'let',
    'routeColor',
    ROUTE_COLOR,
    [
      'case',
      ['==', ['var', 'routeColor'], ''],
      ['case', ['!', ['has', 'service']], original, IS_HOVERED, HOVER, SERVICE_TRACK_COLOR],
      IS_HOVERED,
      ROUTE_HOVER_COLOR,
      ['to-color', ['var', 'routeColor'], original],
    ],
  ];
}

// Layers built by the style's railwayLine(): fills of lines in use (abandoned,
// razed and disused tracks keep their muted colors, ferries their own) and the
// preferred direction arrows drawn over them.
const RECOLORED_FILL = /^railway_line_.*_fill_(present|construction|proposed|preserved)$/;
const RECOLORED_ARROWS = /^railway_line_.*_preferred_direction$/;

type StyleLayerLike = { id?: string; paint?: Record<string, unknown>; [key: string]: unknown };

export function withRailwayLineColors<T extends StyleLayerLike>(layer: T): T {
  const id = layer.id || '';
  const property = RECOLORED_FILL.test(id) ? 'line-color' : RECOLORED_ARROWS.test(id) ? 'icon-color' : null;
  if (!property || layer.paint?.[property] === undefined) return layer;
  const color = mapZoomOutputs(layer.paint[property], (original) => [
    'match',
    MODE,
    'usage',
    original,
    'default',
    withRouteColor(original),
    RAILWAY_ATTRIBUTE_COLOR,
  ]);
  return { ...layer, paint: { ...layer.paint, [property]: color } };
}

// Station icons, after metro maps: a dot for a station on one line, in the
// line's color in 'default' mode and dark gray otherwise, or a white dot ringed
// in dark gray where lines of different colors meet. Major stations are a
// little larger, and stations not in use are light gray dots. The colors come
// from `station_routes` (the same `id\x1Ecolor\x1Elabel` groups as
// `line_routes`, sorted by route id); each line usually has a route per
// direction and service pattern, so a station counts as an interchange when
// the colors set among its first routes differ by more than a shade (OSM
// gives the Hibiya Line's through services a different gray, for example).
// Stations without a colored route are dark gray dots.
const STATION_ROUTES_CHECKED = 16;
const SAME_LINE_CHANNEL_DIFFERENCE = 48;
const STATION_ICON_LAYERS = new Set([
  'railway_text_stations_low1',
  'railway_text_stations_low2',
  'railway_text_stations_med',
  'railway_text_stations',
]);
const STATION_COLOR = ['var', 'stationColor'];
const STATION_KIND = ['var', 'stationKind'];
const stationRouteColorAt = (index: number) => ['var', `stationRouteColor${index}`];
const STATION_ROUTE_INDEXES = Array.from({ length: STATION_ROUTES_CHECKED }, (_, index) => index);
const rgba = (color: unknown) => ['to-rgba', ['to-color', color, '#000000']];

function isOtherLineColor(index: number) {
  const color = ['var', `stationRouteRgba${index}`];
  const first = ['var', 'stationRgba'];
  const channelDifference = (channel: number) => ['abs', ['-', ['at', channel, color], ['at', channel, first]]];
  return [
    'all',
    ['!=', stationRouteColorAt(index), ''],
    [
      'let',
      `stationRouteRgba${index}`,
      rgba(stationRouteColorAt(index)),
      ['>', ['max', channelDifference(0), channelDifference(1), channelDifference(2)], SAME_LINE_CHANNEL_DIFFERENCE],
    ],
  ];
}

// Binds stationKind ('line', 'interchange', 'plain' or 'inactive') and
// stationColor for `body`.
function withStationKind(body: unknown) {
  const routes = ['var', 'stationRoutes'];
  return [
    'let',
    'stationRoutes',
    ['split', ['to-string', ['coalesce', ['get', 'station_routes'], '']], '\u001d'],
    [
      'let',
      ...STATION_ROUTE_INDEXES.flatMap((index) => [
        `stationRouteColor${index}`,
        [
          'case',
          ['all', ['has', 'station_routes'], ['>', ['length', routes], index]],
          ['downcase', ['at', 1, ['split', ['at', index, routes], '\u001e']]],
          '',
        ],
      ]),
      [
        'let',
        'stationColor',
        [
          'case',
          ...STATION_ROUTE_INDEXES.flatMap((index) => [
            ['!=', stationRouteColorAt(index), ''],
            stationRouteColorAt(index),
          ]),
          '',
        ],
        [
          'let',
          'stationKind',
          [
            'case',
            ['!=', ['coalesce', ['get', 'state'], 'present'], 'present'],
            'inactive',
            ['==', STATION_COLOR, ''],
            'plain',
            ['let', 'stationRgba', rgba(STATION_COLOR), ['any', ...STATION_ROUTE_INDEXES.map(isOtherLineColor)]],
            'interchange',
            'line',
          ],
          body,
        ],
      ],
    ],
  ];
}

const IS_LIGHT_THEME = ['==', ['global-state', 'theme'], 'light'];
const INTERCHANGE_RING = ['case', IS_LIGHT_THEME, '#334155', '#cbd5e1'];
const INTERCHANGE_FILL = ['case', IS_LIGHT_THEME, '#ffffff', '#1e293b'];
const PLAIN_STATION = ['case', IS_LIGHT_THEME, '#3f3f46', '#d4d4d8'];
const INACTIVE_STATION = ['case', IS_LIGHT_THEME, '#a1a1aa', '#71717a'];

export function withRailwayStationColors<T extends StyleLayerLike>(layer: T): T {
  if (!STATION_ICON_LAYERS.has(layer.id || '')) return layer;
  const paint = { ...layer.paint };
  const layout = { ...(layer.layout as Record<string, unknown>) };
  paint['icon-color'] = withStationKind([
    'match',
    STATION_KIND,
    'line',
    ['match', MODE, 'default', ['to-color', STATION_COLOR, PLAIN_STATION], PLAIN_STATION],
    'interchange',
    INTERCHANGE_FILL,
    'inactive',
    INACTIVE_STATION,
    PLAIN_STATION,
  ]);
  if (paint['icon-halo-color'] !== undefined) {
    paint['icon-halo-color'] = mapZoomOutputs(paint['icon-halo-color'], (original) =>
      withStationKind([
        'case',
        ['all', ['==', STATION_KIND, 'interchange'], ['!', IS_HOVERED]],
        INTERCHANGE_RING,
        original,
      ]),
    );
  }
  layout['icon-image'] = 'sdf:general/station-normal';
  const size = layout['icon-size'] ?? 1;
  layout['icon-size'] = mapZoomOutputs(size, (original) => [
    'case',
    ['==', ['get', 'station_size'], 'large'],
    ['*', original, 1.3],
    original,
  ]);
  return { ...layer, paint, layout };
}
