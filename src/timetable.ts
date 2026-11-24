// Station timetables from the API (norikae.ts), in a panel opened by
// the Timetable button (timetableButton) of a station's info box through
// TIMETABLE_OPEN_EVENT on the map container.
//
// Japan (Yahoo! 乗換案内): a station's lines and directions, then one
// direction's departures for a day type, then the stops of one train.
// Stations carry their Yahoo station codes as `yahoo_codes` (from
// data_builder/stations/jp-station-codes.py); a stop of a train opened from the panel
// may be looked up by name, and a name Yahoo knows as several stations
// (府中(東京都), 府中(広島県)) lists each station's lines under its Yahoo name.
//
// China Railway: every train stopping at a station on a date, then the stops
// of one train. The API finds the station by its OSM elements, else by name.
//
// A train's view draws its route on the map (train-route.ts) and gives each
// stop the API placed on OSM a button that flies the map there; pointing at a
// stop marks it on the map.
import { createPanelShell, el, retryButton } from './map-panel.js';
import {
  addDays,
  chinaNow,
  crStationTimetable,
  crTrain,
  crTrainRoute,
  crTrainset,
  departures,
  findStationsByName,
  isRetryable,
  japanNow,
  minutesOf,
  NorikaeError,
  stationLines,
  trainRoute,
  trainStops,
  type CrLine,
  type CrRollingStock,
  type CrStationTimetable,
  type CrStationTrain,
  type CrTrainset,
  type Departure,
  type DepartureTable,
  type TrainRoute,
  type TimetableDay,
} from './norikae.js';
import { hoverStopOnMap } from './route-highlight.js';
import { readStoredSettings, writeStoredSettings } from './stored-settings.js';
import type { TrainRouteDrawer } from './train-route.js';
import { emitUiPanelOpen, isOtherUiPanelOpen, UI_PANEL_OPEN_EVENT } from './ui-panels.js';

export const TIMETABLE_OPEN_EVENT = 'orm:timetable';
export const TIMETABLE_LINES_STORAGE_KEY = 'atlas-realm:timetable-lines';
export const TIMETABLE_PRINTED_STORAGE_KEY = 'atlas-realm:timetable-printed';
// Yahoo station codes, or China Railway stations to try in turn (OSM elements
// "N1,W2", then the name).
type YahooRequest = { name: string; codes: string[] };
// A China Railway train can also be opened by itself, as search does
// (`crTrain`, the day it leaves its origin).
export type TimetableRequest =
  | YahooRequest
  | { name: string; cr: string[] }
  | { name: string; crTrain: string; date: string };
type Source = { text: string; href?: string };

// As Yahoo's own timetables name them
const DAY_LABELS: Record<TimetableDay, string> = {
  weekday: '平日',
  saturday: '土曜',
  holiday: '日曜・祝日',
};
// Departures before this time belong to the previous service day ("00:30").
const SERVICE_DAY_START = 3 * 60;

