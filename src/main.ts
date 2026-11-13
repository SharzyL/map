import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import type { GlobalContourTileOptions } from 'maplibre-contour/dist/types';
import { installGpxDragDrop, drainGpxQueue, processOrQueueGpx, processOrQueueGeoJson, mergeBounds } from './gpx.js';
import { installOrmPopups, buildFeatureCatalog } from './popup.js';
import { installPhotonSearch } from './search.js';
import { installWeatherPointPicker } from './weather.js';
import { runWhenStyleInfrastructureReady } from './style-ready.js';
import { LayerStore } from './layer-store.js';
import { installAnnotationRenderer } from './annotation-renderer.js';
import { installAnnotationTools } from './annotation-tools.js';
import {
  applyRailwayFilterToStyle,
  HISTORICAL_RAILWAY_SOURCE,
  loadRailwayFilterSettings,
  type RailwayFilterSettings,
} from './railway-filter.js';
import { installRailwayFilter } from './railway-filter-panel.js';
import { installLocate, type DemTileLike } from './cursor-position.js';
import { installControlIcons } from './control-icons.js';
import { addRouteHighlightToStyle, installRouteHighlight } from './route-highlight.js';
import { lineListsNear } from './route-trace.js';
import { installTimetable, timetableButton } from './timetable.js';
import {
  applyMapLayerState,
  loadMapLayerSettings,
  withBaseMapLabelLanguage,
  withBaseMapSaturation,
  withBaseMapVisibility,
  withGrayRoads,
  withHighlightedBoundaries,
  withHybridStyling,
  withShadedRelief,
  withContourVisibility,
  withHillshadeVisibility,
  withRailwayLabelLanguage,
  withSatelliteVisibility,
  type MapLayerSettings,
} from './map-layers.js';
import { installMapLayers } from './map-layers-panel.js';
import type * as ScreenshotFixtureModule from './screenshot-fixture.js';

const LOCAL_ORM_PREFIX = '/orm';
const STYLE_URL = `${LOCAL_ORM_PREFIX}/style/standard.json?v=${__STYLE_HASH__}`;
const TILE_VERSION = '20261113a';
// Optional ?tileset=<archive-name> override to point at a test tileset
// (e.g. openrailwaymap-test-<run_id>), defaulting to the production archive.
const TILE_ARCHIVE = new URLSearchParams(window.location.search).get('tileset') ?? 'openrailwaymap';
const TILE_URL = `${window.location.origin}/tiles/${TILE_ARCHIVE}/{z}/{x}/{y}.mvt?v=${TILE_VERSION}`;
// The single vector source every railway layer draws from.
const ORM_SOURCE = 'openrailwaymap';
// Japan's railway lines in the tiles are MLIT's official lines (国土数値情報
// N02, CC BY 4.0, matched to OSM by scripts/tiles/line-groups.py), which ask
// for this credit.
const N02_ATTRIBUTION =
  '<a href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html" target="_blank" rel="noopener">' +
  '国土数値情報（鉄道データ）</a>（国土交通省）を加工して作成';
// Source code link at the start of the attribution line, bottom right.
const GITHUB_ATTRIBUTION =
  '<a class="attribution-github" href="https://github.com/SharzyL/map" target="_blank" rel="noopener">' +
  '<svg viewBox="0 0 16 16" aria-hidden="true" width="11" height="11"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>' +
  'GitHub</a>';

async function fetchRailwayTile(z: number, x: number, y: number, signal?: AbortSignal) {
  const url = TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const response = await fetch(url, { signal });
  return response.status === 200 ? response.arrayBuffer() : null;
}

const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const MAPTERHORN_TERRAIN_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const SATELLITE_URL = 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
const FULLSCREEN_ACTIVE_CLASS = 'route-map-fullscreen-active';

const app = document.querySelector('#app');
app.innerHTML = `
  <div id="map"></div>
`;

const featuresCatalog = buildFeatureCatalog();
const layerStore = new LayerStore();

