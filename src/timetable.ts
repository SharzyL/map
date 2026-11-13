// Station timetables from the norikae API (norikae.ts), in a panel opened by
// the Timetable button (timetableButton) of a station's info box through
// TIMETABLE_OPEN_EVENT on the map container.
//
// Japan (Yahoo! 乗換案内): a station's lines and directions, then one
// direction's departures for a day type, then the stops of one train.
// Stations carry their Yahoo station codes as `yahoo_codes` (from
// scripts/tiles/jp-station-codes.py); a stop of a train opened from the panel
// may be looked up by name, and a name Yahoo knows as several stations
// (府中(東京都), 府中(広島県)) lists each station's lines under its Yahoo name.
//
// China Railway: every train stopping at a station on a date, then the stops
// of one train. The API finds the station by its OSM elements, else by name.
//
// A train's view draws its route on the map (train-route.ts) and gives each
// stop the API placed on OSM a button that flies the map there; pointing at a
// stop marks it on the map.
import { createPanelShell, el } from './map-panel.js';
import {
  addDays,
  chinaNow,
  crStationTimetable,
  crTrain,
  crTrainRoute,
  departures,
  findStationsByName,
  japanNow,
  minutesOf,
  NorikaeError,
  stationLines,
  trainRoute,
  trainStops,
  type CrStationTimetable,
  type Departure,
  type DepartureTable,
  type TrainRoute,
  type TimetableDay,
} from './norikae.js';
import { hoverStopOnMap } from './route-highlight.js';
import type { TrainRouteDrawer } from './train-route.js';
import { emitUiPanelOpen, isOtherUiPanelOpen, UI_PANEL_OPEN_EVENT } from './ui-panels.js';

export const TIMETABLE_OPEN_EVENT = 'orm:timetable';
// Yahoo station codes, or China Railway stations to try in turn (OSM elements
// "N1,W2", then the name).
type YahooRequest = { name: string; codes: string[] };
export type TimetableRequest = YahooRequest | { name: string; cr: string[] };
type Source = { text: string; href?: string };

const DAY_LABELS: Record<TimetableDay, string> = {
  weekday: 'Weekday',
  saturday: 'Saturday',
  holiday: 'Sunday & holiday',
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
  private readonly _nav: HTMLElement;
  private readonly _body: HTMLElement;
  private readonly _source: HTMLAnchorElement;
  private readonly _map: TimetableMap;
  private readonly _route: TrainRouteDrawer | null;
  private _abort: AbortController | null = null;
  private _history: View[] = [];
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
      'cr' in request ? this._renderCrStation(request.cr, request.name, null) : this._renderLines(request),
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
      status.textContent = `Could not load the timetable: ${error instanceof Error ? error.message : String(error)}`;
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

  // Draws a train's route once the API has it, unless the view changed meanwhile;
  // a route the API cannot give (an error, a train not routed yet) is left out.
  private _drawRoute(load: Promise<TrainRoute>, here: string | null) {
    const signal = this._signal;
    if (!this._route) return;
    load
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
      .catch(() => {});
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
    this._setHeader(stationName, `${table.line} → ${table.direction}`, yahooSource(table.source_url));
    this._setBack('Lines');
    this._body.replaceChildren();

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
    this._setHeader(stationName, [train.name, train.line].filter(Boolean).join(' · '), yahooSource(train.source_url));
    this._setBack('Departures');
    this._body.replaceChildren();
    this._facts([
      ['Train', train.name],
      ['Line', train.line],
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
    this._drawRoute(trainRoute(code, gid, trainId, this._signal), here);
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
    const days = el('div', 'timetable-days', this._body);
    days.setAttribute('role', 'group');
    days.setAttribute('aria-label', 'Date');
    const dayButton = (label: string, title: string, target: string) => {
      const button = el('button', 'timetable-day', days);
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      button.addEventListener('click', () => {
        // Replace this view rather than stacking date switches on the back button.
        this._history.pop();
        this._show(() => this._renderCrStation([station], station, target));
      });
    };
    dayButton('‹', 'Previous day', addDays(table.date, -1));
    el('span', 'timetable-date', days).textContent = crDateLabel(table.date);
    dayButton('›', 'Next day', addDays(table.date, 1));
    if (table.date !== today) dayButton('Today', 'Today in China', today);

    if (table.trains.length === 0) {
      el('div', 'timetable-status', this._body).textContent = 'No trains.';
      return;
    }
    const list = el('ol', 'timetable-departures timetable-cr-trains', this._body);
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
      el('span', 'timetable-kind timetable-train-number', button).textContent = train.train;
      el('span', 'timetable-destination', button).textContent = `${train.origin} → ${train.destination}`;
      el('span', 'timetable-platform', button).textContent = train.platform ?? '';
      if (train.platform) button.title = `Platform or gate ${train.platform}`;
      // The train's own date is the day it left its origin.
      button.addEventListener('click', () =>
        this._show(() => this._renderCrTrain(train.train, addDays(table.date, 1 - train.day), station)),
      );
    });
    if (next >= 0) list.querySelector('.timetable-next')?.scrollIntoView?.({ block: 'center' });
  }

  private async _renderCrTrain(train: string, date: string, stationName: string) {
    const signal = this._signal;
    const schedule = await crTrain(train, date, signal);
    if (signal.aborted) return;
    // A number can have several service periods; take the one running on the date.
    const run =
      schedule.trains.find((it) => it.runs) ?? schedule.trains.find((it) => it.train === train) ?? schedule.trains[0];
    const stops = run?.stops ?? [];
    const route = stops.length ? `${stops[0].name} → ${stops[stops.length - 1].name}` : '';
    this._setHeader(
      stationName,
      [run?.train ?? train, route].filter(Boolean).join(' · '),
      crSource(schedule.data_version),
    );
    this._setBack('Trains');
    this._body.replaceChildren();
    const last = stops[stops.length - 1];
    this._facts([
      ['Train', run?.train ?? train],
      ['Departs', `${crDateLabel(date)} from ${stops[0]?.name ?? '?'}`],
      ['In service', run ? `${run.service.from} – ${run.service.to ?? 'until further notice'}` : null],
      ['Distance', last ? `${last.km} km` : null],
      ['Stops', String(stops.length)],
    ]);
    if (run && !run.runs)
      el('p', 'timetable-comment', this._body).textContent = `Does not leave its origin on ${date}.`;
    const list = el('ol', 'timetable-stops', this._body);
    for (const stop of stops) {
      const item = el('li', 'timetable-stop', list);
      if (stop.name === stationName) item.classList.add('timetable-stop-here');
      const name = el('button', 'timetable-stop-name', item);
      name.type = 'button';
      name.textContent = stop.name;
      name.title = `Timetable at ${stop.name}`;
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
      if (stop.platform) item.title = `Platform or gate ${stop.platform}`;
      this._locate(item, stop.name, stop.position);
    }
    list.querySelector('.timetable-stop-here')?.scrollIntoView?.({ block: 'center' });
    this._drawRoute(crTrainRoute(run?.train ?? train, date, this._signal), stationName);
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
