/**
 * OpenRailwayMap-vector popup system — standalone replication.
 *
 * Replicates the DOM-building popup from proxy/js/ui.js (popupContent)
 * with the feature catalog system from proxy/js/features.mjs.
 *
 * Usage:
 *   import { installOrmPopups } from './popup.js';
 *   installOrmPopups(map, featuresCatalog);
 */

import { renderMarkdown } from './markdown.js';
import { ROUTE_SELECT_EVENT, type RouteSelection } from './route-highlight.js';
import type { LineListQuery, LineLists } from './route-trace.js';
import { buildWeatherDashboardUrl, buildWeatherRouteSummary } from './weather-dashboard.js';

// ---------------------------------------------------------------------------
// External link templates
// ---------------------------------------------------------------------------
const LINKS = {
  wikimedia_commons: 'https://commons.wikimedia.org/wiki/%s',
  wikipedia: 'https://wikipedia.org/wiki/%s',
  wikidata: 'https://www.wikidata.org/wiki/%s',
  mapillary: 'https://www.mapillary.com/app/?pKey=%s',
};

const FEATURE_LINKS = {
  view: 'https://www.openstreetmap.org/{osm_type}/{osm_id}',
  edit: 'https://www.openstreetmap.org/edit?{osm_type}={osm_id}',
};

type JsonRecord = Record<string, unknown>;
type OsmElementType = 'node' | 'way' | 'relation';
type Coordinates = [number, number];
type FeatureContent = {
  name?: string;
  type?: string;
  country?: string;
  index?: number;
};
type FormatSpec = {
  map?: {
    key?: { format?: FormatSpec };
    value?: { format?: FormatSpec };
  };
  template?: string;
  lookup?: string;
  country_prefix?: unknown;
  // Unit-aware formatting for the structured popup sections.
  unit?: 'voltage' | 'frequency' | 'current' | 'speed' | 'gauge';
  // Value labels; unlisted values fall back to `humanize`.
  labels?: Record<string, string>;
  // 'words' turns light_rail into "Light rail"; 'code' upper-cases short codes (pzb -> PZB, etcs_2 -> ETCS 2).
  humanize?: 'words' | 'code';
  // Splits one string value into several (e.g. gauges are joined with ', ').
  separator?: string;
};
type ListSpec = {
  colorProperty: string;
  labelProperty: string;
  // Shown after the label, e.g. a railway line's number.
  detailProperty?: string;
  properties: string[];
  routeIdProperty?: string;
  selectTitle?: string;
  // Shown as a row of this section (catalogs with sections) instead of below them.
  section?: string;
};
type FeatureLinks = typeof FEATURE_LINKS;
type FeaturePropertyDefinition = {
  name?: string;
  format?: FormatSpec;
  link?: string;
  paragraph?: boolean;
  list?: ListSpec;
  description?: string;
  // Skip the row when it would repeat this other property's value.
  hideIfSameAs?: string;
};
// A row joining several properties with ' · '. A part that lists several
// properties joins their values with `separator` (a space by default) and puts
// `prefix` before them, e.g. "planned 25 kV 50 Hz". A property that is just
// true shows its name ("High speed").
type CombinedRowPart = string | { properties: string[]; prefix?: string; separator?: string };
type CombinedRow = { name: string; parts: CombinedRowPart[] };
type PopupSection = {
  title: string;
  properties: Array<string | CombinedRow>;
};
type FeatureCatalog = {
  featureProperty?: string;
  colorProperty?: string;
  labelProperties?: string[];
  featureLinks?: FeatureLinks;
  features?: Record<string, FeatureContent>;
  properties?: Record<string, FeaturePropertyDefinition>;
  // When set, properties render as titled sections of rows instead of badges,
  // followed by an "Other" section for any property not listed here.
  sections?: PopupSection[];
  // Internal properties never shown in the "Other" section.
  hiddenProperties?: string[];
  // OSM element type of features without an osm_type property (railway lines
  // are always ways, so their tiles leave it out).
  osmType?: OsmElementType;
};
type FeaturesCatalog = Record<string, FeatureCatalog>;
type FormattedValue = string | Array<[string, string]>;
type PopupPropertyValue = {
  title: string;
  value: unknown;
  body: Array<[string | null, string]>;
  paragraph?: boolean;
  list?: ListSpec;
  link?: string;
  tooltip?: string;
};
type CommonsImageData = {
  file_name: string;
  thumbnail_url: string;
  view_url: string;
  description: string;
  attribution: string;
  license: string;
  license_url: string;
};
type LngLatLike = {
  distanceTo(other: LngLatLike): number;
  toArray(): Coordinates;
};
type MaplibreLike = {
  LngLat: {
    convert(value: unknown): LngLatLike;
  };
  Popup: new (options?: JsonRecord) => PopupBuilderLike;
};
type PopupLike = {
  remove(): void;
};
type PopupBuilderLike = PopupLike & {
  setLngLat(coordinates: unknown): PopupBuilderLike;
  getLngLat(): unknown;
  getElement(): HTMLElement;
  setDOMContent(node: Node): PopupBuilderLike;
  addTo(map: MapLike): PopupBuilderLike;
  on(type: 'close', listener: () => void): unknown;
};
type RenderedFeatureLike = {
  id?: string | number;
  source: string;
  sourceLayer?: string;
  properties?: JsonRecord;
  geometry: {
    type: string;
    coordinates?: unknown;
  };
};
type FeatureStateTarget = {
  source: string;
  sourceLayer?: string;
  id: string | number;
};
type PopupMapEvent = {
  point: unknown;
  lngLat: unknown;
  originalEvent?: Event & {
    weatherPickerHandled?: boolean;
    routingHandled?: boolean;
    annotationHandled?: boolean;
  };
};
type MapLike = {
  getContainer(): HTMLElement;
  getCanvas(): HTMLCanvasElement;
  getZoom(): number;
  queryRenderedFeatures(point: unknown): RenderedFeatureLike[];
  setFeatureState(feature: FeatureStateTarget, state: JsonRecord): void;
  on(type: 'mousemove' | 'click', listener: (event: PopupMapEvent) => void): void;
  on(type: 'move' | 'resize', listener: () => void): void;
  off(type: 'move' | 'resize', listener: () => void): void;
  project(lngLat: unknown): { y: number };
};

// MapLibre puts a box above its point when it fits there and below otherwise,
// judging by the box's height when it opens or the map moves. A box taller than
// the room on both sides ran off the map with its end out of reach, and photos
// or line lists arriving later grew it past where it was placed. So the box is
// capped at the room on the roomier side of its point (CSS
// --orm-popup-room, kept current as the map moves), and placed again whenever
// its size changes.
const POPUP_CHROME = 20 + 10 + 30 + 8; // offset, tip, content padding, margin

export function popupRoom(pointY: number, mapHeight: number) {
  return Math.max(120, Math.max(pointY, mapHeight - pointY) - POPUP_CHROME);
}

function keepPopupInView(map: MapLike, popup: PopupBuilderLike) {
  const element = popup.getElement();
  const fit = () => {
    const room = popupRoom(map.project(popup.getLngLat()).y, map.getContainer().clientHeight);
    element.style.setProperty('--orm-popup-room', `${Math.round(room)}px`);
  };
  const place = () => popup.setLngLat(popup.getLngLat());
  const refit = () => {
    fit();
    place();
  };
  refit();
  map.on('move', fit);
  map.on('resize', refit);
  const content = element.querySelector('.maplibregl-popup-content');
  const observer = typeof ResizeObserver === 'undefined' || !content ? null : new ResizeObserver(place);
  if (observer && content) observer.observe(content);
  popup.on('close', () => {
    map.off('move', fit);
    map.off('resize', refit);
    observer?.disconnect();
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

function firstRecord(value: unknown): JsonRecord | null {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : null;
}

function stripHtml(value: unknown): string {
  return stringValue(value).replace(/<[^>]*>/g, '');
}

function metadataValue(metadata: JsonRecord, key: string): string {
  const item = metadata[key];
  return isRecord(item) ? stringValue(item.value) : '';
}

// ---------------------------------------------------------------------------
// Country flag emoji helper
// ---------------------------------------------------------------------------
function getFlagEmoji(countryCode: string) {
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0));
  return codePoints.length ? String.fromCodePoint(...(codePoints as [number, ...number[]])) : '';
}

// ---------------------------------------------------------------------------
// Natural sort comparator
// ---------------------------------------------------------------------------
function naturalSort(a: string | number, b: string | number) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// DOM helper — mirrors ORM's createDomElement()
// ---------------------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  container?: Element,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tagName);
  if (className !== undefined) e.className = className;
  if (container) container.appendChild(e);
  return e;
}

// ---------------------------------------------------------------------------
// Construct catalog key from a property value
// Removes variable parts in {} braces and icon position after @
// ---------------------------------------------------------------------------
function constructCatalogKey(propertyValue: unknown) {
  if (typeof propertyValue !== 'string') {
    return {
      catalogKey: propertyValue === undefined || propertyValue === null ? undefined : String(propertyValue),
      keyVariable: null,
    };
  }
  const catalogKey = propertyValue.replace(/\{[^}]+}/, '{}').replace(/@([^|]+|$)/g, '');
  const keyVariable = propertyValue.match(/\{([^}]+)}/)?.[1] ?? null;
  return { catalogKey, keyVariable };
}