type JsonRecord = Record<string, unknown>;
type StyleLayerLike = JsonRecord & {
  id?: string;
  type?: string;
  layout?: JsonRecord;
};
type StyleLike = JsonRecord & {
  glyphs?: string;
  sprite?: string | Array<JsonRecord & { id?: string; url: string }>;
  sources?: Record<string, JsonRecord>;
  layers?: StyleLayerLike[];
  metadata?: JsonRecord;
  state?: Record<string, JsonRecord>;
  center?: maplibregl.LngLatLike;
  zoom?: number;
};
type SpriteSpec = JsonRecord & { id: string; url: string };
type MapLibreErrorEvent = ErrorEvent & {
  error?: unknown;
  sourceId?: string;
  tile?: unknown;
};
type DemSourceLike = {
  setupMaplibre(maplibre: typeof maplibregl): void;
  contourProtocolUrl(options: GlobalContourTileOptions): string;
  manager: {
    fetchAndParseTile(z: number, x: number, y: number, abortController: AbortController): Promise<DemTileLike>;
  };
};
type SpriteAtlas = {
  prefix: string;
  index: Record<string, { x: number; y: number; width: number; height: number; pixelRatio?: number }>;
  image: CanvasImageSource;
  sdf: boolean;
};
type Bounds = [[number, number], [number, number]];
type SwrCacheEntry = { response: Response; timestamp: number };
type GeolocateControlOptionsWithHeading = maplibregl.GeolocateControlOptions & {
  showUserHeading?: boolean;
};
type ScreenshotFixture = typeof ScreenshotFixtureModule;

async function loadScreenshotFixture() {
  if (!__SCREENSHOT_FIXTURES__) return null;
  return (await import('./screenshot-fixture.js')) as ScreenshotFixture;
}

function absoluteUrl(path: string) {
  return `${window.location.origin}${path}`;
}

function importNameFromUrl(url: string, fallback: string) {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol === 'data:') return fallback;
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '') || fallback;
  } catch {
    return fallback;
  }
}

async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFontStack(value: unknown): value is string[] {
  return isStringArray(value) && value.some((fontName) => /(?:Noto Sans|Fira Code)/.test(fontName));
}

function coerceSpriteList(sprite: StyleLike['sprite'], defaultId: string): SpriteSpec[] {
  if (!sprite) return [];
  if (typeof sprite === 'string') return [{ id: defaultId, url: sprite }];
  return sprite.map((entry) => ({ ...entry, id: entry.id || defaultId }));
}

function rewriteOrmSpriteUrl(url: string): string {
  if (url.startsWith('/orm/')) return absoluteUrl(url);
  if (url.startsWith('/')) return absoluteUrl(`/orm${url}`);
  return url;
}

/**
 * Fetch with stale-while-revalidate caching.
 * Serves cached responses instantly while revalidating in the background.
 */
const swrCache = new Map<string, SwrCacheEntry>();
async function fetchWithSwr(url: string, ttlMs = 3600_000) {
  const cached = swrCache.get(url);
  if (cached && Date.now() - cached.timestamp < ttlMs) {
    // Still fresh — return directly
    return cached.response.clone();
  }
  if (cached) {
    // Stale — return cached version, revalidate in background
    fetch(url)
      .then((res) => {
        if (res.ok) swrCache.set(url, { response: res, timestamp: Date.now() });
      })
      .catch(() => {});
    return cached.response.clone();
  }
  // No cache — fetch and store
  const res = await fetch(url);
  if (res.ok) swrCache.set(url, { response: res.clone(), timestamp: Date.now() });
  return res;
}

