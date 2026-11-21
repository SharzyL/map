// anitabi's anime pilgrimage spots on the map (experimental): a circle per
// spot in its work's color, thinned by the spot's priority as anitabi thins
// them, and an info box with the scene and the work. The Layers panel's switch
// flips the `showAnitabi` global state; the data (anitabi.ts) is fetched the
// first time it is switched on, not before.

import {
  ANITABI_API,
  anitabiImageUrl,
  anitabiKey,
  anitabiMapUrl,
  bangumiUrl,
  indexedDbCache,
  loadAnitabi,
  originUrl,
  parseUsers,
  type AnitabiCache,
  type AnitabiPoint,
  type AnitabiWork,
  type LoadProgress,
} from './anitabi.js';
import { runWhenStyleInfrastructureReady, setGlobalStatePropertyWhenReady } from './style-ready.js';

export const ANITABI_SOURCE = 'anitabi';
export const ANITABI_LAYER = 'anitabi-spots';
export const ANITABI_STATE = 'showAnitabi';
// The one work whose spots show (the list's selection, anitabi-list.ts), all
// of them at every zoom; 0 for all works, thinned by priority.
export const ANITABI_WORK_STATE = 'anitabiWork';

const DEFAULT_COLOR = '#11b4da';

// anitabi's own: from further out only the spots it ranks highest, all of
// them from z17.
export const ANITABI_PRIORITY_FILTER = [
  'step',
  ['zoom'],
  ['>', ['get', 'priority'], 60000],
  2,
  ['>', ['get', 'priority'], 36000],
  3,
  ['>', ['get', 'priority'], 24000],
  4,
  ['>', ['get', 'priority'], 12000],
  5,
  ['>', ['get', 'priority'], 6000],
  6,
  ['>', ['get', 'priority'], 3000],
  7,
  ['>', ['get', 'priority'], 1500],
  8,
  ['>', ['get', 'priority'], 600],
  9,
  ['>', ['get', 'priority'], 300],
  10,
  ['>', ['get', 'priority'], 150],
  11,
  ['>', ['get', 'priority'], 100],
  12,
  ['>', ['get', 'priority'], 40],
  13,
  ['>', ['get', 'priority'], 20],
  14,
  ['>', ['get', 'priority'], 10],
  15,
  ['>', ['get', 'priority'], 5],
  16,
  ['>', ['get', 'priority'], 3],
  17,
  true,
];

const SELECTED_WORK = ['to-number', ['global-state', ANITABI_WORK_STATE]];

// The priority filter, but with a work selected only that work's spots. A
// filter takes zoom only at its top, so the choice goes in every step.
export const ANITABI_FILTER = ANITABI_PRIORITY_FILTER.map((output, index) =>
  index >= 2 && index % 2 === 0
    ? ['case', ['==', SELECTED_WORK, 0], output, ['==', ['get', 'aid'], SELECTED_WORK]]
    : output,
);

type StyleLike = {
  sources?: Record<string, unknown>;
  layers?: Array<Record<string, unknown>>;
  state?: Record<string, unknown>;
};

// An empty source and the spots' layer, on top of everything, shown while
// `showAnitabi` is on.
export function addAnitabiToStyle<T extends StyleLike>(style: T): T {
  return {
    ...style,
    state: { ...(style.state || {}), [ANITABI_WORK_STATE]: { default: 0 } },
    sources: { ...(style.sources || {}), [ANITABI_SOURCE]: { type: 'geojson', data: emptyCollection() } },
    layers: [
      ...(style.layers || []),
      {
        id: ANITABI_LAYER,
        type: 'circle',
        source: ANITABI_SOURCE,
        filter: ANITABI_FILTER,
        layout: { visibility: ['case', ['to-boolean', ['global-state', ANITABI_STATE]], 'visible', 'none'] },
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 12, 4.5, 18, 8],
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 12, 1.5, 18, 3],
          'circle-stroke-color': '#ffffff',
        },
      },
    ],
  };
}

function emptyCollection() {
  return { type: 'FeatureCollection' as const, features: [] as unknown[] };
}

// One point per spot; those with a screenshot come last, so they draw on top.
export function anitabiFeatures(works: AnitabiWork[]) {
  type SpotFeature = {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { pid: string; aid: number; color: string; priority: number };
  };
  const withoutImage: SpotFeature[] = [];
  const withImage: SpotFeature[] = [];
  for (const work of works) {
    for (const point of work.points) {
      (point.image ? withImage : withoutImage).push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.geo[1], point.geo[0]] },
        properties: { pid: point.id, aid: work.id, color: work.color || DEFAULT_COLOR, priority: point.priority },
      });
    }
  }
  return { type: 'FeatureCollection' as const, features: [...withoutImage, ...withImage] };
}

// --- Info box ------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, parent?: Element) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.appendChild(node);
  return node;
}

function link(parent: Element, text: string, href: string) {
  const a = el('a', undefined, parent);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  return a;
}