// ---------------------------------------------------------------------------
// Determine default OSM element type from properties / feature content
// ---------------------------------------------------------------------------
function determineDefaultOsmType(
  properties: JsonRecord,
  featureContent?: FeatureContent,
  catalogOsmType?: OsmElementType,
): OsmElementType {
  if (properties.osm_type) {
    return properties.osm_type === 'N' ? 'node' : properties.osm_type === 'R' ? 'relation' : 'way';
  }
  if (catalogOsmType) return catalogOsmType;
  const featureType = (featureContent && featureContent.type) || 'point';
  return featureType === 'point' ? 'node' : featureType === 'relation' ? 'relation' : 'way';
}

// ---------------------------------------------------------------------------
// Parse osm_id / osm_type into an array of {id, type} objects
// Multiple IDs are separated by \u001e (record separator)
// ---------------------------------------------------------------------------
function determineOsmFeatures(
  properties: JsonRecord,
  featureContent?: FeatureContent,
  catalogOsmType?: OsmElementType,
): Array<{ id: string; type: OsmElementType }> {
  const osmIds = properties.osm_id ? String(properties.osm_id).split('\u001e') : [];
  const defaultOsmType = determineDefaultOsmType(properties, featureContent, catalogOsmType);
  const osmTypes = properties.osm_type ? String(properties.osm_type).split('\u001e') : [];

  return osmIds.map((osm_id, index) => {
    const osmType: OsmElementType =
      osmTypes.length > index
        ? osmTypes[index] === 'N'
          ? 'node'
          : osmTypes[index] === 'R'
            ? 'relation'
            : 'way'
        : defaultOsmType;
    return { id: osm_id, type: osmType };
  });
}