function rewriteOrmStyle(style: StyleLike): StyleLike {
  style.layers = style.layers?.map(normalizeOrmLayerFonts);
  style.sprite = coerceSpriteList(style.sprite, 'orm').map((sprite) => ({
    ...sprite,
    id: sprite.id === 'default' ? 'orm' : sprite.id,
    url: rewriteOrmSpriteUrl(sprite.url),
  }));

  // The ORM style splits its layers over several vector sources (one per
  // upstream Martin endpoint). Our archive holds every source layer in one
  // tile, and MapLibre fetches tiles per source, so separate sources would
  // download each tile once per source in view. They all become one source.
  const isRailwaySource = (source: JsonRecord | undefined) =>
    source?.type === 'vector' && typeof source.url === 'string' && source.url.startsWith('/');
  const railwaySourceNames = new Set(
    Object.entries(style.sources || {})
      .filter(([, source]) => isRailwaySource(source))
      .map(([name]) => name),
  );
  const attribution = Object.values(style.sources || {}).find(isRailwaySource)?.attribution;
  style.sources = {
    ...Object.fromEntries(Object.entries(style.sources || {}).filter(([name]) => !railwaySourceNames.has(name))),
    [ORM_SOURCE]: {
      type: 'vector',
      tiles: [TILE_URL],
      attribution: [attribution, N02_ATTRIBUTION].filter(Boolean).join(' '),
      maxzoom: 15,
    },
  };
  style.layers = style.layers?.map((layer) =>
    railwaySourceNames.has(layer.source as string) ? { ...layer, source: ORM_SOURCE } : layer,
  );

  style.metadata = {
    ...(style.metadata || {}),
    ormClone: true,
    ormRewrittenSources: [ORM_SOURCE],
  };

  return style;
}

function normalizeOrmFontName(fontName: string): string {
  if (fontName.includes('Italic')) return 'Noto Sans Italic';
  if (fontName.includes('Bold') || fontName.includes('Fira Code')) return 'Noto Sans Bold';
  return 'Noto Sans Regular';
}

function normalizeTextFont(value: unknown): unknown {
  if (isFontStack(value)) return [normalizeOrmFontName(value[0] || 'Noto Sans Regular')];
  if (!Array.isArray(value)) return value;
  if (value[0] === 'literal' && isFontStack(value[1])) {
    return ['literal', [normalizeOrmFontName(value[1][0] || 'Noto Sans Regular')]];
  }
  return value.map((item) => normalizeTextFont(item));
}

function normalizeOrmLayerFonts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeOrmLayerFonts) as T;
  if (!value || typeof value !== 'object') return value;
  const normalized: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'text-font') {
      normalized[key] = normalizeTextFont(child);
    } else if (key === 'icon-image' || key === 'fill-pattern' || key === 'line-pattern') {
      normalized[key] = namespaceOrmImageReference(child);
    } else {
      normalized[key] = normalizeOrmLayerFonts(child);
    }
  }
  return normalized as T;
}

function namespaceOrmImageId(id: string): string {
  if (!id || id.startsWith('sdf:') || id.startsWith('orm:')) return id;
  return `orm:${id}`;
}

function namespaceOrmImageReference(value: unknown): unknown {
  if (typeof value === 'string') return namespaceOrmImageId(value);
  if (!Array.isArray(value)) return value;

  const [operator, ...args] = value;
  if (operator === 'image') {
    return ['image', namespaceOrmImageReference(args[0])];
  }

  if (operator === 'concat') {
    const first = args[0];
    if (typeof first === 'string' && (first.startsWith('sdf:') || first.startsWith('orm:'))) return value;
    return ['concat', 'orm:', ...args];
  }

  if (operator === 'case') {
    return value.map((item, index) =>
      index >= 2 && (index % 2 === 0 || index === value.length - 1) ? namespaceOrmImageReference(item) : item,
    );
  }

  if (operator === 'match') {
    return value.map((item, index) =>
      (index > 2 && index % 2 === 1) || index === value.length - 1 ? namespaceOrmImageReference(item) : item,
    );
  }

  if (operator === 'step') {
    return value.map((item, index) =>
      index === 2 || (index > 3 && index % 2 === 0) ? namespaceOrmImageReference(item) : item,
    );
  }

  if (operator === 'coalesce') {
    return [operator, ...args.map(namespaceOrmImageReference)];
  }

  return ['concat', 'orm:', value];
}

