// Timetables for Japanese stations from the norikae API (norikae.ts): a panel
// that lists a station's lines and directions, then one direction's
// departures for a day type, then the stops of one train. Station info boxes
// get a Timetable button (timetableButton) that opens it through
// TIMETABLE_OPEN_EVENT on the map container.
//
// Stations carry their Yahoo station codes as `yahoo_codes` once the export
// has them (scripts/tiles/jp-station-codes.py); others are looked up by name.
// A name Yahoo knows as several stations (府中(東京都), 府中(広島県)) lists
// each station's lines under its Yahoo name.
import { createPanelShell, el } from './map-panel.js';
import {
  departures,
  findStationsByName,
  japanNow,
  minutesOf,
  stationLines,
  trainStops,
  type Departure,
  type DepartureTable,
  type TimetableDay,
} from './norikae.js';
import { emitUiPanelOpen, isOtherUiPanelOpen, UI_PANEL_OPEN_EVENT } from './ui-panels.js';

export const TIMETABLE_OPEN_EVENT = 'orm:timetable';
export type TimetableRequest = { name: string; codes: string[] };

const DAY_LABELS: Record<TimetableDay, string> = {
  weekday: 'Weekday',
  saturday: 'Saturday',
  holiday: 'Sunday & holiday',
};
// Departures before this time belong to the previous service day ("00:30").
const SERVICE_DAY_START = 3 * 60;

type TimetableMap = { getContainer(): HTMLElement };
type View = () => Promise<void>;

function serviceMinutes(time: string) {
  const minutes = minutesOf(time);
  return minutes < SERVICE_DAY_START ? minutes + 24 * 60 : minutes;
}

// The departure to highlight: the next one today, when the table shows today's schedule.
export function nextDepartureIndex(table: Pick<DepartureTable, 'day' | 'departures'>, now = japanNow()) {
  const today = now.weekday === 0 ? 'holiday' : now.weekday === 6 ? 'saturday' : 'weekday';
  if (table.day !== today) return -1;
  const current = now.minutes < SERVICE_DAY_START ? now.minutes + 24 * 60 : now.minutes;
  return table.departures.findIndex((departure) => serviceMinutes(departure.time) >= current);
}

class TimetablePanel {
  readonly panel: HTMLElement;
  private readonly _container: HTMLElement;
  private readonly _title: HTMLElement;
  private readonly _summary: HTMLElement;
  private readonly _body: HTMLElement;
  private readonly _source: HTMLAnchorElement;
  private _abort: AbortController | null = null;
  private _history: View[] = [];
  private _open = false;

  constructor(container: HTMLElement) {
    this._container = container;
    const shell = createPanelShell(container, 'timetable', {
      title: 'Timetable',
      label: 'Station timetable',
      closeLabel: 'Close timetable',
      onClose: () => this.close(),
    });
    this.panel = shell.panel;
    this._title = this.panel.querySelector('.timetable-title');
    this._summary = shell.summary;
    this._body = shell.body;
    this._source = el('a', 'timetable-source', this.panel);
    this._source.target = '_blank';
    this._source.rel = 'noopener noreferrer';
    this._source.textContent = 'Yahoo!乗換案内';
    this.panel.inert = true;
  }

  get isOpen() {
    return this._open;
  }

  open(request: TimetableRequest) {
    this._open = true;
    emitUiPanelOpen(this._container, 'timetable');
    this.panel.classList.add('timetable-panel-visible');
    this.panel.setAttribute('aria-hidden', 'false');
    this.panel.inert = false;
    this._history = [];
    this._show(() => this._renderLines(request));
  }

  close() {
    this._open = false;
    this._abort?.abort();
    this.panel.classList.remove('timetable-panel-visible');
    this.panel.setAttribute('aria-hidden', 'true');
    this.panel.inert = true;
  }

  // Shows a view and remembers it for the back button.
  private _show(view: View) {
    this._history.push(view);
    this._run(view);
  }

  private _back() {
    if (this._history.length < 2) return;
    this._history.pop();
    this._run(this._history[this._history.length - 1]);
  }

