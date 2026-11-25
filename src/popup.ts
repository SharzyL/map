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

import { installSheetCollapse, isSheetLayout, sheetClosed, sheetOpened } from './bottom-sheet.js';
import { HOVER_LINE_SOURCE_LAYERS, hoveredLineOf, lineFilter } from './line-hover.js';
import { setRailwayHover, type HoverFeature } from './railway-hover.js';
import { renderMarkdown } from './markdown.js';
import {
  ROUTE_SELECT_EVENT,
  STATION_OPEN_EVENT,
  STOP_LABEL_LAYERS,
  type RouteSelection,
  type StationStop,
} from './route-highlight.js';
import type { LineListQuery, LineLists } from './route-trace.js';
import { UI_PANEL_OPEN_EVENT, type UiPanelOpenDetail } from './ui-panels.js';
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
  // Railway lines rather than transit routes, for the route panel.
  kind?: 'route' | 'line';
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
  layer?: { id?: string };
  properties?: JsonRecord;
  geometry: {
    type: string;
    coordinates?: unknown;
  };
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
  // The hover overlay's source (railway-hover.ts); optional for tests.
  getSource?(id: string): unknown;
  // Finds the hovered line's or feature's pieces in the loaded tiles; optional for tests.
  querySourceFeatures?(
    source: string,
    options: { sourceLayer: string; filter?: never },
  ): Array<{ id?: string | number; properties?: JsonRecord; geometry?: RenderedFeatureLike['geometry'] }>;
  isMoving?(): boolean;
  areTilesLoaded?(): boolean;
  once?(type: 'idle', listener: () => void): void;
  on(type: 'mousemove' | 'click', listener: (event: PopupMapEvent) => void): void;
  on(type: 'move' | 'resize', listener: () => void): void;
  off(type: 'move' | 'resize', listener: () => void): void;
  project(lngLat: unknown): { y: number };
  panBy?(offset: [number, number]): void;
};

// MapLibre puts a box above its point when it fits there and below otherwise,
// judging by the box's height when it opens or the map moves. A box taller than
// the room on both sides ran off the map with its end out of reach, and line
// lists arriving later grew it past where it was placed. So the box is
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