function mergeStyleSprites(baseSprite: StyleLike['sprite'], ormSprite: StyleLike['sprite']): SpriteSpec[] | undefined {
  const mergedSprites = [...coerceSpriteList(baseSprite, 'default'), ...coerceSpriteList(ormSprite, 'orm')];
  const seenIds = new Set<string>();
  const uniqueSprites = mergedSprites.filter((sprite) => {
    if (seenIds.has(sprite.id)) return false;
    seenIds.add(sprite.id);
    return true;
  });
  return uniqueSprites.length > 0 ? uniqueSprites : undefined;
}

function getFirstSymbolLayerId(style: StyleLike) {
  return (style.layers || []).find((layer) => layer.type === 'symbol')?.id;
}

function addMapterhornTerrain(style: StyleLike, demSource: DemSourceLike): StyleLike {
  style.sources = {
    ...(style.sources || {}),
    hillshadeSource: {
      type: 'raster-dem',
      url: 'https://tiles.mapterhorn.com/tilejson.json',
    },
    contourSource: {
      type: 'vector',
      tiles: [
        demSource.contourProtocolUrl({
          thresholds: {
            9: [100, 500],
            10: [50, 250],
            11: [25, 100],
            12: [25, 100],
            13: [10, 50],
            14: [10, 40],
          },
          contourLayer: 'contours',
          elevationKey: 'ele',
          levelKey: 'level',
        }),
      ],
      maxzoom: 17,
    },
  };

  const terrainBaseLayers = [
    withHillshadeVisibility({
      id: 'trip-hillshade',
      type: 'hillshade',
      source: 'hillshadeSource',
      paint: {
        'hillshade-shadow-color': 'rgba(20, 24, 36, 0.34)',
        'hillshade-highlight-color': 'rgba(255, 255, 255, 0.28)',
        'hillshade-illumination-direction': 315,
        'hillshade-exaggeration': 0.26,
      },
    }),
    withContourVisibility({
      id: 'trip-contour-lines',
      type: 'line',
      source: 'contourSource',
      'source-layer': 'contours',
      minzoom: 8,
      paint: {
        'line-color': ['match', ['get', 'level'], 0, 'rgba(45, 56, 78, 0.28)', 'rgba(34, 44, 64, 0.44)'],
        'line-width': ['match', ['get', 'level'], 0, 0.45, 1, 1.05, 1.35],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.26, 11, 0.42, 14, 0.65],
      },
    }),
  ];

  const contourLabelLayer = withContourVisibility({
    id: 'trip-contour-labels',
    type: 'symbol',
    source: 'contourSource',
    'source-layer': 'contours',
    filter: ['>', ['get', 'level'], 0],
    minzoom: 10,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 200,
      'text-size': 10,
      'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'],
      'text-font': ['Noto Sans Regular'],
      'text-max-angle': 90,
      'text-padding': 1,
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': 'rgba(22, 31, 48, 0.6)',
      'text-halo-color': 'rgba(255, 255, 255, 0.82)',
      'text-halo-width': 1.1,
    },
  });

  // Insert hillshade and contour lines before other symbol layers (they render underneath)
  const beforeId = getFirstSymbolLayerId(style);
  const insertIndex = beforeId ? style.layers.findIndex((layer) => layer.id === beforeId) : style.layers.length;
  style.layers.splice(insertIndex === -1 ? style.layers.length : insertIndex, 0, ...terrainBaseLayers);
  // Append contour labels at the very end so they win collision detection against ORM labels
  style.layers.push(contourLabelLayer);
  return style;
}