// ---------------------------------------------------------------------------
// Value humanizing for the structured popup sections
// ---------------------------------------------------------------------------
function humanizeWords(value: string) {
  const text = value.replace(/[_-]+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// Short lowercase codes are acronyms (pzb, kvb, gsm-r, etcs_2); longer words are not.
function humanizeCode(value: string) {
  const letters = value.replace(/[^a-z]/gi, '');
  if (letters.length > 0 && letters.length <= 5) return value.replace(/_/g, ' ').toUpperCase();
  return humanizeWords(value);
}

function formatUnit(value: string, unit: NonNullable<FormatSpec['unit']>) {
  const number = Number(value);
  if (value === '' || !Number.isFinite(number)) return value;
  switch (unit) {
    case 'voltage':
      return number >= 1000 ? `${Number((number / 1000).toFixed(2))} kV` : `${number} V`;
    case 'frequency':
      return number === 0 ? 'DC' : `${Number(number.toFixed(2))} Hz`;
    case 'current':
      return `${number} A`;
    case 'speed':
      return `${Number(number.toFixed(1))} km/h`;
    case 'gauge':
      return `${number} mm`;
  }
}

// ---------------------------------------------------------------------------
// Format a property value according to its format specification
// ---------------------------------------------------------------------------
function formatPropertyValue(value: unknown, format?: FormatSpec, features?: FeaturesCatalog): FormattedValue {
  if (format?.map) {
    const keyFormat = format.map.key?.format;
    const valueFormat = format.map.value?.format;
    let sortKey = (v: string): string | number => v;
    if (keyFormat?.lookup && features?.[keyFormat.lookup]?.features) {
      const catalog = features[keyFormat.lookup].features ?? {};
      sortKey = (v: string) => catalog[v]?.index ?? Number.MAX_SAFE_INTEGER;
    }

    return String(value)
      .split('\u001d')
      .map((item) => item.split('\u001e'))
      .toSorted(([keyA], [keyB]) => naturalSort(sortKey(keyA), sortKey(keyB)))
      .map(([key, val]) => [
        String(formatPropertyValue(key, keyFormat, features)),
        String(formatPropertyValue(val, valueFormat, features)),
      ]);
  }

  return String(value)
    .split('\u001e')
    .flatMap((part) => (format?.separator ? part.split(format.separator) : [part]))
    .map((stringValue) => {
      if (!format) {
        return stringValue;
      } else if (format.unit) {
        return formatUnit(stringValue, format.unit);
      } else if (format.labels || format.humanize) {
        return (
          format.labels?.[stringValue] ??
          (format.humanize === 'code' ? humanizeCode(stringValue) : humanizeWords(stringValue))
        );
      } else if (format.template) {
        return format.template
          .replace('%s', () => stringValue)
          .replace(/%(\.(\d+))?d/, (_1, _2, decimals: string | undefined) => Number(value).toFixed(Number(decimals)));
      } else if (format.lookup) {
        const lookupCatalog = features?.[format.lookup];
        if (!lookupCatalog) {
          return stringValue;
        }
        const { catalogKey: lookUpCatalogKey, keyVariable: lookUpKeyVariable } = constructCatalogKey(value);
        const lookedUpValue = lookUpCatalogKey ? lookupCatalog.features?.[lookUpCatalogKey] : undefined;
        if (!lookedUpValue) {
          return stringValue;
        }
        return `${lookedUpValue.name}${lookUpKeyVariable ? ` (${lookUpKeyVariable})` : ''}${lookedUpValue.country ? ` ${getFlagEmoji(lookedUpValue.country)}` : ''}`;
      } else if (format.country_prefix) {
        if (stringValue && stringValue.length >= 3 && stringValue[2] === ':') {
          return stringValue.substr(3);
        }
        return stringValue;
      }
      return stringValue;
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// Closest point on a line to a given point (for LineString popup placement)
// ---------------------------------------------------------------------------
function closestPointOnLine(maplibregl: MaplibreLike, point: unknown, line: unknown[]): Coordinates | null {
  const lngLatPoint = maplibregl.LngLat.convert(point);
  const { closest0, closest1 } = line
    .map((item) => maplibregl.LngLat.convert(item))
    .reduce<{
      closest0: LngLatLike | null;
      closest1: LngLatLike | null;
    }>(
      (acc, cur) => {
        const d = lngLatPoint.distanceTo(cur);
        if (acc.closest0 == null || d < lngLatPoint.distanceTo(acc.closest0)) {
          return { closest0: cur, closest1: acc.closest0 };
        } else if (acc.closest1 == null || d < lngLatPoint.distanceTo(acc.closest1)) {
          return { closest0: acc.closest0, closest1: cur };
        }
        return acc;
      },
      { closest0: null, closest1: null },
    );

  if (closest0 == null && closest1 == null) return null;

  const closest0Array = closest0.toArray();
  if (closest1 == null) return closest0Array;
  const closest1Array = closest1.toArray();
  const pt = lngLatPoint.toArray();

  const abx = closest1Array[0] - closest0Array[0];
  const aby = closest1Array[1] - closest0Array[1];
  const acx = pt[0] - closest0Array[0];
  const acy = pt[1] - closest0Array[1];
  const coeff = (abx * acx + aby * acy) / (abx * abx + aby * aby);
  return [closest0Array[0] + abx * coeff, closest0Array[1] + aby * coeff];
}

// ---------------------------------------------------------------------------
// Build a feature catalog for the layers in our app.
//
// The catalog is keyed by "${source}-${sourceLayer}".
// The upstream ORM features.mjs generates this at build time from YAML;
// here we define the subset we need inline.
// ---------------------------------------------------------------------------
export function buildFeatureCatalog() {
  const railwayLineFeatures: FeatureCatalog = {
    labelProperties: ['ref', 'name'],
    osmType: 'way',
    featureLinks: FEATURE_LINKS,
    features: {
      rail: { name: 'Railway', type: 'line' },
      tram: { name: 'Tram', type: 'line' },
      light_rail: { name: 'Light rail', type: 'line' },
      subway: { name: 'Subway', type: 'line' },
      monorail: { name: 'Monorail', type: 'line' },
      narrow_gauge: { name: 'Narrow gauge railway', type: 'line' },
      miniature: { name: 'Miniature railway', type: 'line' },
      funicular: { name: 'Funicular', type: 'line' },
      ferry: { name: 'Ferry', type: 'line' },
      construction: { name: 'Railway under construction', type: 'line' },
      proposed: { name: 'Proposed railway', type: 'line' },
      disused: { name: 'Disused railway', type: 'line' },
      abandoned: { name: 'Abandoned railway', type: 'line' },
      razed: { name: 'Razed railway', type: 'line' },
      preserved: { name: 'Preserved railway', type: 'line' },
    },
    sections: [
      {
        title: 'Line',
        properties: [
          {
            name: 'Type',
            parts: [
              'state',
              'usage',
              'service',
              'tracks',
              'traffic_mode',
              'highspeed',
              'preserved',
              'rack',
              'tunnel',
              'bridge',
            ],
          },
          { name: 'Speed', parts: ['maxspeed', 'speed_label'] },
          {
            name: 'Electrification',
            parts: [
              'electrification_state',
              { properties: ['voltage', 'frequency', 'maximum_current'] },
              { prefix: 'planned', properties: ['future_voltage', 'future_frequency', 'future_maximum_current'] },
            ],
          },
          {
            name: 'Gauge',
            parts: [
              'gauges',
              { prefix: 'loading gauge', properties: ['loading_gauge'] },
              { prefix: 'class', properties: ['track_class'] },
            ],
          },
          {
            name: 'Signalling',
            parts: [
              { separator: ', ', properties: ['train_protection0', 'train_protection1', 'train_protection2'] },
              { prefix: 'planned', properties: ['train_protection_construction'] },
              'radio',
            ],
          },
          { name: 'Opening', parts: ['start_date', { prefix: 'planned', properties: ['opening_date'] }] },
          'operator',
          'primary_operator',
          'owner',
          'preferred_direction',
          'track_ref',
          'reporting_marks',
        ],
      },
      { title: 'Links', properties: ['wikidata', 'wikipedia', 'wikimedia_commons', 'mapillary'] },
    ],
    // way_length only gates tunnel and bridge decorations; gaugeint* feed
    // the railway filter (gauges holds the readable values).
    hiddenProperties: [
      'way_length',
      'gaugeint0',
      'gaugeint1',
      'gaugeint2',
      'train_protection_rank',
      'train_protection_construction_rank',
      // Read by the Operator color mode.
      'operator_color',
    ],
    properties: {
      // In service is the norm, so the Type row only names other states.
      state: { name: 'State', format: { labels: { present: '' }, humanize: 'words' } },
      usage: { name: 'Usage', format: { humanize: 'words' } },
      service: { name: 'Service', format: { humanize: 'words' } },
      highspeed: { name: 'High speed' },
      preserved: { name: 'Heritage railway' },
      rack: {
        name: 'Rack railway',
        format: {
          labels: {
            yes: 'Rack railway',
            abt: 'Rack (Abt)',
            riggenbach: 'Rack (Riggenbach)',
            strub: 'Rack (Strub)',
            locher: 'Rack (Locher)',
            von_roll: 'Rack (Von Roll)',
            marsh: 'Rack (Marsh)',
          },
          humanize: 'words',
        },
      },
      tracks: {
        name: 'Tracks',
        format: {
          labels: {
            1: 'Single track',
            2: 'Double track',
            ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 3, `${index + 3} tracks`])),
          },
          humanize: 'words',
        },
      },
      start_date: { name: 'Opened' },
      opening_date: { name: 'Planned opening' },
      preferred_direction: {
        name: 'Preferred direction',
        format: { labels: { forward: 'Forward', backward: 'Backward', both: 'Both directions' }, humanize: 'words' },
      },
      tunnel: { name: 'Tunnel' },
      bridge: { name: 'Bridge' },
      ref: { name: 'Reference' },
      track_ref: { name: 'Track' },
      maxspeed: { name: 'Maximum speed', format: { unit: 'speed' } },
      speed_label: { name: 'Speed label', hideIfSameAs: 'maxspeed' },
      train_protection0: { name: 'Train protection', format: { humanize: 'code' } },
      train_protection1: { name: 'Train protection', format: { humanize: 'code' } },
      train_protection2: { name: 'Train protection', format: { humanize: 'code' } },
      train_protection_construction: { name: 'Train protection (planned)', format: { humanize: 'code' } },
      electrification_state: {
        name: 'Electrification',
        format: {
          labels: { present: 'Electrified', no: 'Not electrified', deelectrified: 'De-electrified' },
          humanize: 'words',
        },
      },
      frequency: { name: 'Frequency', format: { unit: 'frequency' } },
      voltage: { name: 'Voltage', format: { unit: 'voltage' } },
      maximum_current: { name: 'Maximum current', format: { unit: 'current' } },
      future_frequency: { name: 'Future frequency', format: { unit: 'frequency' } },
      future_voltage: { name: 'Future voltage', format: { unit: 'voltage' } },
      future_maximum_current: { name: 'Future maximum current', format: { unit: 'current' } },
      gauges: { name: 'Gauge', format: { unit: 'gauge', separator: ', ' } },
      loading_gauge: { name: 'Loading gauge' },
      track_class: { name: 'Track class' },
      reporting_marks: { name: 'Reporting marks' },
      operator: { name: 'Operator' },
      primary_operator: { name: 'Primary operator', hideIfSameAs: 'operator' },
      owner: { name: 'Owner' },
      traffic_mode: { name: 'Traffic', format: { humanize: 'words' } },
      radio: { name: 'Radio', format: { humanize: 'code' } },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia, format: { country_prefix: {} } },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
      line_relations: {
        name: 'Lines',
        list: {
          routeIdProperty: 'route_id',
          colorProperty: 'color',
          labelProperty: 'label',
          detailProperty: 'ref',
          properties: ['route_id', 'color', 'label', 'ref'],
          selectTitle: 'Highlight this line on the map',
          section: 'Line',
        },
      },
      line_routes: {
        name: 'Routes',
        list: {
          routeIdProperty: 'route_id',
          colorProperty: 'color',
          labelProperty: 'label',
          properties: ['route_id', 'color', 'label'],
        },
      },
    },
  };

  const stationFeatures: FeatureCatalog = {
    featureProperty: 'feature',
    labelProperties: ['localized_name', 'name'],
    featureLinks: FEATURE_LINKS,
    features: {
      station: { name: 'Station' },
      halt: { name: 'Halt' },
      tram_stop: { name: 'Tram stop' },
      service_station: { name: 'Service station' },
      yard: { name: 'Railway yard' },
      junction: { name: 'Junction' },
      spur_junction: { name: 'Spur junction' },
      crossover: { name: 'Crossover' },
      site: { name: 'Railway site' },
    },
    sections: [
      { title: 'Station', properties: ['station', 'state', 'station_size', 'position', 'yard_purpose', 'yard_hump'] },
      { title: 'Operation', properties: ['operator', 'network'] },
      { title: 'References', properties: ['references'] },
      { title: 'Links', properties: ['wikidata', 'wikipedia', 'wikimedia_commons', 'mapillary'] },
    ],
    hiddenProperties: ['id', 'discr_iso', 'count', 'label'],
    properties: {
      station: { name: 'Type', format: { humanize: 'words' } },
      state: { name: 'State', format: { humanize: 'words' } },
      station_size: { name: 'Size', format: { humanize: 'words' } },
      references: {
        name: 'References',
        format: {
          map: {
            key: { format: { lookup: 'station_references' } },
            value: {},
          },
        },
      },
      operator: { name: 'Operator' },
      network: { name: 'Network' },
      position: { name: 'Position' },
      yard_purpose: { name: 'Yard purpose', format: { humanize: 'words' } },
      yard_hump: { name: 'Yard hump' },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia, format: { country_prefix: {} } },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
      station_routes: {
        name: 'Routes',
        list: {
          routeIdProperty: 'route_id',
          colorProperty: 'color',
          labelProperty: 'label',
          properties: ['route_id', 'color', 'label'],
        },
      },
    },
  };

  const signalProperties = {
    feature: { name: 'Signal' },
    feature0: { name: 'Primary signal' },
    feature1: { name: 'Secondary signal' },
    ref: { name: 'Reference' },
    caption: { name: 'Caption' },
    type: { name: 'Type' },
    deactivated0: { name: 'Primary deactivated' },
    deactivated1: { name: 'Secondary deactivated' },
    direction_both: { name: 'both directions' },
    position: { name: 'Position' },
    wikidata: { name: 'Wikidata', link: LINKS.wikidata },
    wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
    mapillary: { name: 'Mapillary', link: LINKS.mapillary },
    wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia },
    note: { name: 'Note', paragraph: true },
    description: { name: 'Description', paragraph: true },
  };

  const signalFeatures = {
    featureProperty: 'railway',
    featureLinks: FEATURE_LINKS,
    features: {
      signal: { name: 'Signal' },
      buffer_stop: { name: 'Buffer stop' },
      derail: { name: 'Derailer' },
      vacancy_detection: { name: 'Vacancy detection' },
    },
    properties: signalProperties,
  };

  const poiFeatures = {
    labelProperties: ['name'],
    featureLinks: FEATURE_LINKS,
    features: {
      'general/border': { name: 'Border crossing' },
      'general/owner-change': { name: 'Owner change' },
      'general/radio-mast': { name: 'Radio mast' },
      'general/radio-antenna': { name: 'Radio antenna' },
      'general/container-terminal': { name: 'Container terminal' },
      'general/ferry-terminal': { name: 'Ferry terminal' },
      'general/lubricator': { name: 'Lubricator' },
      'general/fuel': { name: 'Fuel' },
      'general/sand_store': { name: 'Sand store' },
      'general/defect_detector': { name: 'Defect detector' },
      'general/aei': { name: 'AEI' },
      'general/hump': { name: 'Hump' },
      'general/loading_ramp': { name: 'Loading ramp' },
      'general/preheating': { name: 'Preheating' },
      'general/wash': { name: 'Wash' },
      'general/water_crane': { name: 'Water crane' },
      'general/phone': { name: 'Phone' },
      'general/coaling_facility': { name: 'Coaling facility' },
    },
    properties: {
      ref: { name: 'Reference' },
      position: { name: 'Position' },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia, format: { country_prefix: {} } },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
    },
  };

  const milestoneFeatures = {
    featureProperty: 'railway',
    featureLinks: FEATURE_LINKS,
    features: {
      milestone: { name: 'Milestone' },
      level_crossing: { name: 'Level crossing' },
      crossing: { name: 'Crossing' },
    },
    properties: {
      pos: { name: 'Position' },
      pos_exact: { name: 'Exact position' },
      type: { name: 'Type' },
      operator: { name: 'Operator' },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
    },
  };

  const switchFeatures = {
    featureProperty: 'railway',
    featureLinks: FEATURE_LINKS,
    features: {
      switch: { name: 'Switch' },
      railway_crossing: { name: 'Railway crossing' },
    },
    properties: {
      ref: { name: 'Reference' },
      type: { name: 'Type' },
      turnout_side: { name: 'Turnout side' },
      local_operated: { name: 'Operated locally' },
      resetting: { name: 'Resetting' },
      position: { name: 'Position' },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
    },
  };

  const signalBoxFeatures = {
    labelProperties: ['name'],
    featureLinks: FEATURE_LINKS,
    features: {
      signal_box: { name: 'Signal box' },
      crossing_box: { name: 'Crossing box' },
      blockpost: { name: 'Block post' },
    },
    properties: {
      ref: { name: 'Reference' },
      position: { name: 'Position' },
      operator: { name: 'Operator' },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
    },
  };

  const platformFeatures = {
    featureLinks: FEATURE_LINKS,
    features: { platform: { name: 'Platform', type: 'polygon' } },
    labelProperties: ['name'],
    properties: {
      ref: { name: 'Reference' },
      height: { name: 'Height', format: { template: '%.2d m' } },
      surface: { name: 'Surface' },
      elevator: { name: 'Elevator' },
      shelter: { name: 'Shelter' },
      lit: { name: 'Lit' },
      bin: { name: 'Bin' },
      bench: { name: 'Bench' },
      wheelchair: { name: 'Wheelchair accessible' },
      departures_board: { name: 'Departures board' },
      tactile_paving: { name: 'Tactile paving' },
      platform_routes: {
        name: 'Routes',
        list: {
          routeIdProperty: 'route_id',
          colorProperty: 'color',
          labelProperty: 'label',
          properties: ['route_id', 'color', 'label'],
        },
      },
    },
  };

  const stopPositionFeatures = {
    featureLinks: FEATURE_LINKS,
    labelProperties: ['name'],
    featureProperty: 'type',
    features: {
      train: { name: 'Train stop' },
      tram: { name: 'Tram stop' },
      subway: { name: 'Subway stop' },
      light_rail: { name: 'Light rail stop' },
    },
    properties: {
      ref: { name: 'Reference' },
      local_ref: { name: 'Local reference' },
      stop_position_routes: {
        name: 'Routes',
        list: {
          routeIdProperty: 'route_id',
          colorProperty: 'color',
          labelProperty: 'label',
          properties: ['route_id', 'color', 'label'],
        },
      },
    },
  };

  const turntableFeatures = {
    featureLinks: FEATURE_LINKS,
    features: {
      turntable: { name: 'Turntable', type: 'polygon' },
      traverser: { name: 'Transfer table', type: 'polygon' },
    },
  };

  const platformEdgeFeatures = {
    featureLinks: FEATURE_LINKS,
    features: { platform_edge: { name: 'Platform edge', type: 'line' } },
    labelProperties: ['ref'],
    properties: {
      height: { name: 'Height', format: { template: '%.2d m' } },
      tactile_paving: { name: 'Tactile paving' },
    },
  };

  const stationEntranceFeatures = {
    featureLinks: FEATURE_LINKS,
    featureProperty: 'type',
    features: {
      subway: { name: 'Subway entrance' },
      train: { name: 'Train station entrance' },
    },
    properties: {
      name: { name: 'Name' },
      ref: { name: 'Reference' },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
    },
  };

  const catenaryFeatures = {
    featureProperty: 'feature',
    featureLinks: FEATURE_LINKS,
    features: {
      mast: { name: 'Catenary mast' },
      portal: { name: 'Catenary portal' },
    },
    properties: {
      ref: { name: 'Reference' },
      position: { name: 'Position' },
      transition: { name: 'Transition point' },
      structure: { name: 'Structure' },
      supporting: { name: 'Supporting' },
      attachment: { name: 'Attachment' },
      tensioning: { name: 'Tensioning' },
      insulator: { name: 'Insulator' },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
    },
  };

  const substationFeatures = {
    featureProperty: 'feature',
    featureLinks: FEATURE_LINKS,
    labelProperties: ['name'],
    features: { traction: { name: 'Traction substation', type: 'polygon' } },
    properties: {
      ref: { name: 'Reference' },
      location: { name: 'Location' },
      operator: { name: 'Operator' },
      voltage: { name: 'Voltage', format: { template: '%s V' } },
      wikidata: { name: 'Wikidata', link: LINKS.wikidata },
      wikimedia_commons: { name: 'Wikimedia', link: LINKS.wikimedia_commons },
      mapillary: { name: 'Mapillary', link: LINKS.mapillary },
      wikipedia: { name: 'Wikipedia', link: LINKS.wikipedia, format: { country_prefix: {} } },
      note: { name: 'Note', paragraph: true },
      description: { name: 'Description', paragraph: true },
    },
  };

  // The lookup-only catalogs (not tied to a source-layer, used by format.lookup)
  const stationReferences = {
    features: {
      'railway-ref': { name: 'Railway reference', index: 0 },
      uic: { name: 'UIC', index: 1 },
      ibnr: { name: 'IBNR', index: 2 },
      ifopt: { name: 'IFOPT', index: 3 },
      iata: { name: 'IATA', index: 4 },
      'eu-plc': { name: 'PLC', index: 5 },
      'db-de': { name: 'DB', index: 6 },
      'gb-crs': { name: 'CRS', index: 7 },
      'gb-tiploc': { name: 'TIPLOC', index: 8 },
    },
  };

  // Map of source layer -> catalog entry. Every railway layer comes from one
  // archive, so the source layer alone identifies the feature kind.
  return {
    // Railway lines (all map styles share the same line catalog)
    railway_line_high: railwayLineFeatures,
    standard_railway_line_low: railwayLineFeatures,
    speed_railway_line_low: railwayLineFeatures,
    signals_railway_line_low: railwayLineFeatures,
    electrification_railway_line_low: railwayLineFeatures,
    track_railway_line_low: railwayLineFeatures,
    operator_railway_line_low: railwayLineFeatures,

    // Stations
    standard_railway_text_stations_low: stationFeatures,
    standard_railway_text_stations_med: stationFeatures,
    standard_railway_text_stations: stationFeatures,
    standard_railway_grouped_stations: stationFeatures,

    // Standard layer features
    standard_railway_turntables: turntableFeatures,
    standard_railway_platforms: platformFeatures,
    standard_railway_platform_edges: platformEdgeFeatures,
    standard_railway_stop_positions: stopPositionFeatures,
    standard_station_entrances: stationEntranceFeatures,
    standard_railway_symbols: poiFeatures,
    standard_railway_switch_ref: switchFeatures,

    // Milestones
    railway_text_km: milestoneFeatures,

    // Speed signals
    speed_railway_signals: signalFeatures,

    // Signal layer
    signals_railway_signals: signalFeatures,
    signals_signal_boxes: signalBoxFeatures,

    // Electrification
    electrification_signals: signalFeatures,
    electrification_railway_symbols: poiFeatures,
    electrification_catenary: catenaryFeatures,
    electrification_substation: substationFeatures,

    // Operator
    operator_railway_symbols: poiFeatures,

    // Lookup-only catalogs (used by format.lookup, not tied to a source-layer)
    station_references: stationReferences,
  };
}

