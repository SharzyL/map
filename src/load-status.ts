// Shows whether the railway and base map tiles in view are still loading, so
// an empty area reads as "no railway here" only once its tiles are in. A chip
// at the top centre says "Loading railways… 12 tiles left" or "Loading map…"
// while a group's sources have tiles pending, after a short delay so panning
// over cached tiles doesn't flash it, and says so when tiles in view failed to
// load, with a Retry button: MapLibre does not refetch a failed tile on its
// own, and resetting a source's tile URLs makes it fetch every tile again.
//
// The counts come from each source's tile manager (map.style.tileManagers),
// which MapLibre types but does not document: the tiles it holds for the view
// and their states. Should that stop working, the chip logs an error and falls
// back to MapLibre's public API: whether a source is loaded (isSourceLoaded),
// and failed tiles remembered from its error events until they load after all
// or Retry, which cannot tell when a failed tile leaves the view.
//
// Other things the map waits for say so in the same chip (beginLoading): a
// highlighted route's details and outline, a train's track. "Loading route…",
// or "Loading route and railways… 12 tiles left" with tiles still coming.
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
type TileManagerLike = { getIds(): string[]; getTileByID(id: string): { state?: string } | undefined };
export type LoadStatusMap = {
  getContainer(): HTMLElement;
  getSource(id: string): unknown;
  isSourceLoaded(id: string): boolean;
  on(type: string, listener: (event: TileEvent) => void): unknown;
  style?: unknown;
};

const SHOW_DELAY_MS = 400;

// Dispatched on the map's container by beginLoading.
export const LOAD_TASK_EVENT = 'orm:loadtask';
// `label` names what loads ("route"), null once it is done; `token` tells one
// load of an `id` from the next, so an older one ending clears nothing.
export type LoadTaskDetail = { id: string; token: number; label: string | null };

let nextToken = 0;

// Says in the load status chip that `label` is loading, until the function it
// returns is called. A newer load of the same `id` takes its place.
export function beginLoading(target: EventTarget, id: string, label: string) {
  const token = ++nextToken;
  const send = (detail: LoadTaskDetail) =>
    target.dispatchEvent(new CustomEvent<LoadTaskDetail>(LOAD_TASK_EVENT, { detail }));
  send({ id, token, label });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    send({ id, token, label: null });
  };
}

// "a", "a and b", "a, b and c"
function listed(items: string[]) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
// Tile states (MapLibre's TileState) still waiting for data.
const PENDING_STATES = new Set(['loading', 'reloading', 'expired']);
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

// A group's state: whether it is loading, how many tiles are left (null when
// unknown), and how many failed.
export type GroupStatus = { loading: boolean; pending: number | null; failed: number };

const tiles = (count: number) => `${count} ${count === 1 ? 'tile' : 'tiles'}`;