function addSatelliteSourceAndLayer(style: StyleLike): StyleLike {
  style.sources = {
    ...(style.sources || {}),
    satellite: {
      type: 'raster',
      tiles: [SATELLITE_URL],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 22,
      attribution: '&copy; Google',
    },
  };

  // Imagery goes at the bottom, right above the base map's background, so the
  // roads and labels hybrid mode keeps are drawn over it. (Inserting it before
  // the first symbol layer would cover OpenFreeMap's ground-level roads, which
  // come before its one-way arrows.)
  const insertIdx = style.layers.findIndex((l: StyleLayerLike) => l.type !== 'background' && l.type !== 'raster');
  const satelliteLayer = withBaseMapSaturation(
    withSatelliteVisibility({
      id: 'satellite-layer',
      type: 'raster',
      source: 'satellite',
      paint: { 'raster-opacity': 1 },
    }),
  );

  if (insertIdx !== -1) {
    style.layers.splice(insertIdx, 0, satelliteLayer);
  } else {
    style.layers.push(satelliteLayer);
  }

  return style;
}

// No `date`: the style's own default is the year it was generated, which its
// layers compare `date` against to tell today's map from a historical one.
const STATE_DEFAULTS = {
  allDates: false,
  theme: 'light',
  // Station names rather than short reference codes, which are often bare numbers.
  stationLowZoomLabel: 'name',
  openHistoricalMap: true,
  showAbandonedInfrastructure: false,
  showRazedInfrastructure: false,
  showConstructionInfrastructure: true,
  showProposedInfrastructure: true,
  hillshade: false,
  electrificationRailwayLine: 'voltageFrequency',
  trackRailwayLine: 'gauge',
};

function mergeBaseAndOrm(baseStyle: StyleLike, ormStyle: StyleLike): StyleLike {
  const merged = structuredClone(baseStyle);
  const baseLayers = (baseStyle.layers || []).map((layer) =>
    withBaseMapLabelLanguage(
      withBaseMapSaturation(
        withShadedRelief(withHighlightedBoundaries(withGrayRoads(withHybridStyling(withBaseMapVisibility(layer))))),
      ),
    ),
  );
  merged.center = ormStyle.center || merged.center;
  merged.zoom = ormStyle.zoom || merged.zoom;
  merged.glyphs = merged.glyphs || ormStyle.glyphs;
  merged.sprite = mergeStyleSprites(merged.sprite, ormStyle.sprite);
  // Set state defaults before the style is applied to avoid initial render flash
  const state = { ...(merged.state || {}), ...(ormStyle.state || {}) };
  for (const [key, value] of Object.entries(STATE_DEFAULTS)) {
    state[key] = {
      ...(state[key] || {}),
      default: value,
    };
  }
  merged.state = state;
  merged.metadata = { ...(merged.metadata || {}), ...(ormStyle.metadata || {}) };
  merged.sources = { ...(merged.sources || {}), ...(ormStyle.sources || {}) };
  merged.layers = [...baseLayers, ...(ormStyle.layers || []).map(withRailwayLabelLanguage)];
  return merged;
}

function isMapResourceLoadError(event: MapLibreErrorEvent): boolean {
  const message = event.error instanceof Error ? event.error.message : String(event.error || '');
  return Boolean(event.sourceId || event.tile || /(?:tile|glyph|sprite|image|resource|fetch|load)/i.test(message));
}

function installMapLibreErrorLogging(map: maplibregl.Map) {
  map.on('error', (event: MapLibreErrorEvent) => {
    if (isMapResourceLoadError(event)) {
      console.debug('MapLibre resource load skipped:', event);
      return;
    }
    console.error('MapLibre error:', event);
  });
}

async function loadStyle(
  demSource: DemSourceLike,
  railwayFilter: RailwayFilterSettings,
  mapLayers: MapLayerSettings,
): Promise<StyleLike> {
  const [baseStyle, ormStyleRaw] = await Promise.all([
    loadJson<StyleLike>(OPENFREEMAP_STYLE),
    loadJson<StyleLike>(STYLE_URL),
  ]);
  const ormStyle = rewriteOrmStyle(ormStyleRaw);
  const railwaySources = (ormStyle.metadata?.ormRewrittenSources as string[] | undefined) ?? [];
  const merged = addRouteHighlightToStyle(
    // OpenHistoricalMap's railways follow the overlay switch too.
    applyRailwayFilterToStyle(
      mergeBaseAndOrm(baseStyle, ormStyle),
      [...railwaySources, HISTORICAL_RAILWAY_SOURCE],
      railwayFilter,
    ),
    railwaySources,
  );
  const withTerrain = addMapterhornTerrain(merged, demSource);
  return withGlobe(applyMapLayerState(addSatelliteSourceAndLayer(withTerrain), mapLayers));
}