// ---------------------------------------------------------------------------
// Main popup content builder — mirrors ORM popupContent()
// Builds DOM (not innerHTML) to avoid XSS, exactly like upstream.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Client-side Wikidata / Wikimedia Commons image fetching
// (replaces ORM backend proxy endpoints /api/wikidata/ and /api/wikimedia/)
// ---------------------------------------------------------------------------

function renderImageData(linkEl: HTMLAnchorElement, data: CommonsImageData, _abortController: AbortController) {
  const img = el('img', 'orm-popup-image', linkEl);
  img.style.display = 'none';
  img.onload = () => (img.style.display = 'block');

  const desc = `Image ${data.file_name}${data.description ? `: ${data.description}` : ''}`;
  img.src = data.thumbnail_url;
  img.title = desc;
  img.alt = desc;
  linkEl.href = data.view_url;
  linkEl.title = desc;

  if (data.license || data.attribution) {
    const attr = el('span', 'orm-img-attribution collapsed', linkEl);
    const copy = el('span', 'orm-img-copyright', attr);
    copy.innerText = '\u00A9';
    copy.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      attr.classList.toggle('collapsed');
    };
    if (data.license) {
      if (data.license_url) {
        const licEl = el('a', 'orm-hide-collapsed', attr);
        licEl.href = data.license_url;
        licEl.target = '_blank';
        licEl.innerText = data.license;
      } else {
        const licEl = el('span', 'orm-hide-collapsed', attr);
        licEl.innerText = data.license;
      }
    }
    if (data.attribution) {
      const attrEl = el('span', 'orm-hide-collapsed', attr);
      attrEl.innerText = data.attribution;
    }
  }
}