// The chip's text, or null to hide it: the tasks loading (beginLoading) with
// the tiles, and whether anything is still loading (its spinner). Failures
// come first, since they need Retry, followed by what is still loading.
export function loadStatusText(
  status: Record<LoadGroup, GroupStatus>,
  tasks: string[] = [],
): { text: string; failed: boolean; loading: boolean } | null {
  const { railways, map } = status;
  const what = listed([...new Set(tasks), ...(map.loading ? ['map'] : []), ...(railways.loading ? ['railways'] : [])]);
  const pending = [railways, map].reduce((sum, group) => sum + (group.loading ? (group.pending ?? 0) : 0), 0);
  if (railways.failed || map.failed) {
    const failedWhat = railways.failed && map.failed ? 'map and railway' : railways.failed ? 'railway' : 'map';
    const count = railways.failed + map.failed;
    const still = !what ? '' : pending ? ` · ${tiles(pending)} still loading` : ' · still loading';
    return {
      text: `${count} ${failedWhat} ${count === 1 ? 'tile' : 'tiles'} failed to load${still}`,
      failed: true,
      loading: !!what,
    };
  }
  if (!what) return null;
  return { text: `Loading ${what}…${pending ? ` ${tiles(pending)} left` : ''}`, failed: false, loading: true };
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
  // For the fallback: failed tiles by source, as tile keys from error events.
  const failedTiles = new Map<string, Set<unknown>>();
  let tileManagersBroken = false;

  // What else is loading (beginLoading), by id
  const tasks = new Map<string, { token: number; label: string }>();
  map.getContainer().addEventListener(LOAD_TASK_EVENT, (event) => {
    const { id, token, label } = (event as CustomEvent<LoadTaskDetail>).detail ?? {};
    if (!id) return;
    if (label) tasks.set(id, { token, label });
    else if (tasks.get(id)?.token === token) tasks.delete(id);
    schedule();
  });

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

  // Pending and failed tiles in view, from the source's tile manager; null
  // once that has failed, after logging why.
  const tileCounts = (id: string) => {
    if (tileManagersBroken) return null;
    try {
      const managers = (map.style as { tileManagers?: Record<string, TileManagerLike> } | undefined)?.tileManagers;
      const manager = managers?.[id];
      if (typeof manager?.getIds !== 'function' || typeof manager.getTileByID !== 'function') {
        throw new Error(`no tile manager with getIds() and getTileByID() for source "${id}"`);
      }
      let pending = 0;
      let failed = 0;
      for (const tileId of manager.getIds()) {
        const state = manager.getTileByID(tileId)?.state;
        if (PENDING_STATES.has(state)) pending++;
        else if (state === 'errored') failed++;
      }
      return { pending, failed };
    } catch (error) {
      tileManagersBroken = true;
      console.error(
        'Load status: cannot read MapLibre tile managers (map.style.tileManagers), so the tile loading chip ' +
          'shows no tile counts and remembers failed tiles from error events instead.',
        error,
      );
      return null;
    }
  };

  const sourceStatus = (id: string): GroupStatus => {
    // Not there yet: the style is still loading.
    if (!map.getSource(id)) return { loading: true, pending: null, failed: 0 };
    const loaded = map.isSourceLoaded(id);
    const counts = tileCounts(id);
    if (counts) return { loading: !loaded || counts.pending > 0, pending: counts.pending, failed: counts.failed };
    return { loading: !loaded, pending: null, failed: failedTiles.get(id)?.size ?? 0 };
  };

  let statuses = new Map<string, GroupStatus>();
  const groupStatus = (group: LoadGroup): GroupStatus => {
    const parts = groups[group].map((id) => statuses.get(id));
    return {
      loading: parts.some((part) => part.loading),
      pending: parts.some((part) => part.pending === null) ? null : parts.reduce((sum, part) => sum + part.pending, 0),
      failed: parts.reduce((sum, part) => sum + part.failed, 0),
    };
  };

  let loadingSince: number | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    frame = 0;
    statuses = new Map([...groupOf.keys()].map((id) => [id, sourceStatus(id)]));
    const status = { railways: groupStatus('railways'), map: groupStatus('map') };
    const loading = status.railways.loading || status.map.loading || tasks.size > 0;
    loadingSince = loading ? (loadingSince ?? Date.now()) : null;
    const shown = loadStatusText(
      status,
      [...tasks.values()].map(({ label }) => label),
    );
    // Loading shows once it has lasted a moment; check again then.
    const waiting = shown && !shown.failed && Date.now() - loadingSince < SHOW_DELAY_MS;
    clearTimeout(timer);
    if (waiting) timer = setTimeout(schedule, SHOW_DELAY_MS - (Date.now() - loadingSince));
    chip.hidden = !shown || waiting;
    if (chip.hidden) return;
    chip.classList.toggle('load-status-failed', shown.failed);
    label.textContent = shown.text;
    spinner.hidden = !shown.loading;
    retry.hidden = !shown.failed;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  map.on('error', (event) => {
    if (!event.sourceId || !groupOf.has(event.sourceId) || !event.tile || isAbort(event.error)) return;
    const keys = failedTiles.get(event.sourceId) ?? new Set();
    keys.add(event.tile.tileID?.key);
    failedTiles.set(event.sourceId, keys);
    schedule();
  });
  map.on('sourcedata', (event) => {
    if (event.sourceId && event.tile) failedTiles.get(event.sourceId)?.delete(event.tile.tileID?.key);
    schedule();
  });
  for (const type of ['sourcedataloading', 'dataloading', 'data', 'idle', 'movestart']) map.on(type, schedule);

  retry.addEventListener('click', () => {
    for (const [id, status] of statuses) {
      if (!status.failed) continue;
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