// Always a globe: MapLibre draws a sphere at low zoom and blends into the flat
// map around zoom 10-12. Outside the sphere the canvas is transparent and the
// map container's starfield (style.css) shows through; `sky` adds the
// atmosphere glow around the globe and a sky gradient above the horizon when
// the map is tilted.
function withGlobe(style: StyleLike): StyleLike {
  return {
    ...style,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#2f6fb3',
      'horizon-color': '#cfe3f7',
      'sky-horizon-blend': 0.6,
      'fog-color': '#cfe3f7',
      'horizon-fog-blend': 0.5,
      'fog-ground-blend': 0.8,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    },
  };
}

function isSpriteIndex(value: unknown): value is SpriteAtlas['index'] {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// MapLibre requests `<sprite>@2x.png` on high-DPI screens. Cloudflare's static
// assets answer a literal '@' with a 307 to '%40', so production builds ask for
// the encoded name directly. The Vite dev server is the other way round: it
// serves '@2x' and answers '%402x' with the app's HTML.
const SPRITE_2X_SUFFIX = import.meta.env.PROD ? '%402x' : '@2x';

function spriteFileUrl(path: string, extension: 'json' | 'png') {
  return `${path}${window.devicePixelRatio > 1 ? SPRITE_2X_SUFFIX : ''}.${extension}`;
}

function transformSpriteRequest(url: string, resourceType?: string) {
  if (resourceType !== 'SpriteJSON' && resourceType !== 'SpriteImage') return undefined;
  if (!import.meta.env.PROD || !url.startsWith(window.location.origin) || !url.includes('@2x.')) return undefined;
  return { url: url.replace('@2x.', `${SPRITE_2X_SUFFIX}.`) };
}

// The same files MapLibre loads for the style's sprites, so these come from
// the HTTP cache.
// The full ORM sprites, with every icon of every ORM style.
const SPRITE_ATLASES = [
  { prefix: 'orm:', path: '/orm/sprite/symbols', sdf: false },
  { prefix: 'sdf:', path: '/orm/sdf_sprite/symbols', sdf: true },
];

async function loadSpriteAtlases(): Promise<SpriteAtlas[]> {
  return Promise.all(
    SPRITE_ATLASES.map(async ({ prefix, path, sdf }) => {
      const [index, image] = await Promise.all([
        loadJson<unknown>(spriteFileUrl(path, 'json')),
        loadImage(spriteFileUrl(path, 'png')),
      ]);
      return { prefix, sdf, index: isSpriteIndex(index) ? index : {}, image };
    }),
  );
}

function addSpriteImage(map: maplibregl.Map, id: string, atlases: SpriteAtlas[]) {
  for (const atlas of atlases) {
    const key = id.startsWith(atlas.prefix) ? id.slice(atlas.prefix.length) : null;
    if (key && atlas.index[key]) {
      const meta = atlas.index[key];
      const canvas = document.createElement('canvas');
      canvas.width = meta.width;
      canvas.height = meta.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(atlas.image, meta.x, meta.y, meta.width, meta.height, 0, 0, meta.width, meta.height);
      const data = ctx.getImageData(0, 0, meta.width, meta.height).data;
      if (!map.hasImage(id)) {
        map.addImage(
          id,
          { width: meta.width, height: meta.height, data },
          { pixelRatio: meta.pixelRatio || 1, sdf: atlas.sdf },
        );
      }
      return;
    }
  }
}

// Fills ORM icons MapLibre reports missing from the style's sprites, which
// hold only the icons the standard style is known to use
// (scripts/styles/sprite-subset.mjs). The full atlases load on the first such
// miss rather than up front, so they never delay the map. Base map icons that
// OpenFreeMap's sprite lacks are not ours to fill and must not trigger the
// download.
function installSpriteFallback(map: maplibregl.Map) {
  let atlases: Promise<SpriteAtlas[]> | null = null;
  map.on('styleimagemissing', (e) => {
    if (!SPRITE_ATLASES.some(({ prefix }) => e.id.startsWith(prefix))) return;
    atlases ??= loadSpriteAtlases();
    atlases
      .then((loaded) => addSpriteImage(map, e.id, loaded))
      .catch((error) => console.warn('Sprite fallback failed:', error));
  });
}

// Without a URL hash the map opens on the whole Yamanote loop in Tokyo (新宿
// to 秋葉原, 田端 to 品川): zoom 12 on wide screens, further out on narrow ones
// so the loop still fits.
const DEFAULT_VIEW = {
  center: [139.737, 35.685] as [number, number],
  zoom: 12,
  bounds: [
    [139.7, 35.628],
    [139.777, 35.739],
  ] as maplibregl.LngLatBoundsLike,
  fitBoundsOptions: { padding: 24, maxZoom: 12 },
};

async function init() {
  try {
    const screenshotFixtureModule = await loadScreenshotFixture();
    const screenshotFixtureMode = screenshotFixtureModule?.getScreenshotFixtureMode() ?? null;
    const screenshotFixtureView =
      screenshotFixtureModule && screenshotFixtureMode
        ? screenshotFixtureModule.getScreenshotFixtureView(screenshotFixtureMode)
        : null;
    const demSource = new mlcontour.DemSource({
      url: MAPTERHORN_TERRAIN_URL,
      encoding: 'terrarium',
      maxzoom: 17,
      worker: true,
    });
    demSource.setupMaplibre(maplibregl);
    const railwayFilter = loadRailwayFilterSettings();
    const mapLayers = loadMapLayerSettings();
    const style = await loadStyle(demSource, railwayFilter, mapLayers);

    window._mlmap = null;
    const map = new maplibregl.Map({
      container: 'map',
      style: style as maplibregl.StyleSpecification,
      center: screenshotFixtureView ? screenshotFixtureView.center : DEFAULT_VIEW.center,
      zoom: screenshotFixtureView ? screenshotFixtureView.zoom : DEFAULT_VIEW.zoom,
      ...(screenshotFixtureView
        ? {}
        : { bounds: DEFAULT_VIEW.bounds, fitBoundsOptions: DEFAULT_VIEW.fitBoundsOptions }),
      hash: true,
      attributionControl: { customAttribution: GITHUB_ATTRIBUTION } as maplibregl.AttributionControlOptions,
      renderWorldCopies: false,
      maxZoom: 20,
      maxPitch: 85,
      transformRequest: transformSpriteRequest,
    });

    window._mlmap = map;
    // style.css joins fullscreen onto zoom and compass, and Locate onto geolocate.
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');
    const geolocateOptions: GeolocateControlOptionsWithHeading = {
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    };
    const geolocateControl = new maplibregl.GeolocateControl(geolocateOptions);
    map.addControl(geolocateControl, 'top-right');
    installLocate(map, (z, x, y) => demSource.manager.fetchAndParseTile(z, x, y, new AbortController()));
    installControlIcons(map);
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
    installPhotonSearch(map, maplibregl);
    installWeatherPointPicker(map, maplibregl);
    // Layers sits right above Railways, which style.css joins onto it.
    installMapLayers(map, mapLayers);
    if (screenshotFixtureModule && screenshotFixtureMode) {
      screenshotFixtureModule.installScreenshotFixtureMapLayers(map, screenshotFixtureMode);
    }
    installRailwayFilter(map, railwayFilter, Number(style.state?.date?.default) || new Date().getFullYear());
    installRouteHighlight(map);
    installTimetable(map);
    if (screenshotFixtureModule && screenshotFixtureMode) {
      screenshotFixtureModule.installScreenshotFixtureData(layerStore, screenshotFixtureMode);
    }
    installAnnotationRenderer(map, layerStore);
    // Last, so its button ends the control column.
    installAnnotationTools(map, layerStore);

    installSpriteFallback(map);

    // Register GPX drag-drop immediately (map container exists now)
    // Don't wait for 'load' — user may drag a file before tiles finish loading
    installGpxDragDrop(map);

    // Load GPX from URL parameters (?gpx=url1&gpx=url2)
    // Compatible with MapLibre's hash-based URL sync (hash and query string are independent)
    const gpxUrls = screenshotFixtureMode ? [] : new URLSearchParams(window.location.search).getAll('gpx');
    if (gpxUrls.length > 0) {
      (async () => {
        let bounds: Bounds | null = null;
        await Promise.allSettled(
          gpxUrls.map(async (gpxUrl) => {
            try {
              const res = await fetchWithSwr(gpxUrl);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const xml = await res.text();
              const stats = await processOrQueueGpx(map, xml, { name: importNameFromUrl(gpxUrl, 'GPX URL') });
              if (stats?.bounds) bounds = mergeBounds(bounds, stats.bounds);
            } catch (err) {
              console.error('Failed to load GPX from URL:', gpxUrl, err);
            }
          }),
        );
        if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
      })();
    }

    // Load GeoJSON from URL parameters (?geojson=url1&geojson=url2)
    // Supports both LineString (tracks) and Point (waypoints) features
    const geojsonUrls = screenshotFixtureMode ? [] : new URLSearchParams(window.location.search).getAll('geojson');
    if (geojsonUrls.length > 0) {
      (async () => {
        let bounds: Bounds | null = null;
        await Promise.allSettled(
          geojsonUrls.map(async (geojsonUrl) => {
            try {
              const res = await fetchWithSwr(geojsonUrl);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = await res.json();
              const result = processOrQueueGeoJson(map, data, { name: importNameFromUrl(geojsonUrl, 'GeoJSON URL') });
              if (result?.bounds) bounds = mergeBounds(bounds, result.bounds);
            } catch (err) {
              console.error('Failed to load GeoJSON from URL:', geojsonUrl, err);
            }
          }),
        );
        if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
      })();
    }

    if (screenshotFixtureModule && screenshotFixtureMode) {
      screenshotFixtureModule.applyScreenshotFixtureScene(screenshotFixtureMode, map);
    }

    let didRunMapReadySetup = false;
    const runMapReadySetup = () => {
      if (didRunMapReadySetup) return;
      didRunMapReadySetup = true;
      installOrmPopups(map, maplibregl, featuresCatalog, {
        lookupLineLists: (query, signal) => lineListsNear(query, fetchRailwayTile, signal),
        extendContent: timetableButton,
      });
      drainGpxQueue(map);
      let resizeFrame = 0;
      const scheduleResize = () => {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          map.resize();
        });
      };
      const syncFullscreenState = () => {
        const isFullscreen =
          document.fullscreenElement === map.getContainer() || document.webkitFullscreenElement === map.getContainer();
        document.body.classList.toggle(FULLSCREEN_ACTIVE_CLASS, isFullscreen);
        scheduleResize();
      };
      scheduleResize();
      setTimeout(scheduleResize, 240);
      setTimeout(scheduleResize, 800);
      window.addEventListener('resize', scheduleResize, { passive: true });
      new ResizeObserver(() => scheduleResize()).observe(map.getContainer());
      syncFullscreenState();
      document.addEventListener('fullscreenchange', syncFullscreenState, { passive: true });
      document.addEventListener('webkitfullscreenchange', syncFullscreenState, { passive: true });
    };
    map.on('load', runMapReadySetup);
    if (map.loaded()) runMapReadySetup();
    // 'load' waits for every in-view tile and can be delayed indefinitely — or
    // never fire — which would strand the deferred GPX/GeoJSON queue and leave
    // popups uninstalled. A parsed style is enough for everything set up here.
    else runWhenStyleInfrastructureReady(map, runMapReadySetup);

    installMapLibreErrorLogging(map);
  } catch (error) {
    console.error(error);
  }
}

init();