function fetchCommonsImageData(fileName: string, signal: AbortSignal): Promise<CommonsImageData | null> {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query' +
    `&titles=File:${encodeURIComponent(fileName)}` +
    '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=330&format=json&origin=*';
  return fetch(url, { signal })
    .then((r) => r.json())
    .then((json: unknown) => {
      const pages = isRecord(json) && isRecord(json.query) && isRecord(json.query.pages) ? json.query.pages : null;
      if (!pages) return null;
      const page = Object.values(pages).find(isRecord);
      const info = firstRecord(page?.imageinfo);
      if (!info) return null;
      const meta = isRecord(info.extmetadata) ? info.extmetadata : {};
      const artist = stripHtml(metadataValue(meta, 'Artist'));
      const license = metadataValue(meta, 'LicenseShortName');
      const licenseUrl = metadataValue(meta, 'LicenseUrl');
      const description = stripHtml(metadataValue(meta, 'ImageDescription')).slice(0, 200);
      const thumbnailUrl = stringValue(info.thumburl || info.url);
      if (!thumbnailUrl) return null;
      return {
        file_name: fileName,
        thumbnail_url: thumbnailUrl,
        view_url:
          stringValue(info.descriptionurl) || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`,
        description,
        attribution: artist,
        license,
        license_url: licenseUrl,
      };
    });
}

function fetchWikidataImage(linkEl: HTMLAnchorElement, wikidataId: string, abortController: AbortController) {
  const url =
    'https://www.wikidata.org/w/api.php?action=wbgetclaims' +
    `&entity=${encodeURIComponent(wikidataId)}` +
    '&property=P18&format=json&origin=*';
  fetch(url, { signal: abortController.signal })
    .then((r) => r.json())
    .then((json: unknown) => {
      const claims = isRecord(json) && isRecord(json.claims) && Array.isArray(json.claims.P18) ? json.claims.P18 : null;
      const claim = firstRecord(claims);
      const mainsnak = isRecord(claim?.mainsnak) ? claim.mainsnak : null;
      const datavalue = isRecord(mainsnak?.datavalue) ? mainsnak.datavalue : null;
      const fileName = stringValue(datavalue?.value);
      if (!fileName) return null;
      return fetchCommonsImageData(fileName, abortController.signal);
    })
    .then((data) => {
      if (data) {
        data.view_url = `https://www.wikidata.org/wiki/${wikidataId}#/media/File:${encodeURIComponent(data.file_name)}`;
        renderImageData(linkEl, data, abortController);
      }
    })
    .catch((err) => {
      if (!abortController.signal.aborted) {
        console.error('Error fetching Wikidata image', err);
      }
    });
}

function fetchCommonsImage(linkEl: HTMLAnchorElement, commonsFile: string, abortController: AbortController) {
  fetchCommonsImageData(commonsFile, abortController.signal)
    .then((data) => {
      if (data) renderImageData(linkEl, data, abortController);
    })
    .catch((err) => {
      if (!abortController.signal.aborted) {
        console.error('Error fetching Commons image', err);
      }
    });
}

// `anchor` is the clicked [lng, lat]; routes and lines picked from the box
// carry it so their highlight knows where to start.
export function popupContent(
  feature: RenderedFeatureLike,
  featuresCatalog: FeaturesCatalog,
  abortController: AbortController,
  anchor?: Coordinates,
) {
  const properties = feature.properties || {};
  const layerSource = feature.sourceLayer || '';

  const featureCatalog = featuresCatalog[layerSource];
  if (!featureCatalog) {
    // Fallback: render a simple property dump
    return fallbackPopupContent(properties, layerSource);
  }

  const featureProperty = featureCatalog.featureProperty || 'feature';
  const colorProperty = featureCatalog.colorProperty || 'color';
  const featureLinks = featureCatalog.featureLinks || FEATURE_LINKS;

  const { catalogKey, keyVariable } = constructCatalogKey(properties[featureProperty]);
  const featureContent = featureCatalog.features && featureCatalog.features[catalogKey];

  // Unique labels
  const labels = [...new Set((featureCatalog.labelProperties || []).map((lp) => properties[lp]).filter(Boolean))];
  const featureDescription = featureContent
    ? `${featureContent.name}${keyVariable ? ` (${keyVariable})` : ''}${featureContent.country ? ` ${getFlagEmoji(featureContent.country)}` : ''}`
    : stringValue(properties[featureProperty]) || 'Unknown feature';
  const color = properties[colorProperty];

  // --- Build property values ---
  const propertyValues = Object.entries(featureCatalog.properties || {})
    .filter(
      ([property]) =>
        properties[property] !== undefined &&
        properties[property] !== null &&
        properties[property] !== '' &&
        properties[property] !== false,
    )
    .map(([property, definition]): PopupPropertyValue => {
      const { name, format, link, paragraph, list, description: tooltip } = definition;
      const value =
        properties[property] === true ? '' : formatPropertyValue(properties[property], format, featuresCatalog);

      const body: Array<[string | null, string]> = Array.isArray(value) ? value : [[null, value]];

      return {
        title: name || property,
        value: properties[property],
        body,
        paragraph,
        list,
        link,
        tooltip,
      };
    });

  const osmFeatures = determineOsmFeatures(properties, featureContent, featureCatalog.osmType);

  // === Build DOM ===
  const popupContainer = el('div', 'orm-popup');
  if (anchor) popupContainer.dataset.anchor = anchor.join(',');

  // Title
  const popupTitle = el('h5', 'orm-popup-title', popupContainer);
  popupTitle.innerText = featureDescription;

  // Label row (icon / color marker / name labels)
  if (properties.icon || labels.length > 0 || color) {
    const popupLabel = el('h6', 'orm-popup-label', popupContainer);
    if (properties.icon) {
      const span = el('span', undefined, popupLabel);
      span.title = stringValue(properties.railway);
      span.innerText = stringValue(properties.icon);
    } else {
      if (typeof color === 'string') {
        const marker = el('span', 'orm-color-marker', popupLabel);
        marker.style.backgroundColor = color;
      }
      if (labels.length > 0) {
        const labelSpan = el('span', undefined, popupLabel);
        labelSpan.innerText = labels.map(stringValue).join(' \u2022 ');
      }
    }
  }

  // Wikidata / Wikimedia Commons / direct image
  if (properties.wikidata || properties.wikimedia_commons_file || properties.image) {
    const imgContainer = el('p', 'orm-popup-images', popupContainer);

    if (properties.wikidata) {
      const link = el('a', 'orm-popup-image-link', imgContainer);
      link.target = '_blank';
      fetchWikidataImage(link, stringValue(properties.wikidata), abortController);
    }
    if (properties.wikimedia_commons_file) {
      const link = el('a', 'orm-popup-image-link', imgContainer);
      link.target = '_blank';
      fetchCommonsImage(link, stringValue(properties.wikimedia_commons_file), abortController);
    }
    if (properties.image) {
      const link = el('a', undefined, imgContainer);
      const imageUrl = stringValue(properties.image);
      link.href = imageUrl;
      link.target = '_blank';
      link.title = `Image: ${imageUrl}`;
      const img = el('img', 'orm-popup-image', link);
      img.src = imageUrl;
      img.alt = `Image: ${imageUrl}`;
      img.style.display = 'none';
      img.onload = () => (img.style.display = 'block');
    }
  }

  // Property sections (structured catalogs) or badges (non-paragraph, non-list)
  const badgeProps = propertyValues.filter((it) => !it.paragraph && !it.list);
  const osmRows = osmFeatures.map(({ id, type }) => osmLinkRow(type, id, featureLinks));
  if (featureCatalog.sections) {
    renderPropertySections(popupContainer, properties, featureCatalog, featuresCatalog, osmRows);
  } else if (badgeProps.length > 0) {
    const badgeContainer = el('h6', 'orm-popup-badges', popupContainer);
    badgeProps.forEach(({ title, body, value, link, tooltip }) => {
      const badge = el('span', 'orm-badge', badgeContainer);
      if (tooltip) {
        badge.title = tooltip;
        badge.style.cursor = 'help';
      }

      const titleSpan = el('span', 'orm-badge-title', badge);
      titleSpan.innerText = `${title}: `;

      let first = true;
      body.forEach(([key, bodyValue]) => {
        if (!bodyValue) return;
        if (first) {
          first = false;
        } else {
          const sep = el('span', undefined, badge);
          sep.innerText = ' \u2022 ';
        }
        if (key) {
          const keySpan = el('span', 'orm-badge-title', badge);
          keySpan.innerText = `${key} `;
        }
        if (link) {
          const wrapper = el('span', undefined, badge);
          const a = el('a', undefined, wrapper);
          a.href = link.replace('%s', () => encodeURIComponent(String(value)));
          a.target = '_blank';
          const text = el('span', undefined, a);
          text.innerText = bodyValue;
        } else {
          const span = el('span', undefined, badge);
          span.innerText = bodyValue;
        }
      });
    });
  }

  // Paragraph properties (note, description)
  const paraProps = propertyValues.filter((it) => it.paragraph);
  if (paraProps.length > 0) {
    const paraContainer = el('div', 'orm-popup-paragraphs', popupContainer);
    paraProps.forEach(({ title, body }) => {
      const p = el('p', undefined, paraContainer);
      const titleSpan = el('span', 'orm-badge-title', p);
      titleSpan.innerText = `${title}: `;

      let first = true;
      body.forEach(([key, value]) => {
        if (!value) return;
        if (first) {
          first = false;
        } else {
          const sep = el('span', undefined, p);
          sep.innerText = ' \u2022 ';
        }
        if (key) {
          const keySpan = el('span', 'orm-badge-title', p);
          keySpan.innerText = `${key} `;
        }
        const span = el('span', undefined, p);
        span.innerText = value;
      });
    });
  }

  // List properties (routes); with sections, lists that name one are shown there.
  const listProps = propertyValues.filter((it) => it.list && !(featureCatalog.sections && it.list.section));
  if (listProps.length > 0) {
    const listContainer = el('div', 'orm-popup-lists', popupContainer);
    listProps.forEach(({ title, value, list }) => {
      const header = el('span', 'orm-badge-title', listContainer);
      header.innerText = `${title} (${listGroups(value, list).length}):`;
      renderListItems(el('ul', 'orm-popup-route-list', listContainer), value, list);
    });
  }

  if (!featureCatalog.sections && osmRows.length > 0) {
    renderSection(el('div', 'orm-popup-sections', popupContainer), 'Links', osmRows);
  }

  return popupContainer;
}