const yahooSource = (href: string): Source => ({ text: 'Yahoo!乗換案内', href });
const crSource = (version: string): Source => ({ text: `lltskb ${version}` });
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const crDateLabel = (date: string) => `${date} ${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;

type TimetableMap = {
  getContainer(): HTMLElement;
  flyTo?(options: { center: [number, number]; zoom: number }): unknown;
  getZoom?(): number;
};
type View = () => Promise<void>;

function serviceMinutes(time: string) {
  const minutes = minutesOf(time);
  return minutes < SERVICE_DAY_START ? minutes + 24 * 60 : minutes;
}

// The China Railway train to highlight: the next one, when the table is today's.
export function nextCrTrainIndex(table: Pick<CrStationTimetable, 'date' | 'trains'>, now = chinaNow()) {
  if (table.date !== now.date) return -1;
  return table.trains.findIndex(({ arrival, departure }) => minutesOf(departure ?? arrival ?? '00:00') >= now.minutes);
}

// A China Railway station's tabs, in two rows: the lines its trains take
// here, the busiest first, then "Other" for the trains the data names no line
// for; and their directions, 下行 before 上行. Each tab with its train count.
const OTHER_LINE = 'Other';
const BOUNDS = ['下行', '上行'] as const;

export function crLineOf(train: Pick<CrStationTrain, 'line'>) {
  return train.line ?? OTHER_LINE;
}

export function crLineTabs(trains: Array<Pick<CrStationTrain, 'line'>>) {
  const counts = new Map<string, number>();
  for (const train of trains) counts.set(crLineOf(train), (counts.get(crLineOf(train)) ?? 0) + 1);
  return [...counts]
    .map(([line, count]) => ({ line, count }))
    .sort(
      (a, b) =>
        Number(a.line === OTHER_LINE) - Number(b.line === OTHER_LINE) ||
        b.count - a.count ||
        a.line.localeCompare(b.line),
    );
}

export function crBoundTabs(trains: Array<Pick<CrStationTrain, 'bound'>>) {
  return BOUNDS.map((bound) => ({ bound, count: trains.filter((train) => train.bound === bound).length })).filter(
    ({ count }) => count > 0,
  );
}

// The departure to highlight: the next one from now, on whichever day's table
// shows, so a train's place in the day reads the same on each of them.
export function nextDepartureIndex(table: Pick<DepartureTable, 'departures'>, now: { minutes: number } = japanNow()) {
  const current = now.minutes < SERVICE_DAY_START ? now.minutes + 24 * 60 : now.minutes;
  return table.departures.findIndex((departure) => serviceMinutes(departure.time) >= current);
}

// A direction as Yahoo's timetables name it, by where it goes: 新宿・高崎・宇都宮方面.
export function directionLabel(direction: string) {
  return /方面$|回り/.test(direction) ? direction : `${direction}方面`;
}

// What the timetable says a train runs with: "CR400BF-S ×2 (coupled) · 上局上海段".
export function rollingStockLabel(stock: CrRollingStock | null | undefined) {
  if (!stock) return null;
  const sets = stock.model
    ? `${stock.model}${stock.coupled ? ' ×2 (coupled)' : ''}`
    : stock.coupled
      ? 'Two coupled sets'
      : null;
  return [sets, stock.depot].filter(Boolean).join(' · ') || null;
}

// The lines a train runs on between each stop and the next, in order, each
// after the first with the junction it begins at. The lines' km are on the
// stops' scale, which only grows along the run, so a line belongs between two
// stops when its span overlaps theirs.
export type LineSegment = { name: string; from: string | null };
export function crLinesBetweenStops(stops: Array<{ km: number }>, lines: CrLine[]): LineSegment[][] {
  return stops.slice(1).map((stop, index) => {
    const start = stops[index].km;
    const overlapping = lines.filter(({ stations }) => {
      const first = stations[0];
      const last = stations[stations.length - 1];
      return first && last && first.km < stop.km && last.km > start;
    });
    return overlapping.map(({ name, stations }, position) => ({ name, from: position ? stations[0].name : null }));
  });
}

// The trainset 12306 assigns: "CR400BF-A-5053 · 复兴号 · 16 cars · 1193 seats · 350 km/h".
export function trainsetLabel(trainset: NonNullable<CrTrainset['trainset']>) {
  return [trainset.id, trainset.cars && `${trainset.cars} cars`].filter(Boolean).join(' · ');
}

// What a departure's row says on hover: the railway's train number and what
// its badges and marks stand for.
function departureTitle(departure: Departure) {
  return [
    departure.train_number && `Train ${departure.train_number}`,
    departure.starts_here && 'Starts here',
    departure.green_car && 'Green Car',
    departure.track && `Track ${departure.track}`,
    departure.extra && 'Runs on specific days only',
  ]
    .filter(Boolean)
    .join(' · ');
}

// What a printed timetable's marks stand for on this table: each kind and
// destination mark, and the line's usual type and destination, which carry
// none (the most frequent among the unmarked departures).
function departureLegend(departures: Departure[]) {
  const kinds = new Map<string, string>();
  const destinations = new Map<string, string>();
  const usualCounts = { kind: new Map<string, number>(), destination: new Map<string, number>() };
  for (const departure of departures) {
    if (departure.kind_mark && departure.kind) kinds.set(departure.kind_mark, departure.kind);
    else if (departure.kind) usualCounts.kind.set(departure.kind, (usualCounts.kind.get(departure.kind) ?? 0) + 1);
    if (departure.destination_mark && departure.destination)
      destinations.set(departure.destination_mark, departure.destination);
    else if (departure.destination) {
      const counts = usualCounts.destination;
      counts.set(departure.destination, (counts.get(departure.destination) ?? 0) + 1);
    }
  }
  const mostFrequent = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    kinds: [...kinds],
    destinations: [...destinations],
    usualKind: mostFrequent(usualCounts.kind),
    usualDestination: mostFrequent(usualCounts.destination),
  };
}

// Why a train's track is not on the map, from the route request's error.
function routeMissingText(error: unknown) {
  if (error instanceof NorikaeError && error.status === 404) return 'Its track is not available yet.';
  return 'Its track could not be loaded.';
}

// What went wrong as the API or the browser put it, for a failure message's
// tooltip; the message itself stays plain and names no data source.
function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class TimetablePanel {
  readonly panel: HTMLElement;
  private readonly _container: HTMLElement;
  private readonly _title: HTMLElement;
  private readonly _summary: HTMLElement;
  private readonly _nav: HTMLElement;
  private readonly _body: HTMLElement;
  private readonly _source: HTMLAnchorElement;
  private readonly _map: TimetableMap;
  private readonly _route: TrainRouteDrawer | null;
  private _abort: AbortController | null = null;
  private _history: View[] = [];
  // The line and direction tabs picked at a China Railway station, kept across its days.
  private _crFilter: { station: string; line: string | null; bound: string | null } | null = null;
  private _open = false;

  constructor(map: TimetableMap, route: TrainRouteDrawer | null) {
    const container = map.getContainer();
    this._container = container;
    this._map = map;
    this._route = route;
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
    // The back button sits between the header and the scrolling list, so it
    // stays in view however far the list is scrolled.
    this._nav = el('div', 'timetable-nav');
    this.panel.insertBefore(this._nav, this._body);
    this._source = el('a', 'timetable-source', this.panel);
    this._source.target = '_blank';
    this._source.rel = 'noopener noreferrer';
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
    this._show(() =>
      'crTrain' in request
        ? this._renderCrTrain(request.crTrain, request.date, null)
        : 'cr' in request
          ? this._renderCrStation(request.cr, request.name, null)
          : this._renderLines(request),
    );
  }

  close() {
    this._open = false;
    this._abort?.abort();
    this._route?.clear();
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
    // Only a train's view shows its route.
    this._route?.clear();
    this._setBack();
    this._body.replaceChildren(el('div', 'timetable-status'));
    this._body.firstElementChild.textContent = 'Loading…';
    view().catch((error: unknown) => {
      if (signal.aborted) return;
      this._setBack();
      this._body.replaceChildren();
      const status = el('div', 'timetable-status timetable-error', this._body);
      const message = el('span', 'timetable-error-message', status);
      message.textContent = 'Could not load the timetable.';
      message.title = errorDetail(error);
      if (isRetryable(error)) retryButton(status, () => this._run(view));
    });
  }

  private get _signal() {
    return this._abort.signal;
  }

  private _setBack(label = 'Back') {
    this._nav.replaceChildren();
    this._nav.hidden = this._history.length < 2;
    if (this._nav.hidden) return;
    const button = el('button', 'timetable-back', this._nav);
    button.type = 'button';
    button.textContent = `← ${label}`;
    button.addEventListener('click', () => this._back());
  }

  // A view's day or date buttons, in the back button's row, which stays in
  // view however far the view below it scrolls; they show that row even
  // without a back button.
  private _navGroup(label: string) {
    const group = el('div', 'timetable-days', this._nav);
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    this._nav.hidden = false;
    return group;
  }

  // A switch the browser remembers, in the back button's row as well.
  private _navToggle(label: string, storageKey: string, title?: string) {
    const toggle = el('label', 'timetable-toggle', this._nav);
    const input = el('input', undefined, toggle);
    input.type = 'checkbox';
    input.checked = readStoredSettings(storageKey, (value) => value === true);
    el('span', undefined, toggle).textContent = label;
    if (title) toggle.title = title;
    input.addEventListener('change', () => writeStoredSettings(storageKey, input.checked));
    this._nav.hidden = false;
    return input;
  }

  // Draws a train's route once the API has it, unless the view changed meanwhile;
  // for a route the API cannot give (an error, a train not routed yet) a note
  // above the stops says why it is not on the map.
  private _drawRoute(load: () => Promise<TrainRoute>, here: string | null) {
    const signal = this._signal;
    if (!this._route) return;
    load()
      .then((route) => {
        if (signal.aborted) return;
        // Clear of the panel: beside it on a wide screen, above the bottom sheet on a phone.
        const map = this._container.getBoundingClientRect();
        const panel = this.panel.getBoundingClientRect();
        const margin = 48;
        const padding =
          panel.width < map.width * 0.6
            ? { top: margin + 16, right: margin + 40, bottom: margin, left: panel.right - map.left + margin }
            : { top: margin + 16, right: margin, bottom: map.bottom - panel.top + margin, left: margin };
        this._route.show(route, here, padding);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        const note = el('p', 'timetable-comment timetable-route-missing');
        const message = el('span', undefined, note);
        message.textContent = routeMissingText(error);
        message.title = errorDetail(error);
        if (isRetryable(error))
          retryButton(note, () => {
            note.remove();
            this._drawRoute(load, here);
          });
        this._body.insertBefore(note, this._body.querySelector('.timetable-stops'));
      });
  }

  // The trainset 12306 assigns, asked once the train shows. It replaces the
  // rolling stock the timetable plans (`planned`, its row and note), which
  // often names another model; a train 12306 has none for (not an EMU), or
  // no answer, keeps the timetable's.
  private _trainset(facts: HTMLElement, train: string, date: string, planned: Element[]) {
    const signal = this._signal;
    const term = el('dt', undefined, facts);
    term.textContent = 'Trainset';
    const value = el('dd', 'timetable-trainset', facts);
    const ask = () => {
      value.classList.remove('timetable-unavailable');
      value.textContent = 'Loading…';
      crTrainset(train, date, signal)
        .then(({ trainset }) => answer(trainset))
        .catch((error: unknown) => {
          if (signal.aborted) return;
          value.replaceChildren();
          value.classList.add('timetable-unavailable');
          const message = el('span', undefined, value);
          message.textContent = 'Could not load the trainset';
          message.title = errorDetail(error);
          if (isRetryable(error)) retryButton(value, ask);
        });
    };
    const answer = (trainset: CrTrainset['trainset']) => {
      if (signal.aborted) return;
      if (!trainset) {
        term.remove();
        value.remove();
        return;
      }
      for (const element of planned) element.remove();
      value.textContent = trainsetLabel(trainset);
      value.title = 'The trainset 12306 assigns for this day';
      if (!trainset.details.length && !trainset.coaches.length) return;
      const more = el('details', 'timetable-coaches', value);
      el('summary', undefined, more).textContent = 'Coaches';
      const details = el('dl', 'timetable-coach-details', more);
      for (const { name, value: text } of trainset.details) {
        el('dt', undefined, details).textContent = name;
        el('dd', undefined, details).textContent = text ?? '✓';
      }
      const coaches = el('ol', 'timetable-coach-list', more);
      for (const coach of trainset.coaches) el('li', undefined, coaches).textContent = coach;
    };
    ask();
  }

  // A button that flies the map to a stop, or an empty cell keeping the column;
  // pointing at the stop's row marks it on the map.
  private _locate(item: HTMLElement, name: string, position: [number, number] | null | undefined) {
    if (position && this._route) hoverStopOnMap(item, { name, position }, (stop) => this._route.hover(stop));
    if (!position || !this._map.flyTo) {
      el('span', 'timetable-stop-locate', item);
      return;
    }
    const button = el('button', 'timetable-stop-locate', item);
    button.type = 'button';
    button.title = `Show ${name} on the map`;
    button.setAttribute('aria-label', button.title);
    button.innerHTML = LOCATE_ICON;
    button.addEventListener('click', () =>
      this._map.flyTo({ center: position, zoom: Math.max(this._map.getZoom?.() ?? 0, 14) }),
    );
  }

  // A train's facts above its stops, as label and value rows.
  private _facts(rows: Array<[string, string | null]>) {
    const facts = el('dl', 'route-info-fields timetable-meta', this._body);
    for (const [label, value] of rows) {
      if (!value) continue;
      el('dt', undefined, facts).textContent = label;
      el('dd', undefined, facts).textContent = value;
    }
    return facts;
  }

  private _setHeader(title: string, summary: string, source: Source | null) {
    this._title.textContent = title;
    this._summary.textContent = summary;
    this._source.hidden = !source;
    if (!source) return;
    this._source.textContent = source.text;
    if (source.href) this._source.href = source.href;
    else this._source.removeAttribute('href');
  }

  private async _renderLines(request: YahooRequest) {
    const signal = this._signal;
    this._setHeader(request.name, 'Lines', null);
    const stations = request.codes.length
      ? request.codes.map((code) => ({ code, name: null as string | null }))
      : (await findStationsByName(request.name, signal)).map(({ code, name }) => ({ code, name }));
    if (signal.aborted) return;
    if (stations.length === 0) {
      this._setBack();
      this._body.replaceChildren();
      el('div', 'timetable-status', this._body).textContent = `No timetable found for ${request.name}.`;
      return;
    }
    const tables = await Promise.all(stations.map(({ code }) => stationLines(code, signal)));
    if (signal.aborted) return;
    this._setBack();
    this._body.replaceChildren();
    this._setHeader(request.name, 'Lines', tables.length === 1 ? yahooSource(tables[0].source_url) : null);
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
          button.textContent = directionLabel(direction);
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
    this._setHeader(stationName, `${table.line} ${directionLabel(table.direction)}`, yahooSource(table.source_url));
    this._setBack('Lines');
    this._body.replaceChildren();

    const days = this._navGroup('Day');
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
    const next = nextDepartureIndex(table);
    const open = (departure: Departure) =>
      this._show(() => this._renderTrain(code, gid, departure.train_id, stationName, departure));

    // A list, or the printed timetable's layout.
    const input = this._navToggle(
      'Printed',
      TIMETABLE_PRINTED_STORAGE_KEY,
      'Lay the departures out as a printed timetable',
    );

    const list = el('ol', 'timetable-departures timetable-jp-departures', this._body);
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
      const kind = el('span', 'timetable-kind', button);
      kind.textContent = departure.name ?? departure.kind ?? '';
      // A type other than the line's usual one carries a mark, and stands out.
      if (departure.kind_mark) kind.classList.add('timetable-kind-special');
      el('span', 'timetable-destination', button).textContent =
        `${departure.destination ?? ''}${departure.extra ? ' ◆' : ''}`;
      const info = el('span', 'timetable-train-info', button);
      if (departure.starts_here) el('span', 'timetable-badge timetable-badge-start', info).textContent = '始';
      if (departure.green_car) el('span', 'timetable-badge timetable-badge-green', info).textContent = 'G';
      if (departure.cars) el('span', 'timetable-cars', info).textContent = `${departure.cars}両`;
      el('span', 'timetable-platform', button).textContent = departure.track ?? '';
      button.title = departureTitle(departure);
      button.addEventListener('click', () => open(departure));
    });

    const printed = el('div', 'timetable-printed', this._body);
    const grid = el('div', 'timetable-grid', printed);
    let row: HTMLElement | null = null;
    hour = '';
    table.departures.forEach((departure: Departure, index) => {
      const departureHour = departure.time.slice(0, 2);
      if (departureHour !== hour) {
        hour = departureHour;
        el('div', 'timetable-grid-hour', grid).textContent = String(Number(hour));
        row = el('div', 'timetable-grid-minutes', grid);
      }
      const button = el('button', 'timetable-grid-minute', row);
      button.type = 'button';
      if (index === next) button.classList.add('timetable-next');
      if (departure.kind_mark) button.classList.add('timetable-kind-special');
      // As Yahoo writes them: the destination's mark, then the type's in brackets (上[特]).
      const marks = [
        departure.starts_here ? '●' : '',
        departure.destination_mark ?? '',
        departure.kind_mark ? `[${departure.kind_mark}]` : '',
        departure.extra ? '◆' : '',
      ].join('');
      el('span', 'timetable-grid-marks', button).textContent = marks || '\u00A0';
      el('span', 'timetable-grid-time', button).textContent = departure.time.slice(3);
      button.title = [
        `${departure.time} ${departure.name ?? departure.kind ?? ''} → ${departure.destination ?? '?'}`,
        departureTitle(departure),
      ]
        .filter(Boolean)
        .join('\n');
      button.addEventListener('click', () => open(departure));
    });
    const legend = departureLegend(table.departures);
    // Each mark kept on one line with what it stands for.
    const key = el('ul', 'timetable-legend', printed);
    const entry = (mark: string, meaning: string) => {
      const item = el('li', undefined, key);
      el('b', undefined, item).textContent = mark;
      item.append(` ${meaning}`);
    };
    for (const [mark, kindName] of legend.kinds) entry(`[${mark}]`, kindName);
    for (const [mark, destination] of legend.destinations) entry(mark, `for ${destination}`);
    if (table.departures.some((departure) => departure.starts_here)) entry('●', 'Starts here');
    if (table.departures.some((departure) => departure.extra)) entry('◆', 'Runs on specific days only');
    const usual = [legend.usualKind, legend.usualDestination && `for ${legend.usualDestination}`].filter(Boolean);
    if (usual.length) entry('No mark', usual.join(' '));

    const layout = () => {
      list.hidden = input.checked;
      printed.hidden = !input.checked;
      const current = (input.checked ? grid : list).querySelector('.timetable-next');
      current?.scrollIntoView?.({ block: 'center' });
    };
    input.addEventListener('change', layout);
    layout();
  }

  // `departure` is the timetable's row the train was opened from, which knows
  // its number, cars and track here; a train opened otherwise goes without.
  private async _renderTrain(
    code: string,
    gid: string,
    trainId: string,
    stationName: string,
    departure: Departure | null = null,
  ) {
    const signal = this._signal;
    const train = await trainStops(code, gid, trainId, signal);
    if (signal.aborted) return;
    const name = departure?.name ?? train.name;
    this._setHeader(stationName, [name, train.line].filter(Boolean).join(' · '), yahooSource(train.source_url));
    this._setBack('Departures');
    this._body.replaceChildren();
    const cars = [departure?.cars && `${departure.cars} cars`, departure?.green_car && 'Green Car'].filter(Boolean);
    this._facts([
      ['Train', name],
      ['Number', departure?.train_number ?? null],
      ['Line', train.line],
      ['Cars', cars.join(' · ') || null],
      ['Track', departure?.track ? `${departure.track} at ${stationName}` : null],
      ['Stops', String(train.stops.length)],
    ]);
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
      const position = stop.lon !== null && stop.lon !== undefined ? ([stop.lon, stop.lat] as [number, number]) : null;
      this._locate(item, stop.name, position);
    }
    list.querySelector('.timetable-stop-here')?.scrollIntoView?.({ block: 'center' });
    const here = train.stops.find((stop) => stop.code === code)?.name ?? null;
    this._drawRoute(() => trainRoute(code, gid, trainId, this._signal), here);
  }

  private async _renderCrStation(candidates: string[], name: string, date: string | null) {
    const signal = this._signal;
    this._setHeader(name, 'Trains', null);
    let table: CrStationTimetable | null = null;
    for (const candidate of candidates) {
      try {
        table = await crStationTimetable(candidate, date, signal);
        break;
      } catch (error) {
        // Not a station the timetable knows: try the next way of naming it.
        if (!(error instanceof NorikaeError && error.status === 404)) throw error;
      }
    }
    if (signal.aborted) return;
    this._setBack();
    this._body.replaceChildren();
    if (!table) {
      el('div', 'timetable-status', this._body).textContent = `No China Railway timetable for ${name}.`;
      return;
    }
    const station = table.station.name;
    const trainCount = `${table.trains.length} train${table.trains.length === 1 ? '' : 's'}`;
    this._setHeader(station, `${crDateLabel(table.date)} · ${trainCount}`, crSource(table.data_version));

    const today = chinaNow().date;
    const days = this._navGroup('Date');
    // The steps are drawn chevrons, centred in their circle as a text ‹ › never is.
    const dayButton = (label: string, title: string, target: string, icon?: string) => {
      const button = el('button', icon ? 'timetable-day timetable-day-step' : 'timetable-day', days);
      button.type = 'button';
      button.title = title;
      if (icon) {
        button.innerHTML = icon;
        button.setAttribute('aria-label', title);
      } else {
        button.textContent = label;
      }
      button.addEventListener('click', () => {
        // Replace this view rather than stacking date switches on the back button.
        this._history.pop();
        this._show(() => this._renderCrStation([station], station, target));
      });
    };
    dayButton('‹', 'Previous day', addDays(table.date, -1), CHEVRON_LEFT);
    el('span', 'timetable-date', days).textContent = crDateLabel(table.date);
    dayButton('›', 'Next day', addDays(table.date, 1), CHEVRON_RIGHT);
    if (table.date !== today) dayButton('Today', 'Today in China', today);

    if (table.trains.length === 0) {
      el('div', 'timetable-status', this._body).textContent = 'No trains.';
      return;
    }

    // Line and direction tabs under the date, a row each, the ones picked
    // kept while stepping through this station's days.
    const kept = this._crFilter?.station === station ? this._crFilter : null;
    const lines = crLineTabs(table.trains);
    const bounds = crBoundTabs(table.trains);
    let line = lines.some((tab) => tab.line === kept?.line) ? kept.line : null;
    let bound = bounds.some((tab) => tab.bound === kept?.bound) ? kept.bound : null;
    const tabRow = (label: string, show: boolean) => {
      if (!show) return null;
      const row = this._navGroup(label);
      row.classList.add('timetable-directions');
      return row;
    };
    const lineRow = tabRow('Line', lines.length > 1);
    const boundRow = tabRow('Direction', bounds.length > 1);
    const tab = (row: HTMLElement, label: string, value: string | null, pick: (value: string | null) => void) => {
      const button = el('button', 'timetable-day', row);
      button.type = 'button';
      button.textContent = label;
      button.dataset.value = value ?? '';
      button.addEventListener('click', () => {
        pick(value);
        this._crFilter = { station, line, bound };
        show();
      });
      return button;
    };
    if (lineRow) {
      tab(lineRow, 'All', null, (value) => (line = value));
      for (const { line: value } of lines) tab(lineRow, value, value, (picked) => (line = picked));
    }
    if (boundRow) {
      tab(boundRow, 'Both', null, (value) => (bound = value));
      for (const { bound: value } of bounds) tab(boundRow, value, value, (picked) => (bound = picked));
    }
    const counted = (count: number) => `${count} train${count === 1 ? '' : 's'}`;

    const list = el('ol', 'timetable-departures timetable-cr-trains', this._body);
    const show = () => {
      const onLine = table.trains.filter((train) => line === null || crLineOf(train) === line);
      const trains = onLine.filter((train) => bound === null || train.bound === bound);
      // Each tab says how many trains it would show with the other row's pick.
      for (const button of lineRow?.querySelectorAll<HTMLElement>('.timetable-day') ?? []) {
        const value = button.dataset.value || null;
        button.setAttribute('aria-pressed', String(value === line));
        const count = table.trains.filter(
          (train) => (value === null || crLineOf(train) === value) && (bound === null || train.bound === bound),
        ).length;
        button.title = counted(count);
      }
      for (const button of boundRow?.querySelectorAll<HTMLElement>('.timetable-day') ?? []) {
        const value = button.dataset.value || null;
        button.setAttribute('aria-pressed', String(value === bound));
        button.title = counted(onLine.filter((train) => value === null || train.bound === value).length);
      }
      this._summary.textContent = `${crDateLabel(table.date)} · ${
        trains.length === table.trains.length ? trainCount : `${trains.length} of ${trainCount}`
      }`;
      this._renderCrTrains(list, { ...table, trains }, station);
    };
    show();
  }

  // The trains of a station's day, by hour, the next one highlighted.
  private _renderCrTrains(list: HTMLElement, table: CrStationTimetable, station: string) {
    list.replaceChildren();
    const next = nextCrTrainIndex(table);
    let hour = '';
    table.trains.forEach((train, index) => {
      // Trains ending here only arrive; the list is sorted by that time.
      const time = train.departure ?? train.arrival ?? '';
      if (time.slice(0, 2) !== hour) {
        hour = time.slice(0, 2);
        el('li', 'timetable-hour', list).textContent = `${Number(hour)}时`;
      }
      const item = el('li', 'timetable-departure', list);
      if (index === next) item.classList.add('timetable-next');
      const button = el('button', 'timetable-departure-button', item);
      button.type = 'button';
      const timeCell = el('span', 'timetable-time', button);
      timeCell.textContent = time;
      if (!train.departure) {
        timeCell.classList.add('timetable-time-arrival');
        timeCell.title = 'Arrives; the train ends here';
      }
      // The number it runs under here (Z156 of Z156/Z157), as the station shows it.
      const number = train.departure_number ?? train.arrival_number ?? train.train;
      el('span', 'timetable-kind timetable-train-number', button).textContent = number;
      const destination = el('span', 'timetable-destination', button);
      destination.textContent = `${train.origin} → ${train.destination}`;
      // A train changing lines here says so.
      if (train.line_in && train.line_out && train.line_in !== train.line_out)
        el('span', 'timetable-line-change', destination).textContent = `${train.line_in}→${train.line_out}`;
      el('span', 'timetable-platform', button).textContent = train.platform ?? '';
      button.title = [
        number !== train.train && `Runs as ${train.train}`,
        [train.line, train.bound].filter(Boolean).join(' '),
        train.platform && `Platform or gate ${train.platform}`,
      ]
        .filter(Boolean)
        .join(' · ');
      // The train's own date is the day it left its origin.
      button.addEventListener('click', () =>
        this._show(() => this._renderCrTrain(train.train, addDays(table.date, 1 - train.day), station)),
      );
    });
    if (next >= 0) list.querySelector('.timetable-next')?.scrollIntoView?.({ block: 'center' });
  }

  // `stationName` is the station it was opened from, null when opened by
  // itself; the station's stop is marked, and named first on the map.
  private async _renderCrTrain(train: string, date: string, stationName: string | null) {
    const signal = this._signal;
    const schedule = await crTrain(train, date, signal);
    if (signal.aborted) return;
    // A number can have several service periods; take the one running on the date.
    const run =
      schedule.trains.find((it) => it.runs) ?? schedule.trains.find((it) => it.train === train) ?? schedule.trains[0];
    const stops = run?.stops ?? [];
    const route = stops.length ? `${stops[0].name} → ${stops[stops.length - 1].name}` : '';
    // The header names the train and its ends, and the day it leaves its
    // origin unless that is today; its facts below say the rest.
    const leaves = date !== chinaNow().date && `from ${crDateLabel(date)}`;
    this._setHeader(
      stationName ?? run?.train ?? train,
      [stationName && (run?.train ?? train), route, leaves].filter(Boolean).join(' · '),
      crSource(schedule.data_version),
    );
    this._setBack('Trains');
    this._body.replaceChildren();
    const last = stops[stops.length - 1];
    const facts = this._facts([
      ['Stops', [String(stops.length), last && `${last.km} km`].filter(Boolean).join(' · ')],
      ['In service', run ? `${run.service.from} – ${run.service.to ?? 'until further notice'}` : null],
      ['Rolling stock', rollingStockLabel(run?.rolling_stock)],
    ]);
    // The description, unless it only names the model.
    const stock = run?.rolling_stock;
    const stockTerm = Array.from(facts.children).find((child) => child.textContent === 'Rolling stock');
    const planned = stockTerm ? [stockTerm, stockTerm.nextElementSibling] : [];
    if (stock?.description && stock.description !== stock.model) {
      const description = el('p', 'timetable-comment', this._body);
      description.textContent = stock.description;
      planned.push(description);
    }
    this._trainset(facts, run?.train ?? train, date, planned);
    if (run && !run.runs)
      el('p', 'timetable-comment', this._body).textContent = `Does not leave its origin on ${date}.`;
    // Lines and distances, folded into the stops: each stop's km from the
    // origin, and between two stops the lines the train runs on there.
    const segments = crLinesBetweenStops(stops, run?.lines ?? []);
    const input = this._navToggle(
      segments.some((lines) => lines.length) ? 'Lines and distances' : 'Distances',
      TIMETABLE_LINES_STORAGE_KEY,
    );
    const list = el('ol', 'timetable-stops timetable-cr-stops', this._body);
    list.classList.toggle('timetable-show-lines', input.checked);
    input.addEventListener('change', () => list.classList.toggle('timetable-show-lines', input.checked));
    stops.forEach((stop, index) => {
      const lines = index > 0 ? segments[index - 1] : [];
      if (lines.length) {
        const row = el('li', 'timetable-stop-lines', list);
        lines.forEach(({ name, from }, position) => {
          if (position) row.append(' → ');
          el('span', 'timetable-segment-line', row).textContent = name;
          if (from) el('span', 'timetable-segment-junction', row).textContent = ` from ${from}`;
        });
      }
      const item = el('li', 'timetable-stop', list);
      if (stop.name === stationName) item.classList.add('timetable-stop-here');
      const name = el('button', 'timetable-stop-name', item);
      name.type = 'button';
      name.textContent = stop.name;
      name.title = `Timetable at ${stop.name}`;
      // Where the number changes (Z156/Z157 at 山海关), the numbers in and out.
      if (stop.arrival_number && stop.departure_number && stop.arrival_number !== stop.departure_number) {
        const change = el('span', 'timetable-number-change', name);
        change.textContent = `${stop.arrival_number}→${stop.departure_number}`;
        change.title = `Arrives as ${stop.arrival_number}, leaves as ${stop.departure_number}`;
      }
      name.addEventListener('click', () =>
        this._show(() => this._renderCrStation([stop.name], stop.name, addDays(date, stop.day - 1))),
      );
      const times = el('span', 'timetable-stop-time', item);
      times.textContent = [stop.arrival, stop.departure]
        .map((time) => time ?? '')
        .join(' – ')
        .replace(/^ – | – $/g, '');
      if (stop.day > 1) {
        const day = el('span', 'timetable-stop-day', times);
        day.textContent = `+${stop.day - 1}`;
        day.title = `${stop.day - 1} day${stop.day > 2 ? 's' : ''} after leaving its origin`;
      }
      el('span', 'timetable-stop-km', item).textContent = `${stop.km} km`;
      const platform = el('span', 'timetable-platform', item);
      platform.textContent = stop.platform ?? '';
      if (stop.platform) platform.title = `Platform or gate ${stop.platform}`;
      this._locate(item, stop.name, stop.position);
    });
    list.querySelector('.timetable-stop-here')?.scrollIntoView?.({ block: 'center' });
    this._drawRoute(() => crTrainRoute(run?.train ?? train, date, this._signal), stationName);
  }
}

// Japanese stations are the ones with Yahoo codes. China Railway stations are
// mainline stations with a Chinese name (Han characters, no kana) in China:
// its bounding box without the corner holding Korea and Japan and without
// Taiwan and the Ryukyu Islands; Korean names are Hangul anyway. The API
// answers 404 for stations it does not know, and the panel says so.
const STATION_FEATURES = new Set(['station', 'halt']);
const URBAN_STATIONS = new Set(['subway', 'light_rail', 'tram', 'monorail', 'funicular']);
const HAN = /[一-鿿]/;
const KANA = /[぀-ヿ]/;
const MAX_CR_ELEMENTS = 10;

function inChina(lng: number, lat: number) {
  if (lng < 73.5 || lng > 135.1 || lat < 18 || lat > 53.6) return false;
  return !(lng > 125 && lat < 41.5) && !(lng > 119.2 && lat < 25.5);
}

// The station's OSM elements as the API takes them: N1,W2.
function osmElements(properties: Record<string, unknown>) {
  const ids = String(properties.osm_id ?? '').split('\u001e');
  const types = String(properties.osm_type ?? '').split('\u001e');
  const elements = ids.map((id, index) => (/^\d+$/.test(id) && /^[NWR]$/.test(types[index]) ? types[index] + id : ''));
  return [...new Set(elements.filter(Boolean))].slice(0, MAX_CR_ELEMENTS);
}

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
  if (!STATION_FEATURES.has(String(properties.feature)) || URBAN_STATIONS.has(String(properties.station))) return null;
  if (!HAN.test(name) || KANA.test(name)) return null;
  if (feature.geometry.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) return null;
  const [lng, lat] = feature.geometry.coordinates as number[];
  if (!inChina(lng, lat)) return null;
  // OSM names often end in 站, which China Railway's names leave out.
  const cr = [osmElements(properties).join(','), name.replace(/站$/, '')].filter(Boolean);
  return { name, cr };
}

const chevron = (path: string) =>
  `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
