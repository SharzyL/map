// The works whose anitabi spots are on screen (experimental, with the anitabi
// layer, anitabi-layer.ts): a panel that opens when the spots are switched on,
// and from a button in the control column while they show, listing the works
// the map drew, the most spots in view first. The list is the spots layer's
// rendered features, counted again once the map stops moving and as its tiles
// come in, at most every REFRESH_MS. Like the timetable, it stays
// open beside the map while one clicks around it, until closed.
//
// A work opens in the same panel, from its row or from the name in one of its
// spots' info boxes: its cover, titles and links, and every one
// of its spots, on screen or not, by episode and time in it, each with its
// screenshot; a spot flies the map there and opens its info box. Meanwhile
// only that work's spots show, all of them, and the map fits them (less the
// far-flung few, as anitabi frames a work). Back shows every work again.
import ClapperboardIcon from 'lucide/dist/esm/icons/clapperboard.mjs';
import { anitabiImageUrl, anitabiMapUrl, bangumiUrl, type AnitabiPoint, type AnitabiWork } from './anitabi.js';
import { ANITABI_LAYER, formatEpisode, formatSceneTime, loadImage, type AnitabiController } from './anitabi-layer.js';
import { createPanelButton, createPanelShell, el } from './map-panel.js';
import { emitUiPanelOpen, isOtherUiPanelOpen, UI_PANEL_OPEN_EVENT, type OutsideClickMap } from './ui-panels.js';

// More rows than anyone reads, and each a cover to load
const MAX_ROWS = 100;
const REFRESH_MS = 300;
const MAX_KEPT_ROWS = 300;
const DEFAULT_COLOR = '#11b4da';

type RenderedSpot = { properties?: Record<string, unknown> | null };

export type WorkInView = { work: AnitabiWork; spots: number };

// The works of the rendered spots, by how many of their spots show (a spot
// near a tile's edge comes once per tile), then by anitabi's rank.
export function worksInView(features: RenderedSpot[], workOf: (id: number) => AnitabiWork | undefined): WorkInView[] {
  const spots = new Map<number, Set<string>>();
  for (const feature of features) {
    const aid = Number(feature.properties?.aid);
    const pid = String(feature.properties?.pid ?? '');
    if (!Number.isFinite(aid) || !pid) continue;
    let set = spots.get(aid);
    if (!set) spots.set(aid, (set = new Set()));
    set.add(pid);
  }
  const list: WorkInView[] = [];
  for (const [aid, pids] of spots) {
    const work = workOf(aid);
    if (work) list.push({ work, spots: pids.size });
  }
  return list.sort((a, b) => b.spots - a.spots || b.work.priority - a.work.priority);
}

// Dark text on a light work color, white on the rest (relative luminance of
// a #rgb or #rrggbb color; anything else counts as dark)
export function inkOn(color: string) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return '#fff';
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0f172a' : '#fff';
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function workTitle(work: AnitabiWork) {
  return work.cn || work.title || `Work ${work.id}`;
}

// Great-circle distance in km between two [lat, lng]
function distanceKm(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A work's spots without the far-flung few, as anitabi frames a work: a spot
// stays when its mean distance to the others is within 0.8 of halfway between
// the mean and the largest such distance, unless fewer than three would.
export function mainSpots(points: Array<[number, number]>, factor = 0.8): Array<[number, number]> {
  if (points.length < 4) return points;
  const mean = points.map((a, i) => {
    let sum = 0;
    for (let j = 0; j < points.length; j++) if (j !== i) sum += distanceKm(a, points[j]);
    return sum / (points.length - 1);
  });
  const largest = Math.max(...mean);
  const average = mean.reduce((sum, d) => sum + d, 0) / mean.length;
  const limit = ((largest + average) / 2) * factor;
  const kept = points.filter((_, i) => mean[i] <= limit);
  return kept.length < 3 ? points : kept;
}

// [[west, south], [east, north]] of a work's main spots
export function workBounds(work: AnitabiWork): [[number, number], [number, number]] | null {
  if (work.points.length === 0) return null;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lat, lng] of mainSpots(work.points.map((point) => point.geo))) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}

