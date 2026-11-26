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
import { beginLoading } from './load-status.js';
import { createPanelShell, el, retryButton } from './map-panel.js';
import { setTooltip } from './tooltip.js';
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
  stationStatus,
  directionStatus,
  type DirectionStatus,
  type ServiceNotice,
  trainRoute,
  trainStops,
  type CrLine,
  type CrRollingStock,
  type CrStationTimetable,
  type CrStationTrain,
  type CrTrainset,
  type Departure,
  type DepartureTable,
  type StationLines,
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
// China Railway's 横列表示, remembered apart from Yahoo's ヨコ表示
export const TIMETABLE_CR_PRINTED_STORAGE_KEY = 'atlas-realm:timetable-cr-printed';
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

// A service notice's weight, for its color: a suspension (運転見合わせ, which
// Yahoo may file under その他 and say only in the message), a delay, service
// back to normal, or anything else.
type NoticeSeverity = 'stop' | 'delay' | 'normal' | 'info';
export function noticeSeverity({ status, message }: ServiceNotice): NoticeSeverity {
  const text = `${status} ${message}`;
  if (/見合わせ|運休|運転中止|不通/.test(text)) return 'stop';
  if (/遅延|遅れ/.test(text)) return 'delay';
  if (/再開|平常/.test(text)) return 'normal';
  return 'info';
}
const SEVERITY_LABELS: Record<NoticeSeverity, string> = {
  stop: '運転見合わせ',
  delay: '遅延',
  normal: '運転再開',
  info: '運行情報',
};
const SEVERITY_ORDER: NoticeSeverity[] = ['stop', 'delay', 'info', 'normal'];
// The weightiest of a line's notices; a line flagged without one is 'info'.
const worstSeverity = (notices: ServiceNotice[]) =>
  SEVERITY_ORDER.find((severity) => notices.some((notice) => noticeSeverity(notice) === severity)) ?? 'info';

// When a notice was updated: the time today in Japan, else the date too.
export function noticeUpdated(updated: string | null, now = new Date()) {
  if (!updated) return null;
  const [date, time] = updated.split(' ');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
  const [, month, day] = date.split('-').map(Number);
  return `${date === today ? '' : `${month}/${day} `}${time}更新`;
}

// A direction's notices, a box each, with the line's page on Yahoo.
function noticeBoxes(status: DirectionStatus) {
  const boxes = el('div', 'timetable-notices');
  for (const notice of status.notices) {
    const box = el('div', 'timetable-notice', boxes);
    box.dataset.severity = noticeSeverity(notice);
    const head = el('div', 'timetable-notice-head', box);
    el('span', 'timetable-notice-status', head).textContent = [notice.status, notice.cause].filter(Boolean).join(' · ');
    const updated = noticeUpdated(notice.updated);
    if (updated) el('span', 'timetable-notice-updated', head).textContent = updated;
    el('p', 'timetable-notice-message', box).textContent = notice.message;
    if (notice.range) el('div', 'timetable-notice-range', box).textContent = notice.range;
    if (status.url) {
      const link = el('a', 'timetable-notice-link', box);
      link.href = status.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '運行情報の詳細';
    }
  }
  return boxes;
}

// High-speed rail, drawn in the map's high-speed purple: in Japan a 新幹線
// line; in China a G train. (D and C trains run on high-speed and
// conventional lines alike, and nothing in the timetable tells them apart.)
export const isHighSpeedLine = (name: string) => name.includes('新幹線');
export const isHighSpeedTrain = (train: string) => train.startsWith('G');
// What an error report from a view starts with: its issue's title, and what
// it is about, a line each.
type Report = { title: string; details: string[] };

const ISSUES = 'https://github.com/SharzyL/map/issues/new';

// A new issue on the map's repository about what a view shows, its body a
// template to fill in, with where it was found: the view's details, the map
// as it was (`map`, the page's address, which keeps the view), the data.
export function reportUrl(report: Report, map: string) {
  const body = [
    '**What is wrong**',
    '',
    '<!-- What the timetable or the map shows, and what it should show -->',
    '',
    '**Where**',
    '',
    ...report.details.map((detail) => `- ${detail}`),
    `- Map: ${map}`,
    '',
  ].join('\n');
  return `${ISSUES}?${new URLSearchParams({ title: report.title, body })}`;
}
const sourceDetail = (source: Source | null) =>
  source && `Data: ${source.text}${source.href ? ` (${source.href})` : ''}`;