// On phones the info box is a bottom sheet (bottom-sheet.ts; style.css,
// `.orm-info-popup` under max-width 640px) instead of a box at its point, with
// a close button of its own that stays put while its content scrolls. On wider
// screens the grabber and that button are hidden and the box stays a MapLibre
// popup at its point.
function installInfoSheet(map: MapLike, popup: PopupBuilderLike) {
  const element = popup.getElement();
  const grabber = el('button');
  const closeButton = el('button', 'orm-sheet-close');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close info box');
  closeButton.innerText = '\u00D7';
  closeButton.addEventListener('click', () => popup.remove());
  element.insertBefore(closeButton, element.firstChild);
  element.insertBefore(grabber, closeButton);

  installSheetCollapse(element, grabber, {
    label: 'info box',
    // Down to its name, with the content scrolled back to the top.
    peek: () => {
      const scroller = element.querySelector('.maplibregl-popup-content');
      if (scroller) scroller.scrollTop = 0;
      const head = element.querySelector('.orm-popup-label') || element.querySelector('.orm-popup-title');
      const top = element.getBoundingClientRect().top;
      return head ? Math.ceil(head.getBoundingClientRect().bottom - top + 12) : 64;
    },
  });

  // It covers the sheets opened before it, such as a timetable, until it closes.
  sheetOpened(element);
  popup.on('close', () => sheetClosed(element));

  // Move the clicked point up out from under the sheet.
  if (isSheetLayout() && map.panBy) {
    const height = map.getContainer().clientHeight;
    const visible = height - element.getBoundingClientRect().height;
    const y = map.project(popup.getLngLat()).y;
    if (visible > 80 && y > visible - 24) map.panBy([0, y - visible / 2]);
  }
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
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
      // Read by the Operator and the default color modes.
      'operator_color',
      'line_color',
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
          kind: 'line',
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
    // yahoo_codes opens the timetable (timetable.ts).
    hiddenProperties: ['id', 'discr_iso', 'count', 'label', 'yahoo_codes'],
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
// `anchor` is the clicked [lng, lat]; routes and lines picked from the box
// carry it so their highlight knows where to start.
export function popupContent(feature: RenderedFeatureLike, featuresCatalog: FeaturesCatalog, anchor?: Coordinates) {
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
      makeRouteSelectable(
        li,
        {
          id: routeId,
          color: groupColor,
          label: selectionLabel,
          kind: list.kind ?? 'route',
          name: label,
          ref: detail || null,
        },
        list.selectTitle,
      );
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
  // Other point layers with info boxes of their own (anitabi's spots), taken
  // before railways under them.
  featurePopups?: FeaturePopup[];
  // The vector source of the railway tiles, where a stop's station is looked
  // up (a stop label clicked, or a station picked in the route panel).
  railwaySource?: string;
};

// Where the tiles' stations are, the most detailed first
const STATION_SOURCE_LAYERS = [
  'standard_railway_text_stations',
  'standard_railway_text_stations_med',
  'standard_railway_text_stations_low',
];
// How far from a stop a station of its name may be, without its OSM element
const STATION_NAME_RADIUS_M = 1000;

function metresBetween([lng1, lat1]: number[], [lng2, lat2]: number[]) {
  const x = (lng2 - lng1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(x, lat2 - lat1) * 111_320;
}

export type FeaturePopup = {
  matches(feature: RenderedFeatureLike): boolean;
  content(feature: RenderedFeatureLike): HTMLElement | null;
};

// Lines drawn below z7 come from this layer, which carries no line or route
// lists; the info box looks them up and is drawn again once they arrive.
const ZOOMED_OUT_LINE_LAYER = 'standard_railway_line_low';
const LINE_LOOKUP_RADIUS_PX = 10;
const LINE_SOURCE_LAYERS = new Set(HOVER_LINE_SOURCE_LAYERS);

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
  map.getContainer().addEventListener('annotation:editopen', () => {
    popup?.remove();
    popup = null;
  });
  // A station's timetable takes over from its info box.
  map.getContainer().addEventListener(UI_PANEL_OPEN_EVENT, (event) => {
    if ((event as CustomEvent<UiPanelOpenDetail>).detail?.id === 'timetable') {
      popup?.remove();
      popup = null;
    }
  });

  // Railway features are the ones whose source layer has a catalog entry.
  const isOrmFeature = (f: RenderedFeatureLike) => Boolean(f.sourceLayer && featuresCatalog[f.sourceLayer]);
  const isOsrmFeature = (f: RenderedFeatureLike) =>
    String(f?.source || '').startsWith('geojson-layer-') && String(f?.properties?.kind || '').startsWith('osrm_');
  const isAnnotationFeature = (f: RenderedFeatureLike) =>
    String(f?.source || '').startsWith('annotation-source') &&
    String(f?.properties?.kind || '').startsWith('annotation_');
  const featurePopups = options.featurePopups || [];
  const isOtherFeature = (f: RenderedFeatureLike) => featurePopups.some((popup) => popup.matches(f));
  const otherPopupOf = (features: RenderedFeatureLike[]) => {
    for (const feature of features) {
      const popup = featurePopups.find((candidate) => candidate.matches(feature));
      if (popup) return { feature, popup };
    }
    return null;
  };
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

  // What the pointer lights (railway-hover.ts): a railway line's segments
  // (line-hover.ts) when it is over one, found in the loaded tiles, else the
  // feature under it. Drawn again only when it changes.
  let hoverKey = '';
  function setHover(key: string, features: () => HoverFeature[]) {
    if (key === hoverKey) return;
    hoverKey = key;
    setRailwayHover(map, key ? features() : []);
  }
  const clearHover = () => setHover('', () => []);
  function hover(feature: RenderedFeatureLike) {
    const line = LINE_SOURCE_LAYERS.has(feature.sourceLayer || '') ? hoveredLineOf(feature.properties || {}) : null;
    const filter = line && lineFilter(line);
    if (filter && map.querySourceFeatures) {
      setHover(`line\u001f${feature.source}\u001f${line.id}\u001f${line.name}`, () =>
        HOVER_LINE_SOURCE_LAYERS.flatMap((sourceLayer) =>
          map.querySourceFeatures(feature.source, { sourceLayer, filter: filter as never }),
        ),
      );
    } else if (feature.id !== undefined && feature.id !== null) {
      setHover(`feature\u001f${feature.source}\u001f${feature.sourceLayer}\u001f${feature.id}`, () => [feature]);
    } else clearHover();
  }

  // Hover cursor
  map.on('mousemove', (event: PopupMapEvent) => {
    // Nothing to point at while the map moves under the pointer (dragged,
    // zoomed, flying): the lit features stay until it stops, and the queries
    // would only take frames from the move.
    if (map.isMoving?.()) return;
    if (isWeatherPickerActive() || isRoutingPickerActive() || isAnnotationPickerActive()) {
      map.getCanvas().style.cursor = 'crosshair';
      clearHover();
      return;
    }

    const renderedFeatures = map.queryRenderedFeatures(event.point);
    const osrmFeatures = renderedFeatures.filter(isOsrmFeature);
    const annotationFeatures = renderedFeatures.filter(isAnnotationFeature);
    const ormFeatures = renderedFeatures.filter(isOrmFeature);
    const hasOtherFeature = renderedFeatures.some((f) => isOtherFeature(f) || isStopLabel(f));
    if (osrmFeatures.length > 0 || annotationFeatures.length > 0 || hasOtherFeature || ormFeatures.length > 0) {
      map.getCanvas().style.cursor = 'pointer';
      if (osrmFeatures.length > 0 || annotationFeatures.length > 0 || hasOtherFeature) clearHover();
      else hover(ormFeatures[0]);
    } else {
      map.getCanvas().style.cursor = '';
      clearHover();
    }
  });

  // An info box at a point, on phones a bottom sheet, replacing the one open.
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
  function openInfoBox(coordinates: unknown, content: HTMLElement) {
    if (popup) popup.remove();
    const shown = new maplibregl.Popup({
      offset: popupOffsets,
      maxWidth: 'min(400px, calc(100vw - 24px))',
      className: 'orm-info-popup',
    })
      .setLngLat(coordinates)
      .setDOMContent(content)
      .addTo(map);
    popup = shown;
    keepPopupInView(map, shown);
    installInfoSheet(map, shown);
    return shown;
  }

  // A stop's station in the tiles: by its OSM elements, else by its name near
  // it; in the tiles loaded, so the map should be over it.
  function stationOf(stop: StationStop): RenderedFeatureLike | null {
    const source = options.railwaySource;
    if (!source || !map.querySourceFeatures) return null;
    const elements = new Set(stop.elements);
    let named: { feature: RenderedFeatureLike; distance: number } | null = null;
    for (const sourceLayer of STATION_SOURCE_LAYERS) {
      for (const found of map.querySourceFeatures(source, { sourceLayer })) {
        const properties = found.properties ?? {};
        const geometry = found.geometry;
        const feature: RenderedFeatureLike = { id: found.id, source, sourceLayer, properties, geometry };
        if (elements.has(`${properties.osm_type}${properties.osm_id}`)) return feature;
        if (properties.name !== stop.name && properties.localized_name !== stop.name) continue;
        if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) continue;
        const distance = metresBetween(geometry.coordinates as number[], stop.position);
        if (distance <= STATION_NAME_RADIUS_M && (!named || distance < named.distance)) named = { feature, distance };
      }
    }
    return named?.feature ?? null;
  }

  // Opens a stop's station info box, as a click on the station would; from
  // the stop alone when the tiles have no such station.
  function openStation(stop: StationStop) {
    const [element] = stop.elements;
    const feature: RenderedFeatureLike = stationOf(stop) ?? {
      source: options.railwaySource ?? '',
      sourceLayer: STATION_SOURCE_LAYERS[0],
      properties: {
        feature: 'station',
        name: stop.name,
        ...(element ? { osm_type: element[0], osm_id: element.slice(1) } : {}),
      },
      geometry: { type: 'Point', coordinates: stop.position },
    };
    const at =
      feature.geometry?.type === 'Point' && Array.isArray(feature.geometry.coordinates)
        ? (feature.geometry.coordinates as Coordinates)
        : stop.position;
    const content = popupContent(feature, featuresCatalog, at);
    if (!content) return;
    options.extendContent?.(feature, content);
    openInfoBox(at, content);
  }

  // From the route panel's list of stations: the map flies there first, so
  // the station is looked up once it rests with its tiles in.
  map.getContainer().addEventListener(STATION_OPEN_EVENT, (event) => {
    const stop = (event as CustomEvent<StationStop>).detail;
    if (!stop) return;
    const settled = !map.isMoving?.() && map.areTilesLoaded?.() !== false;
    if (settled || !map.once) openStation(stop);
    else map.once('idle', () => openStation(stop));
  });

  const isStopLabel = (f: RenderedFeatureLike) => STOP_LABEL_LAYERS.includes(f.layer?.id ?? '');
  const stopOfLabel = (f: RenderedFeatureLike): StationStop | null => {
    const coordinates = f.geometry?.coordinates;
    if (f.geometry?.type !== 'Point' || !Array.isArray(coordinates)) return null;
    return {
      name: stringValue(f.properties?.name),
      position: coordinates as [number, number],
      elements: stringValue(f.properties?.elements).split(',').filter(Boolean),
    };
  };

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
    const other = osrmFeatures.length || annotationFeatures.length ? null : otherPopupOf(renderedFeatures);
    // A stop's name, over the station whose own label it hides: its station.
    const stopLabel =
      osrmFeatures.length || annotationFeatures.length || other ? undefined : renderedFeatures.find(isStopLabel);
    const stop = stopLabel && stopOfLabel(stopLabel);
    if (stop) {
      openStation(stop);
      return;
    }
    if (osrmFeatures.length === 0 && annotationFeatures.length === 0 && !other && ormFeatures.length === 0) return;

    const feature = osrmFeatures[0] || annotationFeatures[0] || other?.feature || ormFeatures[0];
    const isOsrmPopup = osrmFeatures.length > 0;
    const isAnnotationPopup = !isOsrmPopup && annotationFeatures.length > 0;
    const isOtherPopup = !isOsrmPopup && !isAnnotationPopup && Boolean(other);

    // Determine popup coordinates
    const coordinates =
      feature.geometry.type === 'Point'
        ? Array.isArray(feature.geometry.coordinates)
          ? feature.geometry.coordinates.slice()
          : event.lngLat
        : feature.geometry.type === 'LineString' && Array.isArray(feature.geometry.coordinates)
          ? closestPointOnLine(maplibregl, event.lngLat, feature.geometry.coordinates)
          : event.lngLat;

    if (popup) popup.remove();

    const abortController = new AbortController();
    const clicked = maplibregl.LngLat.convert(event.lngLat).toArray();
    const content = isOsrmPopup
      ? osrmPopupContent(feature)
      : isAnnotationPopup
        ? annotationPopupContent(feature)
        : isOtherPopup
          ? other.popup.content(feature)
          : popupContent(feature, featuresCatalog, clicked);
    if (!content) return;
    if (!isOsrmPopup && !isAnnotationPopup && !isOtherPopup) options.extendContent?.(feature, content);

    const shown = openInfoBox(coordinates, content);

    shown.on('close', () => {
      abortController.abort('Popup closed');
    });

    if (
      !isOsrmPopup &&
      !isAnnotationPopup &&
      !isOtherPopup &&
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
          const redrawn = popupContent({ ...feature, properties }, featuresCatalog, clicked);
          options.extendContent?.({ ...feature, properties }, redrawn);
          shown.setDOMContent(redrawn);
        })
        .catch(() => {});
    }
  });

  return {
    // Opens an info box without a click, e.g. for a spot picked from a list.
    open(lngLat: [number, number], content: HTMLElement) {
      openInfoBox(lngLat, content);
    },
  };
}

export type OrmPopups = ReturnType<typeof installOrmPopups>;