export type EpisodeGroup = { title: string; points: AnitabiPoint[] };

// A work's spots by episode: numbered episodes in order, then named ones (a
// game's scenes, an OP) in the order they first come, then the rest; within
// one, by time in the episode, those without a time last, else as anitabi
// lists them.
export function spotsByEpisode(points: AnitabiPoint[]): EpisodeGroup[] {
  const groups = new Map<string, { key: number | string; title: string; points: AnitabiPoint[] }>();
  for (const point of points) {
    const id = point.ep === undefined || point.ep === '' ? '' : String(point.ep);
    let group = groups.get(id);
    if (!group) {
      const key = id === '' ? Infinity : typeof point.ep === 'number' ? point.ep : id;
      groups.set(id, (group = { key, title: id === '' ? 'Other spots' : formatEpisode(point.ep), points: [] }));
    }
    group.points.push(point);
  }
  const rank = (key: number | string) => (typeof key === 'number' ? (key === Infinity ? 2 : 0) : 1);
  return [...groups.values()]
    .sort(
      (a, b) =>
        rank(a.key) - rank(b.key) || (typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : 0),
    )
    .map(({ title, points: list }) => ({
      title,
      points: list
        .map((point, i) => ({ point, i }))
        .sort((a, b) => (a.point.s ?? Infinity) - (b.point.s ?? Infinity) || a.i - b.i)
        .map(({ point }) => point),
    }));
}

type ListControl = { onAdd(map: AnitabiListMap): HTMLElement; onRemove(): void };
type Padding = { top: number; right: number; bottom: number; left: number };
export type AnitabiListMap = OutsideClickMap & {
  addControl(control: ListControl, position?: string): void;
  getContainer(): HTMLElement;
  getZoom(): number;
  on(type: 'render' | 'moveend', listener: () => void): void;
  off(type: 'render' | 'moveend', listener: () => void): void;
  isMoving(): boolean;
  queryRenderedFeatures(options: { layers: string[] }): RenderedSpot[];
  fitBounds(bounds: [[number, number], [number, number]], options: { padding: Padding; maxZoom: number }): void;
  flyTo(options: { center: [number, number]; zoom: number; padding: Padding }): void;
};

export type OpenInfoBox = (lngLat: [number, number], content: HTMLElement) => void;

// A cover or screenshot frame, in the work's color where there is none
function image(parent: Element, className: string, src: string | undefined) {
  const frame = el('span', className, parent);
  if (src) loadImage(frame, src);
  return frame;
}

function link(parent: Element, text: string, href: string) {
  const a = el('a', undefined, parent);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  return a;
}

