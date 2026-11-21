// The works whose anitabi spots are on screen (experimental, with the anitabi
// layer, anitabi-layer.ts): a button in the control column while the layer is
// on opens a panel listing them, the most spots in view first. A work's row
// shows only its spots, all of them, and fits the map to the main ones; again, and
// every work's show. The list is what the map drew: the spots' layer's
// rendered features, counted again while the map renders, at most every
// REFRESH_MS, and once more after its last frame.
import ClapperboardIcon from 'lucide/dist/esm/icons/clapperboard.mjs';
import { anitabiImageUrl, type AnitabiWork } from './anitabi.js';
import { ANITABI_LAYER, type AnitabiController } from './anitabi-layer.js';
import { createPanelButton, createPanelShell, el } from './map-panel.js';
import {
  emitUiPanelOpen,
  isOtherUiPanelOpen,
  onOutsideClick,
  UI_PANEL_OPEN_EVENT,
  type OutsideClickMap,
} from './ui-panels.js';

// More rows than anyone reads, and each a cover to load
const MAX_ROWS = 100;
const REFRESH_MS = 300;
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

type ListControl = { onAdd(map: AnitabiListMap): HTMLElement; onRemove(): void };
export type AnitabiListMap = OutsideClickMap & {
  addControl(control: ListControl, position?: string): void;
  getContainer(): HTMLElement;
  on(type: 'render', listener: () => void): void;
  off(type: 'render', listener: () => void): void;
  queryRenderedFeatures(options: { layers: string[] }): RenderedSpot[];
  fitBounds(bounds: [[number, number], [number, number]], options: Record<string, unknown>): void;
};

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
  _timer = 0;
  _boundRender = () => {
    if (!this._expanded || this._timer) return;
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
  _removeOutsideClick: () => void;

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
    this._removeOutsideClick = onOutsideClick(
      map,
      () => [this._panel, this._control],
      () => this.setExpanded(false),
    );
    map.getContainer().addEventListener(UI_PANEL_OPEN_EVENT, this._boundAnyPanelOpen);
    window.addEventListener('keydown', this._boundEscape);
    map.on('render', this._boundRender);
    this._anitabi.onChange(() => {
      if (!this._anitabi.enabled) this.setExpanded(false);
      this._sync();
      this._refresh();
    });
    this._sync();
    return this._control;
  }

  onRemove() {
    this._removeOutsideClick?.();
    this._map.getContainer().removeEventListener(UI_PANEL_OPEN_EVENT, this._boundAnyPanelOpen);
    window.removeEventListener('keydown', this._boundEscape);
    this._map.off('render', this._boundRender);
    window.clearTimeout(this._timer);
    this._panel?.remove();
    this._control?.remove();
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

  // Counts the works on screen again, unless one is selected: then only its
  // spots show, and the list stays as it was so another can be picked.
  _refresh() {
    if (!this._expanded || !this._anitabi.enabled || this._anitabi.selectedWork !== null) {
      this._render();
      return;
    }
    const features = this._map.queryRenderedFeatures({ layers: [ANITABI_LAYER] });
    this._list = worksInView(features, (id) => this._anitabi.work(id));
    this._render();
  }

  _select(work: AnitabiWork) {
    if (this._anitabi.selectedWork === work.id) {
      this._anitabi.selectWork(null);
      return;
    }
    this._anitabi.selectWork(work.id);
    const bounds = workBounds(work);
    if (!bounds) return;
    // On phones the panel is a sheet over the map's lower half.
    const sheet = window.matchMedia?.('(max-width: 640px)').matches;
    const bottom = sheet ? Math.round(this._map.getContainer().clientHeight / 2) + 24 : 60;
    this._map.fitBounds(bounds, { padding: { top: 60, right: 60, bottom, left: 60 }, maxZoom: 15 });
  }

  _render() {
    const selected = this._anitabi.selectedWork;
    const total = this._list.reduce((sum, { spots }) => sum + spots, 0);
    const selectedWork = selected === null ? undefined : this._anitabi.work(selected);
    this._summary.textContent = selectedWork
      ? `Only ${workTitle(selectedWork)}`
      : this._list.length
        ? `${plural(this._list.length, 'work')} · ${plural(total, 'spot')} in view`
        : 'No spots in view';

    this._body.replaceChildren();
    if (selectedWork) {
      const showAll = el('button', 'anitabi-list-show-all', this._body);
      showAll.type = 'button';
      showAll.textContent = 'Show every work';
      showAll.addEventListener('click', () => this._anitabi.selectWork(null));
    }
    if (this._list.length === 0) {
      el('p', 'anitabi-list-empty', this._body).textContent =
        'Move the map to where spots show; zoom in for more of them.';
      return;
    }
    const list = el('ul', 'anitabi-list-items', this._body);
    for (const { work, spots } of this._list.slice(0, MAX_ROWS)) {
      const item = el('li', undefined, list);
      const row = el('button', 'anitabi-list-item', item);
      row.type = 'button';
      row.setAttribute('aria-pressed', selected === work.id ? 'true' : 'false');
      row.style.setProperty('--anitabi-work-color', work.color || DEFAULT_COLOR);
      row.style.setProperty('--anitabi-work-ink', inkOn(work.color || DEFAULT_COLOR));
      row.addEventListener('click', () => this._select(work));

      const cover = el('span', 'anitabi-list-cover', row);
      const src = anitabiImageUrl(work.cover, 'h160');
      if (src) {
        const img = el('img', undefined, cover);
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.remove());
      }

      const text = el('span', 'anitabi-list-text', row);
      el('span', 'anitabi-list-name', text).textContent = workTitle(work);
      const original = work.title && work.title !== workTitle(work) ? work.title : undefined;
      const meta = [original, work.cat, work.city].filter(Boolean).join(' · ');
      if (meta) el('span', 'anitabi-list-meta', text).textContent = meta;

      el('span', 'anitabi-list-count', row).textContent = `${spots}`;
      row.title = `${workTitle(work)}: ${spots} of its ${work.points.length} spots in view`;
    }
    if (this._list.length > MAX_ROWS) {
      el('p', 'anitabi-list-empty', this._body).textContent =
        `${this._list.length - MAX_ROWS} more; zoom in to narrow the list.`;
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
  map.addControl(new AnitabiListPanel(anitabi), 'top-right');
}