// A Links row with the OSM element's id linking to its page, plus an edit link.
function osmLinkRow(
  type: OsmElementType,
  id: string,
  featureLinks: Partial<FeatureLinks> = FEATURE_LINKS,
): PropertyRow {
  const link = (template: string) => template.replace('{osm_type}', type).replace('{osm_id}', id);
  const links = [{ text: `${type} ${id}`, href: link(featureLinks.view) }];
  if (featureLinks.edit) links.push({ text: 'edit', href: link(featureLinks.edit) });
  return { label: 'OpenStreetMap', value: links[0].text, links };
}

function listGroups(value: unknown, list: ListSpec) {
  return stringValue(value)
    .split('\u001d')
    .map((group) => {
      const split = group.split('\u001e');
      return Object.fromEntries(list.properties.map((property, index) => [property, split[index] || null]));
    });
}

function renderListItems(ul: HTMLElement, value: unknown, list: ListSpec) {
  for (const group of listGroups(value, list)) {
    const groupColor = group[list.colorProperty];
    const label = group[list.labelProperty];
    const detail = list.detailProperty && group[list.detailProperty];
    const showDetail = detail && detail !== label;

    const li = el('li', undefined, ul);
    const routeId = list.routeIdProperty && group[list.routeIdProperty];
    if (routeId) {
      const selectionLabel = showDetail ? `${label} · ${detail}` : label;
      makeRouteSelectable(li, { id: routeId, color: groupColor, label: selectionLabel }, list.selectTitle);
    }
    if (groupColor) {
      const marker = el('span', 'orm-color-marker', li);
      marker.style.backgroundColor = groupColor;
    }
    if (label) {
      const labelSpan = el('span', undefined, li);
      labelSpan.innerText = label;
    }
    if (showDetail) {
      const detailSpan = el('span', 'orm-popup-list-detail', li);
      detailSpan.innerText = detail;
    }
  }
}

// Clicking a route or line asks route-highlight.ts (listening on the map
// container) to highlight all of it.
function makeRouteSelectable(item: HTMLElement, route: RouteSelection, title = 'Highlight this route on the map') {
  item.dataset.routeId = route.id;
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.setAttribute('aria-pressed', 'false');
  item.title = title;
  const select = () => {
    const anchor = item.closest<HTMLElement>('.orm-popup')?.dataset.anchor?.split(',').map(Number);
    const at = anchor?.length === 2 && anchor.every(Number.isFinite) ? (anchor as [number, number]) : undefined;
    item.dispatchEvent(new CustomEvent(ROUTE_SELECT_EVENT, { bubbles: true, detail: at ? { ...route, at } : route }));
  };
  item.addEventListener('click', select);
  item.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  });
}

// ---------------------------------------------------------------------------
// Structured property sections: titled groups of label/value rows, then an
// "Other" group with every remaining property so no metadata is hidden.
// ---------------------------------------------------------------------------
type PropertyRow = { label: string; value: string; href?: string; links?: Array<{ text: string; href: string }> };

const POPUP_HANDLED_PROPERTIES = ['osm_id', 'osm_type', 'icon', 'image', 'wikimedia_commons_file'];

function hasDisplayValue(value: unknown) {
  return value !== undefined && value !== null && value !== '' && value !== false;
}

function catalogPropertyRows(
  property: string,
  properties: JsonRecord,
  featuresCatalog: FeaturesCatalog,
  catalog: FeatureCatalog,
) {
  const value = properties[property];
  if (!hasDisplayValue(value)) return [];
  const definition = catalog.properties?.[property] || {};
  const { hideIfSameAs } = definition;
  if (hideIfSameAs && stringValue(properties[hideIfSameAs]) === stringValue(value)) return [];
  const label = definition.name || humanizeWords(property);
  if (value === true) return [{ label, value: 'Yes' }];
  const formatted = formatPropertyValue(value, definition.format, featuresCatalog);
  if (Array.isArray(formatted)) {
    return formatted
      .filter(([, item]) => item)
      .map(([key, item]): PropertyRow => ({ label: key || label, value: item }));
  }
  const href = definition.link
    ? definition.link.replace('%s', () => encodeURIComponent(stringValue(value)))
    : undefined;
  return [{ label, value: formatted, href }];
}

// One property's value as text for a combined row; '' when there is nothing to show.
function combinedPartValue(
  property: string,
  properties: JsonRecord,
  featuresCatalog: FeaturesCatalog,
  catalog: FeatureCatalog,
) {
  const value = properties[property];
  if (!hasDisplayValue(value)) return '';
  const definition = catalog.properties?.[property] || {};
  if (definition.hideIfSameAs && stringValue(properties[definition.hideIfSameAs]) === stringValue(value)) return '';
  if (value === true) return definition.name || humanizeWords(property);
  const formatted = formatPropertyValue(value, definition.format, featuresCatalog);
  return Array.isArray(formatted) ? formatted.map(([, item]) => item).join(', ') : formatted;
}

function combinedRow(
  row: CombinedRow,
  properties: JsonRecord,
  featuresCatalog: FeaturesCatalog,
  catalog: FeatureCatalog,
): PropertyRow[] {
  const valueOf = (property: string) => combinedPartValue(property, properties, featuresCatalog, catalog);
  const parts = row.parts.map((part) => {
    if (typeof part === 'string') return valueOf(part);
    const values = part.properties.map(valueOf).filter(Boolean);
    return values.length ? [part.prefix, values.join(part.separator ?? ' ')].filter(Boolean).join(' ') : '';
  });
  const value = parts.filter(Boolean).join(' · ');
  return value ? [{ label: row.name, value }] : [];
}

function combinedRowProperties(row: CombinedRow) {
  return row.parts.flatMap((part) => (typeof part === 'string' ? [part] : part.properties));
}

function otherPropertyRow(property: string, value: unknown): PropertyRow {
  return {
    label: humanizeWords(property),
    value: value === true ? 'Yes' : stringValue(value).split('\u001d').join('; ').split('\u001e').join(', '),
  };
}

// Rows sharing a label (e.g. up to three train protection systems) merge into one.
function mergeRows(rows: PropertyRow[]) {
  const merged: PropertyRow[] = [];
  for (const row of rows) {
    const previous = merged.find(
      (item) => item.label === row.label && !item.href && !row.href && !item.links && !row.links,
    );
    if (previous) previous.value = `${previous.value}, ${row.value}`;
    else merged.push({ ...row });
  }
  return merged;
}

type SectionList = { title: string; value: unknown; list: ListSpec };