class AnitabiListPanel {
  _anitabi: AnitabiController;
  _map: AnitabiListMap;
  _control: HTMLElement;
  _button: HTMLButtonElement;
  _panel: HTMLElement;
  _summary: HTMLElement;
  _body: HTMLElement;
  _expanded = false;
  _list: WorkInView[] = [];
  // The work open in the panel, if one is
  _work: AnitabiWork | null = null;
  // What the body shows now (_render), and the list's rows by work
  _shown = '';
  _rows = new Map<number, { item: HTMLLIElement; button: HTMLButtonElement; count: HTMLElement }>();
  _items = el('ul', 'anitabi-list-items');
  _nav: HTMLElement;
  _more = el('p', 'anitabi-list-empty');
  _openInfoBox: OpenInfoBox | null = null;
  _timer = 0;
  // Not while the map moves: nobody reads the list mid-drag, and a recount
  // then costs every frame. Once it stops, and as its tiles come in.
  _boundRender = () => {
    if (!this._expanded || this._timer || this._map.isMoving()) return;
    this._timer = window.setTimeout(() => {
      this._timer = 0;
      this._refresh();
    }, REFRESH_MS);
  };
  _boundEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this._expanded) this.setExpanded(false);
  };
  _boundAnyPanelOpen = (event: Event) => {
    if (isOtherUiPanelOpen(event, 'anitabi-list')) this.setExpanded(false);
  };

  constructor(anitabi: AnitabiController) {
    this._anitabi = anitabi;
  }

  onAdd(map: AnitabiListMap) {
    this._map = map;
    ({ control: this._control, button: this._button } = createPanelButton(
      'maplibregl-ctrl-anitabi-list',
      'Anime in view',
      ClapperboardIcon,
      'anitabi-list-icon',
    ));
    this._button.addEventListener('click', () => this.setExpanded(!this._expanded));

    const shell = createPanelShell(map.getContainer(), 'anitabi-list', {
      title: 'Anime in view',
      label: 'Anime in view',
      closeLabel: 'Close anime list',
      onClose: () => this.setExpanded(false),
    });
    this._panel = shell.panel;
    this._summary = shell.summary;
    this._body = shell.body;
    // The way back stays in a row of its own over the scrolling spots, as
    // in the timetable.
    this._nav = el('div', 'anitabi-list-nav');
    this._nav.hidden = true;
    const back = el('button', 'anitabi-list-back', this._nav);
    back.type = 'button';
    back.textContent = '\u2039 All anime in view';
    back.addEventListener('click', () => this._back());
    this._panel.insertBefore(this._nav, this._body);
    map.getContainer().addEventListener(UI_PANEL_OPEN_EVENT, this._boundAnyPanelOpen);
    window.addEventListener('keydown', this._boundEscape);
    map.on('render', this._boundRender);
    map.on('moveend', this._boundRender);
    this._anitabi.onChange(({ switchedOn }) => {
      if (!this._anitabi.enabled) this.setExpanded(false);
      // Another way of clearing the selection leaves the work too.
      if (this._anitabi.selectedWork === null) this._work = null;
      this._sync();
      if (switchedOn) this.setExpanded(true);
      else this._refresh();
    });
    // A work chosen from a spot's info box opens here, as from the list.
    this._anitabi.setWorkOpener((work) => {
      this.setExpanded(true);
      this._openWork(work);
    });
    this._anitabi.onStatus(() => {
      if (this._expanded && !this._work && this._list.length === 0) this._render();
    });
    this._sync();
    return this._control;
  }

  onRemove() {
    this._map.getContainer().removeEventListener(UI_PANEL_OPEN_EVENT, this._boundAnyPanelOpen);
    window.removeEventListener('keydown', this._boundEscape);
    this._map.off('render', this._boundRender);
    this._map.off('moveend', this._boundRender);
    window.clearTimeout(this._timer);
    this._panel?.remove();
    this._control?.remove();
  }

  setInfoBox(open: OpenInfoBox) {
    this._openInfoBox = open;
  }

  setExpanded(expanded: boolean) {
    if (this._expanded === expanded) return;
    this._expanded = expanded;
    if (expanded) {
      emitUiPanelOpen(this._map.getContainer(), 'anitabi-list');
      this._refresh();
    }
    this._sync();
  }

  // Counts the works on screen again, unless one is open: then only its
  // spots show, and the list waits for Back. Runs while the map renders, so
  // what it draws must cost nothing when nothing changed (_render).
  _refresh() {
    if (!this._expanded) return;
    if (this._anitabi.enabled && !this._work) {
      const features = this._map.queryRenderedFeatures({ layers: [ANITABI_LAYER] });
      this._list = worksInView(features, (id) => this._anitabi.work(id));
    }
    this._render();
  }

  // The map's room beside the panel: above it on phones, right of it otherwise
  _padding(): Padding {
    const sheet = window.matchMedia?.('(max-width: 640px)').matches;
    const container = this._map.getContainer();
    if (sheet) return { top: 60, right: 40, bottom: Math.round(container.clientHeight / 2) + 24, left: 40 };
    const width = this._panel.getBoundingClientRect().width || 340;
    return { top: 60, right: 60, bottom: 60, left: Math.round(width) + 30 };
  }

  _openWork(work: AnitabiWork) {
    this._work = work;
    this._anitabi.selectWork(work.id);
    const bounds = workBounds(work);
    if (bounds) this._map.fitBounds(bounds, { padding: this._padding(), maxZoom: 15 });
    this._render();
    this._body.scrollTop = 0;
  }

  _back() {
    this._work = null;
    this._anitabi.selectWork(null);
    this._refresh();
    this._body.scrollTop = 0;
  }

  _openSpot(work: AnitabiWork, point: AnitabiPoint) {
    const lngLat: [number, number] = [point.geo[1], point.geo[0]];
    this._map.flyTo({ center: lngLat, zoom: Math.max(this._map.getZoom(), 16), padding: this._padding() });
    this._openInfoBox?.(lngLat, this._anitabi.spotContent(work, point));
  }

  // What the body shows: a work's view is built once when it opens, as the
  // map moving does not change it; the list keeps its rows (and their loaded
  // covers) by work, and a recount only updates counts and order, or does
  // nothing when they are the same.
  _render() {
    this._nav.hidden = !this._work;
    if (this._work) {
      const key = `work:${this._work.id}`;
      if (this._shown === key) return;
      this._shown = key;
      this._body.replaceChildren();
      this._renderWork(this._work);
      return;
    }
    this._renderList();
  }

  _renderList() {
    const total = this._list.reduce((sum, { spots }) => sum + spots, 0);
    const status = this._anitabi.status;
    const summary = this._list.length
      ? `${plural(this._list.length, 'work')} · ${plural(total, 'spot')} in view`
      : status.state === 'loading' || status.state === 'failed'
        ? status.text
        : 'No spots in view';
    if (this._summary.textContent !== summary) this._summary.textContent = summary;

    const shown = this._list.slice(0, MAX_ROWS);
    const key = `list:${status.state}:${this._list.length}:${shown.map(({ work, spots }) => `${work.id}=${spots}`).join(',')}`;
    if (this._shown === key) return;
    this._shown = key;

    if (this._list.length === 0) {
      const empty = el('p', 'anitabi-list-empty');
      empty.textContent =
        status.state === 'loading'
          ? 'The spots are loading; they list here as they show.'
          : 'Move the map to where spots show; zoom in for more of them.';
      this._body.replaceChildren(empty);
      return;
    }
    const items: HTMLLIElement[] = [];
    const keep = new Set<number>();
    for (const { work, spots } of shown) {
      const row = this._rows.get(work.id) ?? this._listRow(work);
      if (row.count.textContent !== `${spots}`) {
        row.count.textContent = `${spots}`;
        row.button.title = `${workTitle(work)}: ${spots} of its ${work.points.length} spots in view`;
      }
      items.push(row.item);
      keep.add(work.id);
    }
    // Rows that leave the list wait for their work to come back into view,
    // cover and all, up to MAX_KEPT_ROWS
    if (this._rows.size > MAX_KEPT_ROWS) {
      for (const id of this._rows.keys()) if (!keep.has(id)) this._rows.delete(id);
    }
    if (this._items.parentNode !== this._body || this._body.firstChild !== this._items) {
      this._body.replaceChildren(this._items);
    }
    // Only the rows out of place move, and a row that moves keeps its image.
    items.forEach((item, index) => {
      if (this._items.children[index] !== item) this._items.insertBefore(item, this._items.children[index] ?? null);
    });
    while (this._items.children.length > items.length) this._items.lastElementChild.remove();
    this._more.remove();
    if (this._list.length > MAX_ROWS) {
      this._more.textContent = `${this._list.length - MAX_ROWS} more; zoom in to narrow the list.`;
      this._body.appendChild(this._more);
    }
  }

  _listRow(work: AnitabiWork) {
    const item = el('li');
    const button = el('button', 'anitabi-list-item', item);
    button.type = 'button';
    button.style.setProperty('--anitabi-work-color', work.color || DEFAULT_COLOR);
    button.style.setProperty('--anitabi-work-ink', inkOn(work.color || DEFAULT_COLOR));
    button.addEventListener('click', () => this._openWork(work));
    image(button, 'anitabi-list-cover', anitabiImageUrl(work.cover, 'h160'));
    const text = el('span', 'anitabi-list-text', button);
    el('span', 'anitabi-list-name', text).textContent = workTitle(work);
    const original = work.title && work.title !== workTitle(work) ? work.title : undefined;
    const meta = [original, work.cat, work.city].filter(Boolean).join(' · ');
    if (meta) el('span', 'anitabi-list-meta', text).textContent = meta;
    const count = el('span', 'anitabi-list-count', button);
    const row = { item, button, count };
    this._rows.set(work.id, row);
    return row;
  }

  _renderWork(work: AnitabiWork) {
    const color = work.color || DEFAULT_COLOR;
    this._summary.textContent = `${workTitle(work)} · ${plural(work.points.length, 'spot')}`;
    const head = el('div', 'anitabi-work', this._body);
    head.style.setProperty('--anitabi-work-color', color);
    image(head, 'anitabi-work-cover', anitabiImageUrl(work.cover, 'h160'));
    const text = el('div', 'anitabi-work-text', head);
    el('h3', 'anitabi-work-title', text).textContent = workTitle(work);
    const original = work.title && work.title !== workTitle(work) ? work.title : undefined;
    if (original) el('div', 'anitabi-work-original', text).textContent = original;
    const meta = [work.cat, work.city, plural(work.points.length, 'spot')].filter(Boolean).join(' · ');
    el('div', 'anitabi-work-meta', text).textContent = meta;
    const links = el('div', 'anitabi-work-links', text);
    link(links, 'Bangumi', bangumiUrl(work.id));
    link(links, 'anitabi', anitabiMapUrl(work.id));

    for (const group of spotsByEpisode(work.points)) {
      const section = el('section', 'anitabi-spot-group', this._body);
      const title = el('h4', 'anitabi-spot-group-title', section);
      title.textContent = `${group.title} · ${group.points.length}`;
      const list = el('ul', 'anitabi-spots', section);
      for (const point of group.points) {
        const row = el('button', 'anitabi-spot', el('li', undefined, list));
        row.type = 'button';
        row.style.setProperty('--anitabi-work-color', color);
        row.addEventListener('click', () => this._openSpot(work, point));
        image(row, 'anitabi-spot-image', anitabiImageUrl(point.image, 'h160'));
        const body = el('span', 'anitabi-spot-text', row);
        const [name, other] = [point.cn || point.name, point.cn && point.name !== point.cn ? point.name : undefined];
        el('span', 'anitabi-spot-name', body).textContent = name || 'Spot without a name';
        const details = [formatSceneTime(point.s), other, point.folder].filter(Boolean).join(' · ');
        if (details) el('span', 'anitabi-spot-meta', body).textContent = details;
        if (point.mark) el('span', 'anitabi-spot-note', body).textContent = point.mark;
        row.title = [name, point.mark].filter(Boolean).join(' — ');
      }
    }
  }

  _sync() {
    this._control.style.display = this._anitabi.enabled ? '' : 'none';
    this._button.classList.toggle('maplibregl-ctrl-anitabi-list-enabled', this._expanded);
    this._button.setAttribute('aria-pressed', this._expanded ? 'true' : 'false');
    this._button.classList.toggle('maplibregl-ctrl-anitabi-list-filtered', this._anitabi.selectedWork !== null);
    this._panel.classList.toggle('anitabi-list-panel-visible', this._expanded);
    this._panel.setAttribute('aria-hidden', this._expanded ? 'false' : 'true');
    this._panel.inert = !this._expanded;
  }
}

export function installAnitabiList(map: AnitabiListMap, anitabi: AnitabiController) {
  const panel = new AnitabiListPanel(anitabi);
  map.addControl(panel, 'top-right');
  return { setInfoBox: (open: OpenInfoBox) => panel.setInfoBox(open) };
}