const CHEVRON_LEFT = chevron('M6 2 3 5l3 3');
const CHEVRON_RIGHT = chevron('M4 2l3 3-3 3');

const LOCATE_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="4.5"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke-linecap="round"/></svg>';

const CLOCK_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>';

// Adds a Timetable button to a station's info box.
export function timetableButton(feature: StationFeatureLike, content: HTMLElement) {
  const request = timetableRequestFor(feature);
  if (!request) return;
  // At the end of the name row (or below the title), so it shows without
  // scrolling a long box and takes no row of its own.
  const label = content.querySelector<HTMLElement>('.orm-popup-label');
  const actions = el('span', 'orm-popup-actions');
  if (label) {
    label.classList.add('orm-popup-label-with-actions');
    label.appendChild(actions);
  } else {
    const title = content.querySelector('.orm-popup-title');
    (title?.parentNode ?? content).insertBefore(actions, title?.nextSibling ?? null);
  }
  const button = el('button', 'orm-popup-action', actions);
  button.type = 'button';
  button.title = 'cr' in request ? 'Trains from the China Railway timetable' : 'Departures from Yahoo!乗換案内';
  button.innerHTML = CLOCK_ICON;
  el('span', undefined, button).textContent = 'Timetable';
  button.addEventListener('click', () =>
    button.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { bubbles: true, detail: request })),
  );
}

export function installTimetable(map: TimetableMap, route: TrainRouteDrawer | null = null) {
  const container = map.getContainer();
  const panel = new TimetablePanel(map, route);
  container.addEventListener(TIMETABLE_OPEN_EVENT, (event) => {
    const request = (event as CustomEvent<TimetableRequest>).detail;
    if (request?.name || ('codes' in request && request.codes.length)) panel.open(request);
  });
  container.addEventListener(UI_PANEL_OPEN_EVENT, (event) => {
    if (isOtherUiPanelOpen(event, 'timetable')) panel.close();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.isOpen && !(event.target instanceof HTMLInputElement)) panel.close();
  });
  return panel;
}