function renderSection(container: Element, title: string, rows: PropertyRow[], lists: SectionList[] = []) {
  if (rows.length === 0 && lists.length === 0) return;
  const section = el('section', 'orm-popup-section', container);
  el('h6', 'orm-popup-section-title', section).innerText = title;
  const list = el('dl', 'orm-popup-fields', section);
  for (const { title: listTitle, value, list: spec } of lists) {
    el('dt', undefined, list).innerText = listTitle;
    renderListItems(el('ul', 'orm-popup-route-list', el('dd', undefined, list)), value, spec);
  }
  for (const row of mergeRows(rows)) {
    el('dt', undefined, list).innerText = row.label;
    const dd = el('dd', undefined, list);
    if (row.links) {
      row.links.forEach(({ text, href }, index) => {
        if (index > 0) dd.append(' · ');
        const link = el('a', undefined, dd);
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.innerText = text;
      });
    } else if (row.href) {
      const link = el('a', undefined, dd);
      link.href = row.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.innerText = row.value;
    } else {
      dd.innerText = row.value;
    }
  }
}

function renderPropertySections(
  container: Element,
  properties: JsonRecord,
  catalog: FeatureCatalog,
  featuresCatalog: FeaturesCatalog,
  osmRows: PropertyRow[] = [],
) {
  const sectionContainer = el('div', 'orm-popup-sections', container);
  const shown = new Set<string>([
    ...POPUP_HANDLED_PROPERTIES,
    ...(catalog.hiddenProperties || []),
    ...(catalog.labelProperties || []),
    catalog.featureProperty || 'feature',
    catalog.colorProperty || 'color',
  ]);
  for (const [property, definition] of Object.entries(catalog.properties || {})) {
    if (definition.paragraph || definition.list) shown.add(property);
  }
  for (const section of catalog.sections || []) {
    const rows = section.properties.flatMap((entry) => {
      if (typeof entry !== 'string') {
        combinedRowProperties(entry).forEach((property) => shown.add(property));
        return combinedRow(entry, properties, featuresCatalog, catalog);
      }
      shown.add(entry);
      return catalogPropertyRows(entry, properties, featuresCatalog, catalog);
    });
    if (section.title === 'Links') rows.push(...osmRows);
    const lists = Object.entries(catalog.properties || {})
      .filter(
        ([property, definition]) => definition.list?.section === section.title && hasDisplayValue(properties[property]),
      )
      .map(([property, definition]) => ({
        title: definition.name || property,
        value: properties[property],
        list: definition.list,
      }));
    renderSection(sectionContainer, section.title, rows, lists);
  }
  if (!catalog.sections?.some((section) => section.title === 'Links'))
    renderSection(sectionContainer, 'Links', osmRows);
  const otherRows = Object.keys(properties)
    .filter((property) => !shown.has(property) && hasDisplayValue(properties[property]))
    .sort()
    .map((property) => otherPropertyRow(property, properties[property]));
  renderSection(sectionContainer, 'Other', otherRows);
}

// ---------------------------------------------------------------------------
// Fallback popup for layers not in the catalog
// ---------------------------------------------------------------------------
function fallbackPopupContent(properties: JsonRecord, _layerSource: string) {
  const container = el('div', 'orm-popup');

  const title = el('h5', 'orm-popup-title', container);
  title.innerText =
    stringValue(properties.localized_name || properties.name || properties.label || properties.ref) ||
    'Railway feature';

  const badges = el('h6', 'orm-popup-badges', container);

  const showProps = [
    ['feature', 'Feature'],
    ['railway', 'Railway'],
    ['state', 'State'],
    ['usage', 'Usage'],
    ['service', 'Service'],
    ['ref', 'Reference'],
    ['speed_label', 'Speed'],
    ['electrification_state', 'Electrification'],
    ['voltage', 'Voltage'],
    ['frequency', 'Frequency'],
    ['gauges', 'Gauge'],
    ['operator', 'Operator'],
    ['station', 'Station type'],
    ['position', 'Position'],
  ];

  showProps.forEach(([key, label]) => {
    const val = properties[key];
    if (val === undefined || val === null || val === '' || val === false) return;
    const badge = el('span', 'orm-badge', badges);
    const titleSpan = el('span', 'orm-badge-title', badge);
    titleSpan.innerText = `${label}: `;
    const valSpan = el('span', undefined, badge);
    valSpan.innerText = val === true ? 'yes' : typeof val === 'string' ? val : String(val);
  });

  // OSM link
  if (properties.osm_id) {
    const osmType = properties.osm_type === 'N' ? 'node' : properties.osm_type === 'R' ? 'relation' : 'way';
    const row = osmLinkRow(osmType, stringValue(properties.osm_id), { view: FEATURE_LINKS.view });
    renderSection(el('div', 'orm-popup-sections', container), 'Links', [row]);
  }

  return container;
}

function addPopupBadge(container: Element, label: string, value: unknown) {
  if (value === undefined || value === null || value === '' || value === false) return;
  const badge = el('span', 'orm-badge', container);
  const titleSpan = el('span', 'orm-badge-title', badge);
  titleSpan.innerText = `${label}: `;
  const valueSpan = el('span', undefined, badge);
  valueSpan.innerText = value === true ? 'yes' : String(value);
}

function formatOsrmKind(kind: unknown) {
  return String(kind || '')
    .replace(/^osrm_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char: string) => char.toUpperCase());
}

function formatOsrmSpeed(properties: JsonRecord) {
  const speed = Number(properties.speed_kmh ?? properties.speed);
  return Number.isFinite(speed) ? `${speed.toFixed(speed >= 10 ? 0 : 1)} km/h` : '';
}

function osrmPopupTitle(properties: JsonRecord) {
  const kind = String(properties.kind || '');
  if (kind === 'osrm_route') return stringValue(properties.name) || 'OSRM route';
  if (kind === 'osrm_segment') return 'Speed segment';
  if (kind === 'osrm_maneuver')
    return stringValue(properties.title) || formatOsrmKind(properties.maneuver) || 'Maneuver';
  if (kind === 'osrm_step') return stringValue(properties.title || properties.name) || 'Route step';
  return formatOsrmKind(kind) || 'OSRM feature';
}

function osrmPopupContent(feature: RenderedFeatureLike) {
  const properties = feature.properties || {};
  const kind = String(properties.kind || '');
  const container = el('div', 'orm-popup');

  const title = el('h5', 'orm-popup-title', container);
  title.innerText = osrmPopupTitle(properties);

  const label = el('h6', 'orm-popup-label', container);
  const marker = el('span', 'orm-color-marker', label);
  marker.style.backgroundColor = stringValue(properties.color || properties.stroke) || '#0f766e';
  const labelText = el('span', undefined, label);
  labelText.innerText = kind === 'osrm_route' ? 'OSRM route' : formatOsrmKind(kind);

  const badges = el('h6', 'orm-popup-badges', container);
  if (kind === 'osrm_route') {
    addPopupBadge(badges, 'Distance', properties.distance_text);
    addPopupBadge(badges, 'Duration', properties.duration_text);
    addPopupBadge(badges, 'Steps', properties.step_count);
    addPopupBadge(badges, 'Roads', properties.road_names);
    addPopupBadge(
      badges,
      'Avg speed',
      properties.annotation_avg_speed_kmh ? `${properties.annotation_avg_speed_kmh} km/h` : '',
    );
    addPopupBadge(badges, 'OSM nodes', properties.annotation_node_count);
  } else if (kind === 'osrm_segment') {
    addPopupBadge(badges, 'Speed', formatOsrmSpeed(properties));
    addPopupBadge(badges, 'Distance', properties.distance_text);
    addPopupBadge(badges, 'Duration', properties.duration_text);
    addPopupBadge(badges, 'Segment', properties.segment_index);
    if (properties.node_from || properties.node_to) {
      addPopupBadge(badges, 'Nodes', `${properties.node_from || '?'} -> ${properties.node_to || '?'}`);
    }
  } else {
    addPopupBadge(badges, 'Road', properties.road_name || properties.name);
    addPopupBadge(badges, 'Maneuver', [properties.maneuver, properties.modifier].filter(Boolean).join(' '));
    addPopupBadge(badges, 'Distance', properties.distance_text);
    addPopupBadge(badges, 'Duration', properties.duration_text);
    addPopupBadge(badges, 'Step', properties.step_index);
  }

  return container;
}

function formatAnnotationKind(kind: unknown) {
  return String(kind || '')
    .replace(/^annotation_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char: string) => char.toUpperCase());
}