  private _run(view: View) {
    this._abort?.abort();
    this._abort = new AbortController();
    const signal = this._abort.signal;
    this._body.replaceChildren(el('div', 'timetable-status'));
    this._body.firstElementChild.textContent = 'Loading…';
    view().catch((error: unknown) => {
      if (signal.aborted) return;
      this._body.replaceChildren(this._backButton());
      const status = el('div', 'timetable-status timetable-error', this._body);
      status.textContent = `Could not load the timetable: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  private get _signal() {
    return this._abort.signal;
  }

  private _backButton(label = 'Back') {
    const fragment = document.createDocumentFragment();
    if (this._history.length < 2) return fragment;
    const button = el('button', 'timetable-back', fragment);
    button.type = 'button';
    button.textContent = `← ${label}`;
    button.addEventListener('click', () => this._back());
    return fragment;
  }

  private _setHeader(title: string, summary: string, source: string | null) {
    this._title.textContent = title;
    this._summary.textContent = summary;
    this._source.hidden = !source;
    if (source) this._source.href = source;
  }

  private async _renderLines(request: TimetableRequest) {
    const signal = this._signal;
    this._setHeader(request.name, 'Lines', null);
    const stations = request.codes.length
      ? request.codes.map((code) => ({ code, name: null as string | null }))
      : (await findStationsByName(request.name, signal)).map(({ code, name }) => ({ code, name }));
    if (signal.aborted) return;
    if (stations.length === 0) {
      this._body.replaceChildren(this._backButton());
      el('div', 'timetable-status', this._body).textContent = `No timetable found for ${request.name}.`;
      return;
    }
    const tables = await Promise.all(stations.map(({ code }) => stationLines(code, signal)));
    if (signal.aborted) return;
    this._body.replaceChildren(this._backButton());
    this._setHeader(request.name, 'Lines', tables.length === 1 ? tables[0].source_url : null);
    for (const table of tables) {
      const section = el('section', 'timetable-station', this._body);
      if (tables.length > 1) el('h3', 'timetable-station-name', section).textContent = table.station.name;
      if (table.lines.length === 0) el('div', 'timetable-status', section).textContent = 'No lines listed.';
      for (const line of table.lines) {
        const group = el('div', 'timetable-line', section);
        el('div', 'timetable-line-name', group).textContent = line.name;
        for (const { direction, gid } of line.directions) {
          const button = el('button', 'timetable-direction', group);
          button.type = 'button';
          button.textContent = `→ ${direction}`;
          button.addEventListener('click', () =>
            this._show(() => this._renderDepartures(table.station.code, gid, table.station.name, null)),
          );
        }
      }
    }
  }

  private async _renderDepartures(code: string, gid: string, stationName: string, day: TimetableDay | null) {
    const signal = this._signal;
    const table = await departures(code, gid, day, signal);
    if (signal.aborted) return;
    this._setHeader(stationName, `${table.line} → ${table.direction}`, table.source_url);
    this._body.replaceChildren(this._backButton('Lines'));

    const days = el('div', 'timetable-days', this._body);
    days.setAttribute('role', 'group');
    days.setAttribute('aria-label', 'Day');
    for (const [value, label] of Object.entries(DAY_LABELS) as Array<[TimetableDay, string]>) {
      const button = el('button', 'timetable-day', days);
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(value === table.day));
      button.addEventListener('click', () => {
        if (value === table.day) return;
        // Replace this view rather than stacking day switches on the back button.
        this._history.pop();
        this._show(() => this._renderDepartures(code, gid, stationName, value));
      });
    }

    if (table.departures.length === 0) {
      el('div', 'timetable-status', this._body).textContent = 'No departures.';
      return;
    }
    const list = el('ol', 'timetable-departures', this._body);
    const next = nextDepartureIndex(table);
    let hour = '';
    table.departures.forEach((departure: Departure, index) => {
      const departureHour = departure.time.slice(0, 2);
      if (departureHour !== hour) {
        hour = departureHour;
        el('li', 'timetable-hour', list).textContent = `${Number(hour)}時`;
      }
      const item = el('li', 'timetable-departure', list);
      const button = el('button', 'timetable-departure-button', item);
      button.type = 'button';
      if (index === next) item.classList.add('timetable-next');
      el('span', 'timetable-time', button).textContent = departure.time;
      el('span', 'timetable-kind', button).textContent = departure.kind ?? '';
      el('span', 'timetable-destination', button).textContent =
        `${departure.destination ?? ''}${departure.extra ? ' ◆' : ''}`;
      if (departure.extra) button.title = 'Runs on specific days only';
      button.addEventListener('click', () =>
        this._show(() => this._renderTrain(code, gid, departure.train_id, stationName)),
      );
    });
    if (next >= 0) list.querySelector('.timetable-next')?.scrollIntoView?.({ block: 'center' });
  }

  private async _renderTrain(code: string, gid: string, trainId: string, stationName: string) {
    const signal = this._signal;
    const train = await trainStops(code, gid, trainId, signal);
    if (signal.aborted) return;
    this._setHeader(stationName, [train.name, train.line].filter(Boolean).join(' · '), train.source_url);
    this._body.replaceChildren(this._backButton('Departures'));
    for (const comment of train.comments) el('p', 'timetable-comment', this._body).textContent = comment;
    const list = el('ol', 'timetable-stops', this._body);
    for (const stop of train.stops) {
      const item = el('li', 'timetable-stop', list);
      if (stop.code === code) item.classList.add('timetable-stop-here');
      const name = stop.code ? el('button', 'timetable-stop-name', item) : el('span', 'timetable-stop-name', item);
      name.textContent = stop.name;
      if (stop.code && name instanceof HTMLButtonElement) {
        name.type = 'button';
        name.title = `Timetable at ${stop.name}`;
        const stopCode = stop.code;
        name.addEventListener('click', () =>
          this._show(() => this._renderLines({ name: stop.name, codes: [stopCode] })),
        );
      }
      el('span', 'timetable-stop-time', item).textContent = [stop.arrival, stop.departure]
        .map((time) => time ?? '')
        .join(' – ')
        .replace(/^ – | – $/g, '');
    }
    list.querySelector('.timetable-stop-here')?.scrollIntoView?.({ block: 'center' });
  }
}

// Station features Yahoo may know: anything carrying codes, or a station with
// a Japanese name inside Japan's bounds (Korean names are Hangul).
const JAPAN_BOUNDS = { west: 122.9, south: 24, east: 154, north: 45.6 };
const JAPANESE_NAME = /[぀-ヿ一-鿿]/;
const STATION_FEATURES = new Set(['station', 'halt']);

type StationFeatureLike = {
  sourceLayer?: string;
  properties?: Record<string, unknown>;
  geometry: { type: string; coordinates?: unknown };
};

export function timetableRequestFor(feature: StationFeatureLike): TimetableRequest | null {
  const properties = feature.properties ?? {};
  if (!feature.sourceLayer?.includes('stations')) return null;
  const name = String(properties.name ?? '');
  const codes = String(properties.yahoo_codes ?? '')
    .split(';')
    .filter(Boolean);
  if (codes.length > 0) return { name, codes };
  if (!STATION_FEATURES.has(String(properties.feature)) || !JAPANESE_NAME.test(name)) return null;
  if (feature.geometry.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) return null;
  const [lng, lat] = feature.geometry.coordinates as number[];
  const { west, south, east, north } = JAPAN_BOUNDS;
  return lng >= west && lng <= east && lat >= south && lat <= north ? { name, codes: [] } : null;
}

// Adds a Timetable button to a station's info box.
export function timetableButton(feature: StationFeatureLike, content: HTMLElement) {
  const request = timetableRequestFor(feature);
  if (!request) return;
  // Below the info box's header, so it shows without scrolling a long box.
  const actions = el('div', 'orm-popup-actions');
  const header = Array.from(content.querySelectorAll('.orm-popup-title, .orm-popup-label')).at(-1);
  (header?.parentNode ?? content).insertBefore(actions, header?.nextSibling ?? null);
  const button = el('button', 'orm-popup-action', actions);
  button.type = 'button';
  button.textContent = 'Timetable';
  button.addEventListener('click', () =>
    button.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { bubbles: true, detail: request })),
  );
}

export function installTimetable(map: TimetableMap) {
  const container = map.getContainer();
  const panel = new TimetablePanel(container);
  container.addEventListener(TIMETABLE_OPEN_EVENT, (event) => {
    const request = (event as CustomEvent<TimetableRequest>).detail;
    if (request?.name || request?.codes?.length) panel.open(request);
  });
  container.addEventListener(UI_PANEL_OPEN_EVENT, (event) => {
    if (isOtherUiPanelOpen(event, 'timetable')) panel.close();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.isOpen && !(event.target instanceof HTMLInputElement)) panel.close();
  });
  return panel;
}
