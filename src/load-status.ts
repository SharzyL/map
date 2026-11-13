// Shows whether the railway and base map tiles in view are still loading, so
// an empty area reads as "no railway here" only once its tiles are in. A chip
// at the top centre says "Loading railways…" or "Loading map…" while a group's
// sources have tiles pending (MapLibre's isSourceLoaded), after a short delay
// so panning over cached tiles doesn't flash it, and says so when tiles failed
// to load, with a Retry button: MapLibre does not refetch a failed tile on its
// own, and resetting a source's tile URLs makes it fetch every tile again.
// Failed tiles count until they load after all (a later zoom or pan), or until
// Retry; requests cancelled because the view moved on are not failures.
import { el } from './map-panel.js';

export type LoadGroup = 'railways' | 'map';
type SourceLike = { type?: unknown };
type ReloadableSource = {
  tiles?: string[];
  url?: string;
  setTiles?(tiles: string[]): unknown;
  setUrl?(url: string): unknown;
};
type TileEvent = { sourceId?: string; tile?: { tileID?: { key?: unknown } }; error?: unknown };
export type LoadStatusMap = {
  getContainer(): HTMLElement;
  getSource(id: string): unknown;
  isSourceLoaded(id: string): boolean;
  on(type: string, listener: (event: TileEvent) => void): unknown;
};

const SHOW_DELAY_MS = 400;
// Left out: sources whose data is already in the page (annotations, imports,
// overlays), and elevation, whose hillshade and contour lines only decorate
// the map (the contour source, given by the caller, also gives up on tiles
// that take too long to compute).
const IGNORED_SOURCE_TYPES = new Set(['geojson', 'image', 'video', 'canvas', 'raster-dem']);

// The tiled sources of a style, split into railways and the base map (base
// map and imagery).
export function loadGroups(sources: Record<string, SourceLike>, railwaySources: string[], ignored: string[] = []) {
  const railways = new Set(railwaySources);
  const groups: Record<LoadGroup, string[]> = { railways: [], map: [] };
  for (const [id, source] of Object.entries(sources)) {
    if (IGNORED_SOURCE_TYPES.has(String(source.type)) || ignored.includes(id)) continue;
    groups[railways.has(id) ? 'railways' : 'map'].push(id);
  }
  return groups;
}

type Status = { loading: Record<LoadGroup, boolean>; failed: Record<LoadGroup, boolean> };

// The chip's text, or null to hide it. Failures come first: they need Retry.
export function loadStatusText({ loading, failed }: Status): { text: string; failed: boolean } | null {
  if (failed.railways || failed.map) {
    const what = failed.railways && failed.map ? 'map and railway' : failed.railways ? 'railway' : 'map';
    return { text: `Some ${what} tiles failed to load`, failed: true };
  }
  if (loading.railways && loading.map) return { text: 'Loading map and railways…', failed: false };
  if (loading.railways) return { text: 'Loading railways…', failed: false };
  if (loading.map) return { text: 'Loading map…', failed: false };
  return null;
}

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

export function installLoadStatus(
  map: LoadStatusMap,
  sources: Record<string, SourceLike>,
  railwaySources: string[],
  ignored: string[] = [],
) {
  const groups = loadGroups(sources, railwaySources, ignored);
  const groupOf = new Map<string, LoadGroup>();
  for (const group of ['railways', 'map'] as const) for (const id of groups[group]) groupOf.set(id, group);
  // Failed tiles by source: tile keys.
  const failedTiles = new Map<string, Set<unknown>>();

  const chip = el('div', 'load-status', map.getContainer());
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-live', 'polite');
  chip.hidden = true;
  const spinner = el('span', 'load-status-spinner', chip);
  spinner.setAttribute('aria-hidden', 'true');
  const label = el('span', 'load-status-text', chip);
  const retry = el('button', 'load-status-retry', chip);
  retry.type = 'button';
  retry.textContent = 'Retry';

  // A source still pending, or not there yet (the style is still loading).
  const loading = (group: LoadGroup) => groups[group].some((id) => !map.getSource(id) || !map.isSourceLoaded(id));
  const failed = (group: LoadGroup) => groups[group].some((id) => (failedTiles.get(id)?.size ?? 0) > 0);

  let loadingSince: number | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    frame = 0;
    const status: Status = {
      loading: { railways: loading('railways'), map: loading('map') },
      failed: { railways: failed('railways'), map: failed('map') },
    };
    const anyLoading = status.loading.railways || status.loading.map;
    loadingSince = anyLoading ? (loadingSince ?? Date.now()) : null;
    const shown = loadStatusText(status);
    // Loading shows once it has lasted a moment; check again then.
    const waiting = shown && !shown.failed && Date.now() - loadingSince < SHOW_DELAY_MS;
    clearTimeout(timer);
    if (waiting) timer = setTimeout(schedule, SHOW_DELAY_MS - (Date.now() - loadingSince));
    chip.hidden = !shown || waiting;
    if (chip.hidden) return;
    chip.classList.toggle('load-status-failed', shown.failed);
    label.textContent = shown.text;
    spinner.hidden = shown.failed;
    retry.hidden = !shown.failed;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  map.on('error', (event) => {
    const group = event.sourceId && groupOf.get(event.sourceId);
    if (!group || !event.tile || isAbort(event.error)) return;
    const tiles = failedTiles.get(event.sourceId) ?? new Set();
    tiles.add(event.tile.tileID?.key);
    failedTiles.set(event.sourceId, tiles);
    schedule();
  });
  map.on('sourcedata', (event) => {
    if (event.sourceId && event.tile) failedTiles.get(event.sourceId)?.delete(event.tile.tileID?.key);
    schedule();
  });
  for (const type of ['sourcedataloading', 'dataloading', 'data', 'idle', 'movestart']) map.on(type, schedule);

  retry.addEventListener('click', () => {
    for (const id of failedTiles.keys()) {
      const source = map.getSource(id) as ReloadableSource | undefined;
      if (source?.setTiles && source.tiles) source.setTiles([...source.tiles]);
      else if (source?.setUrl && source.url) source.setUrl(source.url);
    }
    failedTiles.clear();
    schedule();
  });

  schedule();
  return chip;
}