function annotationPopupContent(feature: RenderedFeatureLike) {
  const properties = feature.properties || {};
  const container = el('div', 'orm-popup');

  const title = el('h5', 'orm-popup-title', container);
  title.innerText =
    stringValue(properties.name || properties.label) || formatAnnotationKind(properties.kind) || 'Plan item';

  const label = el('h6', 'orm-popup-label', container);
  const marker = el('span', 'orm-color-marker', label);
  marker.style.backgroundColor = stringValue(properties.color) || '#2563eb';
  const labelText = el('span', undefined, label);
  labelText.innerText = formatAnnotationKind(properties.kind);

  const badges = el('h6', 'orm-popup-badges', container);
  addPopupBadge(badges, 'Type', properties.feature_type);
  addPopupBadge(badges, 'Directed', properties.directed === true ? 'yes' : properties.directed === false ? 'no' : '');
  addPopupBadge(badges, 'Profile', properties.profile);
  addPopupBadge(badges, 'Distance', properties.distance_text);
  addPopupBadge(badges, 'Duration', properties.duration_text);

  if (properties.kind === 'annotation_weather') {
    const weatherDays = Number(properties.weather_days) || 1;
    const weatherDate = typeof properties.weather_date === 'string' ? properties.weather_date : '';
    addPopupBadge(badges, 'Forecast', buildWeatherRouteSummary({ startDate: weatherDate, days: weatherDays }));
    const coordinates = Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : null;
    const lng = Number(coordinates?.[0]);
    const lat = Number(coordinates?.[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      const paragraphs = el('div', 'orm-popup-paragraphs', container);
      const link = el('a', undefined, paragraphs);
      link.href = buildWeatherDashboardUrl({
        coordinate: { lng, lat },
        displayName: stringValue(properties.name || properties.label),
        startDate: weatherDate,
        days: weatherDays,
        compact: false,
      });
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.innerText = 'Open forecast on weather.mgt.moe';
    }
  }

  if (properties.description) {
    const paragraphs = el('div', 'orm-popup-paragraphs', container);
    const paragraph = el('p', undefined, paragraphs);
    paragraph.innerHTML = renderMarkdown(stringValue(properties.description));
  }

  return container;
}

// ---------------------------------------------------------------------------
// Install ORM-style popups on a MapLibre GL map
// ---------------------------------------------------------------------------
export type OrmPopupOptions = {
  // Finds the line and route lists of the segments near a point (route-trace.ts lineListsNear).
  lookupLineLists?: (query: LineListQuery, signal: AbortSignal) => Promise<LineLists>;
  // Adds to a railway feature's info box, e.g. a station's Timetable button.
  extendContent?: (feature: RenderedFeatureLike, content: HTMLElement) => void;
};

// Lines drawn below z7 come from this layer, which carries no line or route
// lists; the info box looks them up and is drawn again once they arrive.
const ZOOMED_OUT_LINE_LAYER = 'standard_railway_line_low';
const LINE_LOOKUP_RADIUS_PX = 10;

function metersPerPixel(lat: number, zoom: number) {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

export function installOrmPopups(
  map: MapLike,
  maplibregl: MaplibreLike,
  featuresCatalog: FeaturesCatalog,
  options: OrmPopupOptions = {},
) {
  let popup: PopupBuilderLike | null = null;
  let hoveredFeature: FeatureStateTarget | null = null;
  map.getContainer().addEventListener('annotation:editopen', () => {
    popup?.remove();
    popup = null;
  });

  // Railway features are the ones whose source layer has a catalog entry.
  const isOrmFeature = (f: RenderedFeatureLike) => Boolean(f.sourceLayer && featuresCatalog[f.sourceLayer]);
  const isOsrmFeature = (f: RenderedFeatureLike) =>
    String(f?.source || '').startsWith('geojson-layer-') && String(f?.properties?.kind || '').startsWith('osrm_');
  const isAnnotationFeature = (f: RenderedFeatureLike) =>
    String(f?.source || '').startsWith('annotation-source') &&
    String(f?.properties?.kind || '').startsWith('annotation_');
  const isWeatherPickerActive = () => map.getContainer().dataset.weatherPickerActive === 'true';
  const isRoutingPickerActive = () => map.getContainer().dataset.routingPickerActive === 'true';
  const isAnnotationPickerActive = () => map.getContainer().dataset.annotationPickerActive === 'true';
  const osrmPriority = (feature: RenderedFeatureLike) => {
    switch (feature?.properties?.kind) {
      case 'osrm_maneuver':
        return 0;
      case 'osrm_segment':
        return 1;
      case 'osrm_step':
        return 2;
      case 'osrm_route':
        return 3;
      default:
        return 4;
    }
  };

  function clearHover() {
    if (!hoveredFeature) return;
    map.setFeatureState(hoveredFeature, { hover: false });
    hoveredFeature = null;
  }

  // Hover cursor
  map.on('mousemove', (event: PopupMapEvent) => {
    if (isWeatherPickerActive() || isRoutingPickerActive() || isAnnotationPickerActive()) {
      map.getCanvas().style.cursor = 'crosshair';
      clearHover();
      return;
    }

    const renderedFeatures = map.queryRenderedFeatures(event.point);
    const osrmFeatures = renderedFeatures.filter(isOsrmFeature);
    const annotationFeatures = renderedFeatures.filter(isAnnotationFeature);
    const ormFeatures = renderedFeatures.filter(isOrmFeature);
    if (osrmFeatures.length > 0 || annotationFeatures.length > 0 || ormFeatures.length > 0) {
      map.getCanvas().style.cursor = 'pointer';

      if (osrmFeatures.length > 0 || annotationFeatures.length > 0) {
        clearHover();
        return;
      }

      const feature = ormFeatures[0];
      if (hoveredFeature && hoveredFeature.id !== feature.id) {
        map.setFeatureState(hoveredFeature, { hover: false });
        hoveredFeature = null;
      }
      if (feature.id && !(hoveredFeature && hoveredFeature.id === feature.id)) {
        hoveredFeature = {
          source: feature.source,
          sourceLayer: feature.sourceLayer,
          id: feature.id,
        };
        map.setFeatureState(hoveredFeature, { hover: true });
      }
    } else {
      map.getCanvas().style.cursor = '';
      clearHover();
    }
  });

  // Click popup
  map.on('click', (event: PopupMapEvent) => {
    if (
      isWeatherPickerActive() ||
      isRoutingPickerActive() ||
      isAnnotationPickerActive() ||
      event.originalEvent?.weatherPickerHandled ||
      event.originalEvent?.routingHandled ||
      event.originalEvent?.annotationHandled
    )
      return;

    const renderedFeatures = map.queryRenderedFeatures(event.point);
    const osrmFeatures = renderedFeatures.filter(isOsrmFeature).sort((a, b) => osrmPriority(a) - osrmPriority(b));
    const annotationFeatures = renderedFeatures.filter(isAnnotationFeature);
    const ormFeatures = renderedFeatures.filter(isOrmFeature);
    if (osrmFeatures.length === 0 && annotationFeatures.length === 0 && ormFeatures.length === 0) return;

    const feature = osrmFeatures[0] || annotationFeatures[0] || ormFeatures[0];
    const isOsrmPopup = osrmFeatures.length > 0;
    const isAnnotationPopup = !isOsrmPopup && annotationFeatures.length > 0;

    // Determine popup coordinates
    const coordinates =
      feature.geometry.type === 'Point'
        ? Array.isArray(feature.geometry.coordinates)
          ? feature.geometry.coordinates.slice()
          : event.lngLat
        : feature.geometry.type === 'LineString' && Array.isArray(feature.geometry.coordinates)
          ? closestPointOnLine(maplibregl, event.lngLat, feature.geometry.coordinates)
          : event.lngLat;

    const iconHeight = 20;
    const iconWidth = 10;
    const popupOffsets: Record<string, Coordinates> = {
      top: [0, iconHeight],
      'top-left': [iconWidth, iconHeight],
      'top-right': [-iconWidth, iconHeight],
      bottom: [0, -iconHeight],
      'bottom-left': [iconWidth, -iconHeight],
      'bottom-right': [-iconWidth, -iconHeight],
      left: [iconWidth, 0],
      right: [-iconWidth, 0],
    };

    if (popup) popup.remove();

    const abortController = new AbortController();
    const clicked = maplibregl.LngLat.convert(event.lngLat).toArray();
    const content = isOsrmPopup
      ? osrmPopupContent(feature)
      : isAnnotationPopup
        ? annotationPopupContent(feature)
        : popupContent(feature, featuresCatalog, abortController, clicked);
    if (!content) return;
    if (!isOsrmPopup && !isAnnotationPopup) options.extendContent?.(feature, content);

    const shown = new maplibregl.Popup({ offset: popupOffsets, maxWidth: 'min(400px, calc(100vw - 24px))' })
      .setLngLat(coordinates)
      .setDOMContent(content)
      .addTo(map);
    popup = shown;
    keepPopupInView(map, shown);

    shown.on('close', () => {
      abortController.abort('Popup closed');
    });

    if (
      !isOsrmPopup &&
      !isAnnotationPopup &&
      feature.sourceLayer === ZOOMED_OUT_LINE_LAYER &&
      options.lookupLineLists
    ) {
      const [lng, lat] = clicked;
      const name = stringValue(feature.properties?.name) || undefined;
      const radius = LINE_LOOKUP_RADIUS_PX * metersPerPixel(lat, map.getZoom());
      options
        .lookupLineLists({ lng, lat, radius, name }, abortController.signal)
        .then((lists) => {
          if (abortController.signal.aborted || popup !== shown) return;
          if (!lists.line_relations && !lists.line_routes) return;
          const properties = { ...feature.properties, ...lists };
          const redrawn = popupContent({ ...feature, properties }, featuresCatalog, abortController, clicked);
          options.extendContent?.({ ...feature, properties }, redrawn);
          shown.setDOMContent(redrawn);
        })
        .catch(() => {});
    }
  });
}