// An anitabi image in its frame: a spinner and "Loading…" in its place
// until it arrives, then the image fades in. A failed one leaves "No image",
// or whatever `onError` does instead.
export function loadImage(frame: HTMLElement, src: string, alt = '', onError?: () => void) {
  frame.classList.add('anitabi-image');
  const status = el('span', 'anitabi-image-status', frame);
  el('span', 'anitabi-image-spinner', status).setAttribute('aria-hidden', 'true');
  el('span', 'anitabi-image-text', status).textContent = 'Loading…';
  const img = el('img', undefined, frame);
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => {
    status.remove();
    frame.classList.add('anitabi-image-loaded');
  });
  img.addEventListener('error', () => {
    img.remove();
    if (onError) return onError();
    status.replaceChildren();
    el('span', 'anitabi-image-text', status).textContent = 'No image';
    frame.classList.add('anitabi-image-failed');
  });
  img.src = src;
  return img;
}

type Row = [label: string, value: string | undefined, href?: string];

function section(parent: Element, title: string, rows: Row[]) {
  const shown = rows.filter(([, value]) => value);
  if (shown.length === 0) return;
  const box = el('section', 'orm-popup-section', parent);
  el('h6', 'orm-popup-section-title', box).textContent = title;
  const list = el('dl', 'orm-popup-fields', box);
  for (const [label, value, href] of shown) {
    el('dt', undefined, list).textContent = label;
    const dd = el('dd', undefined, list);
    if (href) link(dd, value, href);
    else dd.textContent = value;
  }
}

export function formatEpisode(ep: AnitabiPoint['ep']) {
  if (ep === undefined || ep === '') return undefined;
  return typeof ep === 'number' ? `EP ${ep}` : ep;
}