// The panel speaks the language of the timetable it shows: Japanese for
// Yahoo's, Chinese for China Railway's. What every view says, in each.
type Lang = 'ja' | 'zh';
const UI = {
  ja: {
    loading: '読み込み中…',
    loadFailed: '時刻表を読み込めませんでした。',
    back: '戻る',
    retry: '再試行',
    routeNotYet: '走行経路はまだ用意されていません。',
    routeFailed: '走行経路を読み込めませんでした。',
    showOnMap: (name: string) => `${name}を地図に表示`,
    timetableAt: (name: string) => `${name}の時刻表`,
    daysAfter: (days: number) => `始発駅を出て${days === 1 ? '翌日' : `${days}日後`}`,
  },
  zh: {
    loading: '加载中…',
    loadFailed: '无法加载时刻表。',
    back: '返回',
    retry: '重试',
    routeNotYet: '暂无运行路径。',
    routeFailed: '无法加载运行路径。',
    showOnMap: (name: string) => `在地图上显示${name}`,
    timetableAt: (name: string) => `${name}站时刻表`,
    daysAfter: (days: number) => `始发后${days === 1 ? '次日' : `第${days + 1}天`}`,
  },
};

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
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const crDateLabel = (date: string) => `${date} ${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;

type TimetableMap = {
  getContainer(): HTMLElement;
  flyTo?(options: { center: [number, number]; zoom: number }): unknown;
  getZoom?(): number;
};
// What the panel shows, as a link can say it (encodeTimetableView): a Yahoo
// station's lines, a direction's departures (`day` null for today's) and a
// train opened from them (with the departure's row when opened from it), a
// China Railway station on a day (`candidates` tried in turn) and a train
// by the day it leaves its origin, from the station it was opened at.
export type TimetableView =
  | { kind: 'jp-lines'; name: string; codes: string[] }
  | { kind: 'jp-departures'; code: string; gid: string; station: string; day: TimetableDay | null }
  | { kind: 'jp-train'; code: string; gid: string; train: string; station: string; departure?: Departure | null }
  | { kind: 'cr-station'; candidates: string[]; name: string; date: string | null }
  | { kind: 'cr-train'; train: string; date: string; station: string | null };

const langOf = (view: TimetableView): Lang => (view.kind.startsWith('jp') ? 'ja' : 'zh');

// A view as the URL's `tt` key holds it: its kind and parts, joined by ':'
// (jpl:22741,29342:新宿, jpd:22715:1051:渋谷, jpt:22715:1051:33471:渋谷,
// crs:北京西:2026-11-26, crt:G301:2026-11-26:北京西). Names with a ':' or a
// character the hash cannot hold have no link.
export function encodeTimetableView(view: TimetableView): string | null {
  const parts = (() => {
    switch (view.kind) {
      case 'jp-lines':
        return ['jpl', view.codes.join(','), view.name];
      case 'jp-departures':
        return ['jpd', view.code, view.gid, view.station, view.day ?? ''];
      case 'jp-train':
        return ['jpt', view.code, view.gid, view.train, view.station];
      case 'cr-station':
        return ['crs', view.name, view.date ?? ''];
      case 'cr-train':
        return ['crt', view.train, view.date, view.station ?? ''];
    }
  })();
  if (parts.some((part) => /[:&=#%]/.test(part))) return null;
  return parts.join(':').replace(/:+$/, '');
}

const DAYS = new Set<string>(['weekday', 'saturday', 'holiday']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;

export function decodeTimetableView(text: string | null): TimetableView | null {
  const [kind, ...parts] = (text ?? '').split(':');
  const [a = '', b = '', c = '', d = ''] = parts;
  switch (kind) {
    case 'jpl': {
      const codes = a ? a.split(',') : [];
      if (!codes.every((code) => DIGITS.test(code)) || (!codes.length && !b)) return null;
      return { kind: 'jp-lines', codes, name: b };
    }
    case 'jpd':
      if (!DIGITS.test(a) || !DIGITS.test(b)) return null;
      return { kind: 'jp-departures', code: a, gid: b, station: c, day: DAYS.has(d) ? (d as TimetableDay) : null };
    case 'jpt':
      if (!DIGITS.test(a) || !DIGITS.test(b) || !DIGITS.test(c)) return null;
      return { kind: 'jp-train', code: a, gid: b, train: c, station: d };
    case 'crs':
      if (!a || (b && !DATE.test(b))) return null;
      return { kind: 'cr-station', candidates: [a], name: a, date: b || null };
    case 'crt':
      if (!a || !DATE.test(b)) return null;
      return { kind: 'cr-train', train: a, date: b, station: c || null };
    default:
      return null;
  }
}

// The views a view is reached through, for the back button of one opened
// from a link: a train's departures and its station's lines.
export function timetableViewParents(view: TimetableView): TimetableView[] {
  if (view.kind === 'jp-departures') return [{ kind: 'jp-lines', name: view.station, codes: [view.code] }];
  if (view.kind === 'jp-train') {
    const departures: TimetableView = {
      kind: 'jp-departures',
      code: view.code,
      gid: view.gid,
      station: view.station,
      day: null,
    };
    return [...timetableViewParents(departures), departures];
  }
  return [];
}

function serviceMinutes(time: string) {
  const minutes = minutesOf(time);
  return minutes < SERVICE_DAY_START ? minutes + 24 * 60 : minutes;
}

// The China Railway train to highlight: the next one, when the table is today's.
export function nextCrTrainIndex(table: Pick<CrStationTimetable, 'date' | 'trains'>, now = chinaNow()) {
  if (table.date !== now.date) return -1;
  return table.trains.findIndex(({ arrival, departure }) => minutesOf(departure ?? arrival ?? '00:00') >= now.minutes);
}

// A China Railway train's class by its number, as the printed timetable
// marks it: a character of the class's name for the letters standing for one
// (高 for G, 特 for T, 快 for K), the letter itself for the 2026 numbering
// rules' Z, N and V (《列车车次编排规定》, from 2026-11-25), which are read as
// English letters and stand for top speeds, not names; for a number without
// a letter, 普 (普通旅客快车, 1001–5998) or 慢 (普通旅客慢车, 6001 on).
// `letter` is the number's, null without one.
export type CrTrainClass = { mark: string; letter: string | null; name: string };
const CR_TRAIN_CLASSES: Record<string, Omit<CrTrainClass, 'letter'>> = {
  G: { mark: '高', name: '高速动车组' },
  D: { mark: '动', name: '动车组' },
  C: { mark: '城', name: '城际动车组' },
  Z: { mark: 'Z', name: '快速（160 km/h）' },
  T: { mark: '特', name: '特快' },
  N: { mark: 'N', name: '快速（140 km/h）' },
  K: { mark: '快', name: '快速' },
  V: { mark: 'V', name: '普速（120 km/h）' },
  S: { mark: '市', name: '市域（市郊）' },
  Y: { mark: '游', name: '旅游列车' },
  L: { mark: '临', name: '临客' },
};
export function crTrainClass(number: string): CrTrainClass {
  const letter = number.charAt(0).toUpperCase();
  if (/[0-9]/.test(letter)) {
    const value = Number.parseInt(number, 10);
    return value < 6000 ? { mark: '普', letter: null, name: '普快' } : { mark: '慢', letter: null, name: '普客' };
  }
  return { letter, ...(CR_TRAIN_CLASSES[letter] ?? { mark: letter, name: `${letter}字头` }) };
}

// A class as a minute's tooltip names it: with its letter where its mark is not it.
export const crTrainClassName = ({ mark, letter, name }: CrTrainClass) =>
  letter && letter !== mark ? `${name}（${letter}）` : name;

// The city a destination is in, as a printed timetable names it: the name
// without 站 and without a last 东/西/南/北 (郑州东, 兰州西), kept whole
// where that would leave one character (西安).
export function crDestinationCity(name: string) {
  const bare = name.replace(/站$/, '');
  return bare.length > 2 ? bare.replace(/[东西南北]$/, '') : bare;
}

// One character for each destination city of a printed timetable (its
// stations share it: 郑州东 and 郑州, and a name going on from another's city,
// 郑州航空港), the busiest city choosing first: its first character if still
// free, else one the other cities' names lack (长春 beside 长沙 takes 春),
// else any other of its own; a circled number when none is left. By
// destination, with the cities' marks and stations for the legend.
export function crDestinationMarks(destinations: string[]) {
  const counts = new Map<string, number>();
  for (const destination of destinations) counts.set(destination, (counts.get(destination) ?? 0) + 1);
  // Each destination's city: its own, or a shorter city its name starts with.
  const ownCities = [...new Set([...counts.keys()].map(crDestinationCity))].sort((a, b) => a.length - b.length);
  const cityOf = (destination: string) => {
    const own = crDestinationCity(destination);
    return ownCities.find((city) => city.length >= 2 && destination.startsWith(city)) ?? own;
  };
  const cities = new Map<string, { count: number; stations: string[] }>();
  for (const [destination, count] of counts) {
    const city = cities.get(cityOf(destination)) ?? { count: 0, stations: [] };
    city.count += count;
    city.stations.push(destination);
    cities.set(cityOf(destination), city);
  }
  const names = [...cities.keys()].sort((a, b) => cities.get(b).count - cities.get(a).count || a.localeCompare(b));
  const characters = (name: string) => [...new Set(Array.from(name))];
  const used = new Set<string>();
  const legend: Array<{ mark: string; stations: string[] }> = [];
  const marks = new Map<string, string>();
  let spare = 0;
  for (const name of names) {
    const own = characters(name);
    const others = new Set(names.filter((other) => other !== name).flatMap(characters));
    const candidates = [own[0], ...own.filter((character) => !others.has(character)), ...own];
    let mark = candidates.find((character) => character && !used.has(character));
    while (!mark) {
      const circled = String.fromCharCode(0x2460 + spare++);
      if (!used.has(circled)) mark = circled;
    }
    used.add(mark);
    const stations = cities.get(name).stations.sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
    legend.push({ mark, stations });
    for (const station of stations) marks.set(station, mark);
  }
  return { marks, legend };
}

// A China Railway station's tabs, in two rows: the lines its trains take
// here, the busiest first, then "Other" for the trains the data names no line
// for; and their directions, 下行 before 上行. Each tab with its train count.
const OTHER_LINE = '其他';
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

// A train's stop times as Yahoo gives them count the hours of its later days
// on from 24 (33:47 is 09:47 the next morning): the time on the clock, and how
// many days after `start` (the hour count of its first stop) it falls.
export function trainStopClock(time: string | null, start: number) {
  if (!time) return null;
  const hours = Number(time.slice(0, 2));
  if (!Number.isFinite(hours)) return { time, days: 0 };
  return {
    time: `${String(hours % 24).padStart(2, '0')}${time.slice(2)}`,
    days: Math.floor(hours / 24) - Math.floor(start / 24),
  };
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

// What the timetable says a train runs with: "CR400BF-S 重联 · 上局上海段".
export function rollingStockLabel(stock: CrRollingStock | null | undefined) {
  if (!stock) return null;
  const sets = stock.model ? `${stock.model}${stock.coupled ? ' 重联' : ''}` : stock.coupled ? '两组重联' : null;
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

// The trainset 12306 assigns: "CR400BF-A-5053 · 16辆编组".
export function trainsetLabel(trainset: NonNullable<CrTrainset['trainset']>) {
  return [trainset.id, trainset.cars && `${trainset.cars}辆编组`].filter(Boolean).join(' · ');
}

// Everything a Yahoo departure is known by, for its row's and its minute's
// tooltip: when, what and where to; then its number, its type where the name
// is a service's (特急わかしお1号), cars and Green Car, starting here, the
// track, and whether it runs on certain days only.
export function departureTooltip(departure: Departure) {
  const name = departure.name ?? departure.kind ?? '';
  return [
    `${departure.time} ${name} ${departure.destination ?? '?'}行`,
    departure.train_number && `列車番号 ${departure.train_number}`,
    departure.kind && departure.kind !== name && `種別 ${departure.kind}`,
    [departure.cars && `${departure.cars}両`, departure.green_car && 'グリーン車'].filter(Boolean).join(' · '),
    departure.starts_here && '当駅始発',
    departure.track && `${departure.track}番線`,
    departure.extra && '運転日注意',
  ]
    .filter(Boolean)
    .join('\n');
}

// Everything a China Railway train at a station is known by, for its row's
// and its minute's tooltip: when, its number here and its route; its class,
// its whole number where it changes, when it arrives and leaves (and how
// long it stands), or that it starts or ends here; the lines it comes and
// goes on with its direction, the platform or gate, and the day of its run.
export function crTrainTooltip(train: CrStationTrain) {
  const number = train.departure_number ?? train.arrival_number ?? train.train;
  const time = train.departure ?? train.arrival ?? '';
  const stands =
    train.arrival && train.departure ? (minutesOf(train.departure) - minutesOf(train.arrival) + 1440) % 1440 : null;
  const lines =
    train.line_in && train.line_out && train.line_in !== train.line_out
      ? `${train.line_in}→${train.line_out}`
      : (train.line ?? train.line_out ?? train.line_in);
  return [
    `${time} ${number} ${train.origin} → ${train.destination}`,
    crTrainClassName(crTrainClass(number)),
    number !== train.train && `全程车次 ${train.train}`,
    !train.arrival
      ? '本站始发'
      : !train.departure
        ? `${train.arrival} 终到`
        : `${train.arrival} 到 · ${train.departure} 开（停 ${stands} 分）`,
    [lines, train.bound].filter(Boolean).join(' '),
    train.platform && `站台/检票口 ${train.platform}`,
    train.day > 1 && UI.zh.daysAfter(train.day - 1),
  ]
    .filter(Boolean)
    .join('\n');
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
function routeMissingText(error: unknown, lang: Lang) {
  if (error instanceof NorikaeError && error.status === 404) return UI[lang].routeNotYet;
  return UI[lang].routeFailed;
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
  private readonly _footer: HTMLElement;
  private readonly _report: HTMLAnchorElement;
  private _reported: Report | null = null;
  private readonly _map: TimetableMap;
  private readonly _route: TrainRouteDrawer | null;
  private _abort: AbortController | null = null;
  private _history: TimetableView[] = [];
  // Told the view shown, null once closed: the URL keeps it (main.ts).
  private readonly _onView: (view: TimetableView | null) => void;
  private _lang: Lang = 'ja';
  // The line and direction tabs picked at a China Railway station, kept across its days.
  private _crFilter: { station: string; line: string | null; bound: string | null } | null = null;
  // The Yahoo station picked among those of one station's lines view
  // (新宿 and 新宿(東京メトロ)), kept while going to its departures and back.
  private _jpPick: { name: string; code: string } | null = null;
  private _open = false;

  constructor(
    map: TimetableMap,
    route: TrainRouteDrawer | null,
    onView: (view: TimetableView | null) => void = () => {},
  ) {
    const container = map.getContainer();
    this._onView = onView;
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
    // The data's source, and a link to report an error in what the view shows.
    this._footer = el('div', 'timetable-footer', this.panel);
    this._footer.hidden = true;
    this._source = el('a', 'timetable-source', this._footer);
    this._source.target = '_blank';
    this._source.rel = 'noopener noreferrer';
    this._report = el('a', 'timetable-report', this._footer);
    this._report.target = '_blank';
    this._report.rel = 'noopener noreferrer';
    // The map's address only now, as it is when the link is followed.
    this._report.addEventListener('click', () => {
      if (this._reported) this._report.href = reportUrl(this._reported, window.location.href);
    });
    this.panel.inert = true;
  }

  get isOpen() {
    return this._open;
  }

  open(request: TimetableRequest) {
    this.openView(
      'crTrain' in request
        ? { kind: 'cr-train', train: request.crTrain, date: request.date, station: null }
        : 'cr' in request
          ? { kind: 'cr-station', candidates: request.cr, name: request.name, date: null }
          : { kind: 'jp-lines', name: request.name, codes: request.codes },
    );
  }

  // Opens a view, as a link names it, with the views it is reached through
  // behind the back button.
  openView(view: TimetableView, parents: TimetableView[] = []) {
    this._open = true;
    emitUiPanelOpen(this._container, 'timetable');
    this.panel.classList.add('timetable-panel-visible');
    this.panel.setAttribute('aria-hidden', 'false');
    this.panel.inert = false;
    this._history = [...parents];
    this._show(view);
  }

  close() {
    if (this._open) this._onView(null);
    this._open = false;
    this._abort?.abort();
    this._route?.clear();
    this.panel.classList.remove('timetable-panel-visible');
    this.panel.setAttribute('aria-hidden', 'true');
    this.panel.inert = true;
  }

  // Shows a view and remembers it for the back button.
  private _show(view: TimetableView) {
    this._history.push(view);
    this._run(view);
  }

  // The view shown, said more exactly once loaded (the station found, the
  // day shown), for the link; shown as it is.
  private _settle(view: TimetableView) {
    if (!this._open) return;
    this._history[this._history.length - 1] = view;
    this._onView(view);
  }

  private _render(view: TimetableView) {
    switch (view.kind) {
      case 'jp-lines':
        return this._renderLines({ name: view.name, codes: view.codes });
      case 'jp-departures':
        return this._renderDepartures(view.code, view.gid, view.station, view.day);
      case 'jp-train':
        return this._renderTrain(view.code, view.gid, view.train, view.station, view.departure ?? null);
      case 'cr-station':
        return this._renderCrStation(view.candidates, view.name, view.date);
      case 'cr-train':
        return this._renderCrTrain(view.train, view.date, view.station);
    }
  }

  private _back() {
    if (this._history.length < 2) return;
    this._history.pop();
    this._run(this._history[this._history.length - 1]);
  }

  private get _ui() {
    return UI[this._lang];
  }

  private _run(view: TimetableView) {
    this._lang = langOf(view);
    this._onView(view);
    // A view sets its own source and report link; none while it loads.
    this._footer.hidden = true;
    this._reported = null;
    this._abort?.abort();
    this._abort = new AbortController();
    const signal = this._abort.signal;
    // Only a train's view shows its route.
    this._route?.clear();
    this._setBack();
    this._body.replaceChildren(el('div', 'timetable-status'));
    this._body.firstElementChild.textContent = this._ui.loading;
    this._render(view).catch((error: unknown) => {
      if (signal.aborted) return;
      this._setBack();
      this._body.replaceChildren();
      const status = el('div', 'timetable-status timetable-error', this._body);
      const message = el('span', 'timetable-error-message', status);
      message.textContent = this._ui.loadFailed;
      setTooltip(message, errorDetail(error));
      if (isRetryable(error)) retryButton(status, () => this._run(view), this._ui.retry);
    });
  }

  private get _signal() {
    return this._abort.signal;
  }

  private _setBack(label = this._ui.back) {
    this._nav.replaceChildren();
    this._nav.classList.remove('timetable-nav-joined');
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
    if (title) setTooltip(toggle, title);
    input.addEventListener('change', () => writeStoredSettings(storageKey, input.checked));
    this._nav.hidden = false;
    return input;
  }

  // Draws a train's route once the API has it, unless the view changed meanwhile;
  // for a route the API cannot give (an error, a train not routed yet) a note
  // above the stops says why it is not on the map.
  // The load status chip says "Loading route…" meanwhile (load-status.ts).
  // Until the route comes, the stops joined in order stand in for it (and
  // stay, dashed, should it fail); `stops` in their order, with their positions.
  private _drawRoute(
    load: () => Promise<TrainRoute>,
    here: string | null,
    stops: Array<{ name: string; position: [number, number] | null; elements?: string[] | null }>,
  ) {
    const signal = this._signal;
    if (!this._route) return;
    this._route.sketch(stops, here, this._routePadding());
    const done = beginLoading(this._container, 'train-route', 'route');
    load()
      .then((route) => {
        if (signal.aborted) return;
        this._route.show(route, here, this._routePadding());
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        this._route.unrouted();
        const note = el('p', 'timetable-comment timetable-route-missing');
        const message = el('span', undefined, note);
        message.textContent = routeMissingText(error, this._lang);
        setTooltip(message, errorDetail(error));
        if (isRetryable(error))
          retryButton(
            note,
            () => {
              note.remove();
              this._drawRoute(load, here, stops);
            },
            this._ui.retry,
          );
        this._body.insertBefore(note, this._body.querySelector('.timetable-stops'));
      })
      .finally(done);
  }

  // The map's room for a route clear of the panel: beside it on a wide screen,
  // above the bottom sheet on a phone.
  private _routePadding() {
    const map = this._container.getBoundingClientRect();
    const panel = this.panel.getBoundingClientRect();
    const margin = 48;
    return panel.width < map.width * 0.6
      ? { top: margin + 16, right: margin + 40, bottom: margin, left: panel.right - map.left + margin }
      : { top: margin + 16, right: margin, bottom: map.bottom - panel.top + margin, left: margin };
  }

  // The trainset 12306 assigns, asked once the train shows. It replaces the
  // rolling stock the timetable plans (`planned`, its row and note), which
  // often names another model; a train 12306 has none for (not an EMU), or
  // no answer, keeps the timetable's.
  private _trainset(facts: HTMLElement, train: string, date: string, planned: Element[]) {
    const signal = this._signal;
    const term = el('dt', undefined, facts);
    term.textContent = '担当车底';
    const value = el('dd', 'timetable-trainset', facts);
    const ask = () => {
      value.classList.remove('timetable-unavailable');
      value.textContent = UI.zh.loading;
      crTrainset(train, date, signal)
        .then(({ trainset }) => answer(trainset))
        .catch((error: unknown) => {
          if (signal.aborted) return;
          value.replaceChildren();
          value.classList.add('timetable-unavailable');
          const message = el('span', undefined, value);
          message.textContent = '无法加载车底信息';
          setTooltip(message, errorDetail(error));
          if (isRetryable(error)) retryButton(value, ask, UI.zh.retry);
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
      setTooltip(value, '12306 当日所配车底');
      if (!trainset.details.length && !trainset.coaches.length) return;
      const more = el('details', 'timetable-coaches', value);
      el('summary', undefined, more).textContent = '车厢';
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
    setTooltip(button, this._ui.showOnMap(name));
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

  // The view's title and summary, and in its footer the data's source and
  // what an error report from it is about.
  private _setHeader(title: string, summary: string, source: Source | null, report: Report | null = null) {
    this._title.textContent = title;
    this._summary.textContent = summary;
    this._source.hidden = !source;
    if (source) {
      this._source.textContent = source.text;
      if (source.href) this._source.href = source.href;
      else this._source.removeAttribute('href');
    }
    this._reported = report && { ...report, details: [...report.details, sourceDetail(source)].filter(Boolean) };
    this._report.hidden = !report;
    if (this._reported) {
      this._report.textContent = 'Report error';
      setTooltip(this._report, 'Report an error in this timetable or route on GitHub');
      this._report.href = reportUrl(this._reported, window.location.href);
    }
    this._footer.hidden = !source && !report;
  }

  private async _renderLines(request: YahooRequest) {
    const signal = this._signal;
    this._setHeader(request.name, '路線', null);
    const stations = request.codes.length
      ? request.codes.map((code) => ({ code, name: null as string | null }))
      : (await findStationsByName(request.name, signal)).map(({ code, name }) => ({ code, name }));
    if (signal.aborted) return;
    if (stations.length === 0) {
      this._setBack();
      this._body.replaceChildren();
      el('div', 'timetable-status', this._body).textContent = `${request.name}の時刻表は見つかりませんでした。`;
      return;
    }
    const tables = await Promise.all(stations.map(({ code }) => stationLines(code, signal)));
    if (signal.aborted) return;
    // Found by name: the link names its stations' codes.
    const name = request.name || tables[0].station.name;
    this._settle({ kind: 'jp-lines', name, codes: tables.map((table) => table.station.code) });
    this._setBack();
    // A station Yahoo lists as several (新宿 and 新宿(東京メトロ)) shows one at
    // a time, picked in a row of tabs in the back row, as China Railway's lines.
    const kept = this._jpPick?.name === name ? this._jpPick.code : null;
    let picked = tables.find((table) => table.station.code === kept) ?? tables[0];
    const row = tables.length > 1 ? this._navGroup('駅') : null;
    row?.classList.add('timetable-directions');
    // The tabs head the list they pick, with no rule between.
    this._nav.classList.toggle('timetable-nav-joined', !!row);
    const tabs = row
      ? tables.map((table) => {
          const button = el('button', 'timetable-day', row);
          button.type = 'button';
          button.textContent = table.station.name;
          button.addEventListener('click', () => {
            picked = table;
            this._jpPick = { name, code: table.station.code };
            show();
          });
          return { table, button };
        })
      : [];
    const show = () => {
      for (const { table, button } of tabs) button.setAttribute('aria-pressed', String(table === picked));
      this._renderStationLines(name, picked);
    };
    show();
  }

  private _renderStationLines(name: string, table: StationLines) {
    this._body.replaceChildren();
    const badgeSlots = new Map<string, { slot: HTMLElement; gid: string | null }>();
    this._setHeader(name, '路線', yahooSource(table.source_url), {
      title: `Timetable error at ${table.station.name}`,
      details: [`Station: ${table.station.name} (Yahoo code ${table.station.code})`],
    });
    const section = el('section', 'timetable-station', this._body);
    if (table.lines.length === 0) el('div', 'timetable-status', section).textContent = '路線がありません。';
    for (const line of table.lines) {
      const group = el('div', 'timetable-line', section);
      const lineName = el('div', 'timetable-line-name', group);
      lineName.textContent = line.name;
      if (isHighSpeedLine(line.name)) lineName.classList.add('timetable-highspeed');
      badgeSlots.set(line.name, { slot: lineName, gid: line.directions[0]?.gid ?? null });
      for (const { direction, gid } of line.directions) {
        const button = el('button', 'timetable-direction', group);
        button.type = 'button';
        // A 新幹線's directions in its name's purple
        if (isHighSpeedLine(line.name)) button.classList.add('timetable-highspeed');
        button.textContent = directionLabel(direction);
        button.addEventListener('click', () =>
          this._show({
            kind: 'jp-departures',
            code: table.station.code,
            gid,
            station: table.station.name,
            day: null,
          }),
        );
      }
    }
    // A badge by each line with a service notice, once they come (a station's
    // other tab, picked meanwhile, has its own). The station's page only flags
    // some lines (a suspension among them), whose notices their direction's
    // page has.
    const signal = this._signal;
    const label = (badge: HTMLElement, notices: ServiceNotice[]) => {
      const severity = worstSeverity(notices);
      badge.dataset.severity = severity;
      badge.textContent = SEVERITY_LABELS[severity];
      setTooltip(badge, notices.map(({ message }) => message).join('\n') || '運行情報があります');
    };
    stationStatus(table.station.code, signal).then(
      ({ lines }) => {
        if (!section.isConnected) return;
        for (const status of lines) {
          const line = badgeSlots.get(status.line);
          if (!line) continue;
          const badge = el('span', 'timetable-notice-badge', line.slot);
          label(badge, status.notices);
          if (status.notices.length > 0 || !line.gid) continue;
          directionStatus(table.station.code, line.gid, signal).then(
            ({ notices }) => {
              if (notices.length > 0 && section.isConnected) label(badge, notices);
            },
            () => {},
          );
        }
      },
      () => {},
    );
  }

  // A direction's service notices at the top of its view, once they come;
  // nothing when it has none or they cannot be had.
  private _showNotices(code: string, gid: string) {
    const signal = this._signal;
    directionStatus(code, gid, signal).then(
      (status) => {
        if (signal.aborted || status.notices.length === 0) return;
        this._body.insertBefore(noticeBoxes(status), this._body.firstChild);
      },
      () => {},
    );
  }

  private async _renderDepartures(code: string, gid: string, named: string, day: TimetableDay | null) {
    const signal = this._signal;
    const table = await departures(code, gid, day, signal);
    if (signal.aborted) return;
    const stationName = named || table.station.name;
    if (!named) this._settle({ kind: 'jp-departures', code, gid, station: stationName, day });
    this._setHeader(stationName, `${table.line} ${directionLabel(table.direction)}`, yahooSource(table.source_url), {
      title: `Timetable error at ${stationName} (${table.line} ${directionLabel(table.direction)})`,
      details: [
        `Station: ${stationName} (Yahoo code ${code})`,
        `Line: ${table.line} ${directionLabel(table.direction)}`,
        `Day: ${DAY_LABELS[table.day as TimetableDay] ?? table.day}`,
      ],
    });
    this._setBack('路線');
    this._body.replaceChildren();
    this._showNotices(code, gid);

    const days = this._navGroup('曜日');
    for (const [value, label] of Object.entries(DAY_LABELS) as Array<[TimetableDay, string]>) {
      const button = el('button', 'timetable-day', days);
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(value === table.day));
      button.addEventListener('click', () => {
        if (value === table.day) return;
        // Replace this view rather than stacking day switches on the back button.
        this._history.pop();
        this._show({ kind: 'jp-departures', code, gid, station: stationName, day: value });
      });
    }

    if (table.departures.length === 0) {
      el('div', 'timetable-status', this._body).textContent = '発車する列車はありません。';
      return;
    }
    const next = nextDepartureIndex(table);
    const open = (departure: Departure) =>
      this._show({ kind: 'jp-train', code, gid, train: departure.train_id, station: stationName, departure });

    // A list, or the printed timetable's layout.
    const input = this._navToggle('ヨコ表示', TIMETABLE_PRINTED_STORAGE_KEY, '駅の時刻表のように時ごとに横へ並べる');

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
      setTooltip(button, departureTooltip(departure));
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
      setTooltip(button, departureTooltip(departure));
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
    for (const [mark, destination] of legend.destinations) entry(mark, `${destination}行`);
    if (table.departures.some((departure) => departure.starts_here)) entry('●', '当駅始発');
    if (table.departures.some((departure) => departure.extra)) entry('◆', '運転日注意');
    const usual = [legend.usualKind, legend.usualDestination && `${legend.usualDestination}行`].filter(Boolean);
    if (usual.length) entry('無印', usual.join(' '));

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
  private async _renderTrain(code: string, gid: string, trainId: string, named: string, row: Departure | null = null) {
    const signal = this._signal;
    // Opened from a link, without its departure's row: today's timetable
    // has it (its number, cars and track), if the train runs today.
    const [train, departure] = await Promise.all([
      trainStops(code, gid, trainId, signal),
      row
        ? row
        : departures(code, gid, null, signal).then(
            (table) => table.departures.find((candidate) => candidate.train_id === trainId) ?? null,
            (): Departure | null => null,
          ),
    ]);
    if (signal.aborted) return;
    const stationName = named || train.station?.name || '';
    const name = departure?.name ?? train.name;
    const number = departure?.train_number;
    this._setHeader(stationName, [name, train.line].filter(Boolean).join(' · '), yahooSource(train.source_url), {
      title: `Route error on train ${number ?? name}${number ? ` (${[name, train.line].filter(Boolean).join(', ')})` : ''}`,
      details: [
        `Train: ${[number, name].filter(Boolean).join(' ')}${train.line ? ` on ${train.line}` : ''}`,
        `Opened at: ${stationName} (Yahoo code ${code}, train ${trainId})`,
      ],
    });
    this._setBack('時刻表');
    this._body.replaceChildren();
    this._showNotices(code, gid);
    const cars = [departure?.cars && `${departure.cars}両`, departure?.green_car && 'グリーン車'].filter(Boolean);
    this._facts([
      ['種別', name],
      ['列車番号', departure?.train_number ?? null],
      ['路線', train.line],
      ['編成', cars.join(' · ') || null],
      ['番線', departure?.track ? `${stationName} ${departure.track}番線` : null],
      ['停車駅', `${train.stops.length}駅`],
    ]);
    for (const comment of train.comments) el('p', 'timetable-comment', this._body).textContent = comment;
    const list = el('ol', 'timetable-stops', this._body);
    const first = train.stops.find((stop) => stop.departure ?? stop.arrival);
    const start = Number((first?.departure ?? first?.arrival ?? '00').slice(0, 2)) || 0;
    for (const stop of train.stops) {
      const item = el('li', 'timetable-stop', list);
      if (stop.code === code) item.classList.add('timetable-stop-here');
      const name = stop.code ? el('button', 'timetable-stop-name', item) : el('span', 'timetable-stop-name', item);
      name.textContent = stop.name;
      if (stop.code && name instanceof HTMLButtonElement) {
        name.type = 'button';
        setTooltip(name, this._ui.timetableAt(stop.name));
        const stopCode = stop.code;
        name.addEventListener('click', () => this._show({ kind: 'jp-lines', name: stop.name, codes: [stopCode] }));
      }
      const arrival = trainStopClock(stop.arrival, start);
      const departure = trainStopClock(stop.departure, start);
      const times = el('span', 'timetable-stop-time', item);
      times.textContent = [arrival?.time, departure?.time]
        .map((time) => time ?? '')
        .join(' – ')
        .replace(/^ – | – $/g, '');
      const days = (arrival ?? departure)?.days ?? 0;
      if (days > 0) {
        const day = el('span', 'timetable-stop-day', times);
        day.textContent = `+${days}`;
        setTooltip(day, this._ui.daysAfter(days));
      }
      const position = stop.lon !== null && stop.lon !== undefined ? ([stop.lon, stop.lat] as [number, number]) : null;
      this._locate(item, stop.name, position);
    }
    list.querySelector('.timetable-stop-here')?.scrollIntoView?.({ block: 'center' });
    const here = train.stops.find((stop) => stop.code === code)?.name ?? null;
    this._drawRoute(
      () => trainRoute(code, gid, trainId, this._signal),
      here,
      train.stops.map((stop) => ({
        name: stop.name,
        position: stop.lon !== null && stop.lon !== undefined ? ([stop.lon, stop.lat] as [number, number]) : null,
        elements: stop.osm ?? null,
      })),
    );
  }

  private async _renderCrStation(candidates: string[], name: string, date: string | null) {
    const signal = this._signal;
    this._setHeader(name, '车次', null);
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
      el('div', 'timetable-status', this._body).textContent = `没有${name}站的列车时刻表。`;
      return;
    }
    const station = table.station.name;
    // The link names the station found and the day shown.
    this._settle({ kind: 'cr-station', candidates: [station], name: station, date: table.date });
    const trainCount = `${table.trains.length}趟`;
    this._setHeader(station, `${crDateLabel(table.date)} · ${trainCount}`, crSource(table.data_version), {
      title: `Timetable error at ${station}`,
      details: [`Station: ${station} (${table.station.telecode})`, `Date: ${table.date}`],
    });

    const today = chinaNow().date;
    const days = this._navGroup('日期');
    // The steps are drawn chevrons, centred in their circle as a text ‹ › never is.
    const dayButton = (label: string, title: string, target: string, icon?: string) => {
      const button = el('button', icon ? 'timetable-day timetable-day-step' : 'timetable-day', days);
      button.type = 'button';
      setTooltip(button, title);
      if (icon) {
        button.innerHTML = icon;
        button.setAttribute('aria-label', title);
      } else {
        button.textContent = label;
      }
      button.addEventListener('click', () => {
        // Replace this view rather than stacking date switches on the back button.
        this._history.pop();
        this._show({ kind: 'cr-station', candidates: [station], name: station, date: target });
      });
    };
    dayButton('‹', '前一天', addDays(table.date, -1), CHEVRON_LEFT);
    el('span', 'timetable-date', days).textContent = crDateLabel(table.date);
    dayButton('›', '后一天', addDays(table.date, 1), CHEVRON_RIGHT);
    if (table.date !== today) dayButton('今天', '今天（北京时间）', today);

    if (table.trains.length === 0) {
      el('div', 'timetable-status', this._body).textContent = '没有列车。';
      return;
    }
    // A list, or a printed station timetable's layout.
    const printedInput = this._navToggle(
      '横列表示',
      TIMETABLE_CR_PRINTED_STORAGE_KEY,
      '如车站时刻表，按小时横向排列发车时刻',
    );

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
    const lineRow = tabRow('线路', lines.length > 1);
    const boundRow = tabRow('方向', bounds.length > 1);
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
      tab(lineRow, '全部', null, (value) => (line = value));
      for (const { line: value } of lines) tab(lineRow, value, value, (picked) => (line = picked));
    }
    if (boundRow) {
      tab(boundRow, '上下行', null, (value) => (bound = value));
      for (const { bound: value } of bounds) tab(boundRow, value, value, (picked) => (bound = picked));
    }
    const counted = (count: number) => `${count}趟`;

    const list = el('ol', 'timetable-departures timetable-cr-trains', this._body);
    const printed = el('div', 'timetable-printed', this._body);
    const layout = () => {
      list.hidden = printedInput.checked;
      printed.hidden = !printedInput.checked;
      (printedInput.checked ? printed : list).querySelector('.timetable-next')?.scrollIntoView?.({ block: 'center' });
    };
    printedInput.addEventListener('change', layout);
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
        setTooltip(button, counted(count));
      }
      for (const button of boundRow?.querySelectorAll<HTMLElement>('.timetable-day') ?? []) {
        const value = button.dataset.value || null;
        button.setAttribute('aria-pressed', String(value === bound));
        setTooltip(button, counted(onLine.filter((train) => value === null || train.bound === value).length));
      }
      this._summary.textContent = `${crDateLabel(table.date)} · ${
        trains.length === table.trains.length ? trainCount : `${trains.length}/${trainCount}`
      }`;
      this._renderCrTrains(list, { ...table, trains }, station);
      this._renderCrPrinted(printed, { ...table, trains }, station);
      layout();
    };
    show();
  }

  // A station's departures as a printed timetable lays them out: an hour a
  // row, each minute under its marks, the destination's character and the
  // class's in brackets (crDestinationMarks, crTrainClass), with ● for a train
  // starting here. Unlike Yahoo's ヨコ表示 every train is marked: a station
  // has too many classes and destinations for the unmarked ones (無印) to be
  // known without the legend. Trains ending here, which leave nothing, are in
  // the list.
  private _renderCrPrinted(printed: HTMLElement, table: CrStationTimetable, station: string) {
    printed.replaceChildren();
    const trains = table.trains.filter((train) => train.departure);
    const next = trains[nextCrTrainIndex({ date: table.date, trains })];
    if (trains.length === 0) {
      el('div', 'timetable-status', printed).textContent = '没有发车的列车。';
      return;
    }
    const numberOf = (train: CrStationTrain) => train.departure_number ?? train.train;
    const destinations = crDestinationMarks(trains.map((train) => train.destination));

    const grid = el('div', 'timetable-grid', printed);
    let row: HTMLElement | null = null;
    let hour = '';
    trains.forEach((train) => {
      const time = train.departure;
      if (time.slice(0, 2) !== hour) {
        hour = time.slice(0, 2);
        el('div', 'timetable-grid-hour', grid).textContent = String(Number(hour));
        row = el('div', 'timetable-grid-minutes', grid);
      }
      const button = el('button', 'timetable-grid-minute', row);
      button.type = 'button';
      if (train === next) button.classList.add('timetable-next');
      // High-speed trains in the high-speed purple, as in the list
      if (isHighSpeedTrain(numberOf(train))) button.classList.add('timetable-highspeed');
      const marks = el('span', 'timetable-grid-marks', button);
      if (!train.arrival) marks.append('●');
      marks.append(destinations.marks.get(train.destination) ?? '');
      // In brackets, as Yahoo writes a type's mark (上[特])
      el('span', 'timetable-grid-class', marks).textContent = `[${crTrainClass(numberOf(train)).mark}]`;
      el('span', 'timetable-grid-time', button).textContent = time.slice(3);
      setTooltip(button, crTrainTooltip(train));
      button.addEventListener('click', () =>
        this._show({ kind: 'cr-train', train: train.train, date: addDays(table.date, 1 - train.day), station }),
      );
    });

    // Each destination's character and the dot, each kept on one line with
    // what it stands for. The classes' marks need none.
    const key = el('ul', 'timetable-legend', printed);
    const entry = (mark: string, meaning: string) => {
      const item = el('li', undefined, key);
      el('b', undefined, item).textContent = mark;
      item.append(` ${meaning}`);
    };
    for (const { mark, stations } of destinations.legend) entry(mark, `开往${stations.join('、')}`);
    if (trains.some((train) => !train.arrival)) entry('●', '本站始发');
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
        setTooltip(timeCell, '终到');
      }
      // The number it runs under here (Z156 of Z156/Z157), as the station shows it.
      const number = train.departure_number ?? train.arrival_number ?? train.train;
      const numberCell = el('span', 'timetable-kind timetable-train-number', button);
      numberCell.textContent = number;
      if (isHighSpeedTrain(train.train)) numberCell.classList.add('timetable-highspeed');
      const destination = el('span', 'timetable-destination', button);
      destination.textContent = `${train.origin} → ${train.destination}`;
      // The line it runs on here, or the lines it changes between.
      const lines =
        train.line_in && train.line_out && train.line_in !== train.line_out
          ? `${train.line_in}→${train.line_out}`
          : (train.line ?? train.line_out ?? train.line_in);
      if (lines) el('span', 'timetable-train-line', destination).textContent = lines;
      el('span', 'timetable-platform', button).textContent = train.platform ?? '';
      setTooltip(button, crTrainTooltip(train));
      // The train's own date is the day it left its origin.
      button.addEventListener('click', () =>
        this._show({ kind: 'cr-train', train: train.train, date: addDays(table.date, 1 - train.day), station }),
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
    const leaves = date !== chinaNow().date && `${crDateLabel(date)}始发`;
    this._setHeader(
      stationName ?? run?.train ?? train,
      [stationName && (run?.train ?? train), route, leaves].filter(Boolean).join(' · '),
      crSource(schedule.data_version),
      {
        title: `Route error on train ${run?.train ?? train}`,
        details: [
          `Train: ${run?.train ?? train}${route ? ` (${route})` : ''}`,
          `Leaves its origin: ${date}`,
          ...(stationName ? [`Opened at: ${stationName}`] : []),
        ],
      },
    );
    this._setBack('车次');
    this._body.replaceChildren();
    const last = stops[stops.length - 1];
    const facts = this._facts([
      ['停站', [`${stops.length}站`, last && `全程 ${last.km} km`].filter(Boolean).join(' · ')],
      ['开行日期', run ? `${run.service.from} – ${run.service.to ?? '另行通知'}` : null],
      ['担当车底', rollingStockLabel(run?.rolling_stock)],
    ]);
    // The description, unless it only names the model.
    const stock = run?.rolling_stock;
    const stockTerm = Array.from(facts.children).find((child) => child.textContent === '担当车底');
    const planned = stockTerm ? [stockTerm, stockTerm.nextElementSibling] : [];
    if (stock?.description && stock.description !== stock.model) {
      const description = el('p', 'timetable-comment', this._body);
      description.textContent = stock.description;
      planned.push(description);
    }
    this._trainset(facts, run?.train ?? train, date, planned);
    if (run && !run.runs) el('p', 'timetable-comment', this._body).textContent = `${date} 不从始发站开行。`;
    // Lines and distances, folded into the stops: each stop's km from the
    // origin, and between two stops the lines the train runs on there.
    const segments = crLinesBetweenStops(stops, run?.lines ?? []);
    const input = this._navToggle(
      segments.some((lines) => lines.length) ? '线路和里程' : '里程',
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
          if (from) el('span', 'timetable-segment-junction', row).textContent = `（${from}起）`;
        });
      }
      const item = el('li', 'timetable-stop', list);
      if (stop.name === stationName) item.classList.add('timetable-stop-here');
      const name = el('button', 'timetable-stop-name', item);
      name.type = 'button';
      name.textContent = stop.name;
      setTooltip(name, this._ui.timetableAt(stop.name));
      // Where the number changes (Z156/Z157 at 山海关), the numbers in and out.
      if (stop.arrival_number && stop.departure_number && stop.arrival_number !== stop.departure_number) {
        const change = el('span', 'timetable-number-change', name);
        change.textContent = `${stop.arrival_number}→${stop.departure_number}`;
        setTooltip(change, `到达车次 ${stop.arrival_number}，开出车次 ${stop.departure_number}`);
      }
      name.addEventListener('click', () =>
        this._show({
          kind: 'cr-station',
          candidates: [stop.name],
          name: stop.name,
          date: addDays(date, stop.day - 1),
        }),
      );
      const times = el('span', 'timetable-stop-time', item);
      times.textContent = [stop.arrival, stop.departure]
        .map((time) => time ?? '')
        .join(' – ')
        .replace(/^ – | – $/g, '');
      if (stop.day > 1) {
        const day = el('span', 'timetable-stop-day', times);
        day.textContent = `+${stop.day - 1}`;
        setTooltip(day, this._ui.daysAfter(stop.day - 1));
      }
      el('span', 'timetable-stop-km', item).textContent = `${stop.km} km`;
      const platform = el('span', 'timetable-platform', item);
      platform.textContent = stop.platform ?? '';
      if (stop.platform) setTooltip(platform, `站台/检票口 ${stop.platform}`);
      this._locate(item, stop.name, stop.position);
    });
    list.querySelector('.timetable-stop-here')?.scrollIntoView?.({ block: 'center' });
    this._drawRoute(
      () => crTrainRoute(run?.train ?? train, date, this._signal),
      stationName,
      stops.map((stop) => ({ name: stop.name, position: stop.position ?? null, elements: stop.elements ?? null })),
    );
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
  setTooltip(button, 'cr' in request ? 'Trains from the China Railway timetable' : 'Departures from Yahoo!乗換案内');
  button.innerHTML = CLOCK_ICON;
  el('span', undefined, button).textContent = 'Timetable';
  button.addEventListener('click', () =>
    button.dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { bubbles: true, detail: request })),
  );
}

// `onView` is told the view shown, null once closed: the URL keeps it (main.ts).
export function installTimetable(
  map: TimetableMap,
  route: TrainRouteDrawer | null = null,
  onView: (view: TimetableView | null) => void = () => {},
) {
  const container = map.getContainer();
  const panel = new TimetablePanel(map, route, onView);
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