export function formatSceneTime(seconds: number | undefined) {
  if (!seconds || seconds < 0) return undefined;
  const s = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function distinct(...names: Array<string | undefined>) {
  const seen = new Set<string>();
  return names.filter((name): name is string => Boolean(name) && !seen.has(name) && Boolean(seen.add(name)));
}

export function anitabiPopupContent(work: AnitabiWork, point: AnitabiPoint, users: Map<number, string> = new Map()) {
  const container = el('div', 'orm-popup anitabi-popup');
  const [spotName, ...otherSpotNames] = distinct(point.cn, point.name);
  el('h5', 'orm-popup-title', container).textContent = spotName || 'Pilgrimage spot';
  if (otherSpotNames.length) el('div', 'anitabi-popup-subtitle', container).textContent = otherSpotNames.join(' / ');

  const label = el('h6', 'orm-popup-label', container);
  const marker = el('span', 'orm-color-marker', label);
  marker.style.backgroundColor = work.color || DEFAULT_COLOR;
  el('span', undefined, label).textContent = work.cn || work.title || `Work ${work.id}`;

  const image = anitabiImageUrl(point.image, 'h360');
  if (image) {
    const frame = link(container, '', anitabiImageUrl(point.image) || image);
    frame.className = 'anitabi-popup-image';
    frame.title = 'The scene, full size';
    loadImage(frame, image, spotName ? `Scene at ${spotName}` : 'Scene', () => frame.remove());
  }

  const sections = el('div', 'orm-popup-sections', container);
  const contributor = point.uid === undefined ? undefined : users.get(point.uid) || `#${point.uid}`;
  section(sections, 'Scene', [
    ['Episode', formatEpisode(point.ep)],
    ['Time', formatSceneTime(point.s)],
    ['Note', point.mark],
    ['Group', point.folder],
    ['Source', point.origin || (point.mid ? 'Google My Maps' : undefined), originUrl(point)],
    ['Contributor', contributor],
    ['Position', `${point.geo[0].toFixed(6)}, ${point.geo[1].toFixed(6)}`],
  ]);
  const otherTitles = distinct(work.title, work.cn, work.en).filter((title) => title !== (work.cn || work.title));
  section(sections, 'Work', [
    ['Title', otherTitles.join(' / ') || undefined],
    ['Type', work.cat],
    ['Area', work.city],
    ['Tags', work.tags.join(', ') || undefined],
    ['Spots', String(work.points.length)],
  ]);
  section(sections, 'Links', [
    ['Bangumi', `bgm.tv/subject/${work.id}`, bangumiUrl(work.id)],
    ['anitabi', 'Open in anitabi', anitabiMapUrl(work.id, point.id)],
  ]);
  return container;
}

// --- On the map ----------------------------------------------------------

type GeoJsonSourceLike = { setData(data: unknown): unknown };
type AnitabiMap = Parameters<typeof runWhenStyleInfrastructureReady>[0] & {
  getSource(id: string): unknown;
};

type RenderedFeatureLike = { source?: string; properties?: Record<string, unknown> | null };

export type AnitabiStatus = { state: 'off' | 'loading' | 'ready' | 'failed'; text: string };

export type AnitabiChange = {
  // The person switched the spots on (not a setting restored at load)
  switchedOn?: boolean;
};

export type AnitabiController = {
  setEnabled(enabled: boolean, options?: { byUser?: boolean }): void;
  readonly enabled: boolean;
  readonly status: AnitabiStatus;
  onStatus(listener: (status: AnitabiStatus) => void): void;
  // Switched on or off, new data, another work selected
  onChange(listener: (change: AnitabiChange) => void): void;
  work(id: number): AnitabiWork | undefined;
  // Shows only this work's spots, or every work's with null
  selectWork(id: number | null): void;
  readonly selectedWork: number | null;
  // For the info box (popup.ts featurePopups)
  matches(feature: RenderedFeatureLike): boolean;
  content(feature: RenderedFeatureLike): HTMLElement | null;
  // A spot's info box, opened from elsewhere (anitabi-list.ts)
  spotContent(work: AnitabiWork, point: AnitabiPoint): HTMLElement;
};

async function fetchFile(file: string, key: string) {
  const response = await fetch(`${ANITABI_API}/${file}?d=${encodeURIComponent(key)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${file}`);
  return response;
}

const count = (n: number) => n.toLocaleString('en-US');

function progressText(works: AnitabiWork[], progress: LoadProgress) {
  const spots = works.reduce((sum, work) => sum + work.points.length, 0);
  if (progress.fromCache) return `${count(spots)} spots (saved copy), checking for updates…`;
  if (progress.done < progress.total) return `${count(spots)} spots; details ${progress.done} of ${progress.total}…`;
  return `${count(spots)} spots`;
}

export function installAnitabi(
  map: AnitabiMap,
  options: { cache?: AnitabiCache; fetchFile?: typeof fetchFile } = {},
): AnitabiController {
  const getFile = options.fetchFile ?? fetchFile;
  const listeners: Array<(status: AnitabiStatus) => void> = [];
  let status: AnitabiStatus = { state: 'off', text: '' };
  let loading: Promise<void> | null = null;
  let works = new Map<number, AnitabiWork>();
  let users = new Map<number, string>();
  let enabled = false;
  let selectedWork: number | null = null;
  const changeListeners: Array<(change: AnitabiChange) => void> = [];
  const changed = (change: AnitabiChange = {}) => {
    for (const listener of changeListeners) listener(change);
  };

  const report = (next: AnitabiStatus) => {
    status = next;
    for (const listener of listeners) listener(status);
  };

  const selectWork = (id: number | null) => {
    if (id === selectedWork) return;
    selectedWork = id;
    setGlobalStatePropertyWhenReady(map, ANITABI_WORK_STATE, id ?? 0);
    changed();
  };

  const show = (list: AnitabiWork[]) => {
    works = new Map(list.map((work) => [work.id, work]));
    changed();
    const data = anitabiFeatures(list);
    runWhenStyleInfrastructureReady(map, () => {
      (map.getSource(ANITABI_SOURCE) as GeoJsonSourceLike | undefined)?.setData(data);
    });
  };

  const load = async () => {
    report({ state: 'loading', text: 'Loading spots…' });
    getFile('users.csv', anitabiKey())
      .then((response) => response.text())
      .then((text) => (users = parseUsers(text)))
      .catch(() => {});
    let shown = false;
    try {
      const data = await loadAnitabi({
        fetchJson: async (file, key) => (await getFile(file, key)).json(),
        cache: options.cache ?? indexedDbCache(),
        onData: (list, progress) => {
          shown = true;
          show(list);
          report({ state: 'loading', text: progressText(list, progress) });
        },
      });
      show(data.works);
      const spots = data.works.reduce((sum, work) => sum + work.points.length, 0);
      report({ state: 'ready', text: `${count(spots)} spots of ${count(data.works.length)} works` });
    } catch (error) {
      console.warn('anitabi spots failed to load:', error);
      const reason = error instanceof Error ? error.message : String(error);
      report({
        state: 'failed',
        text: `${shown ? 'Some details are missing' : 'Could not load spots'} (${reason}); switch off and on to retry`,
      });
      loading = null;
    }
  };

  return {
    setEnabled(next, { byUser = false } = {}) {
      if (next && !loading) loading = load();
      if (next === enabled) return;
      enabled = next;
      if (!enabled) selectWork(null);
      changed({ switchedOn: enabled && byUser });
    },
    get enabled() {
      return enabled;
    },
    get status() {
      return status;
    },
    onStatus(listener) {
      listeners.push(listener);
      listener(status);
    },
    onChange(listener) {
      changeListeners.push(listener);
    },
    work: (id) => works.get(id),
    selectWork,
    get selectedWork() {
      return selectedWork;
    },
    matches(feature) {
      return feature.source === ANITABI_SOURCE;
    },
    content(feature) {
      const aid = Number(feature.properties?.aid);
      const pid = String(feature.properties?.pid ?? '');
      const work = works.get(aid);
      const point = work?.points.find((p) => p.id === pid);
      return work && point ? anitabiPopupContent(work, point, users) : null;
    },
    spotContent: (work, point) => anitabiPopupContent(work, point, users),
  };
}
