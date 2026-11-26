// The page's state in its URL's hash, so a link opens what it showed: the
// map's view under `map` (MapLibre's own, `hash: 'map'`), and the side
// panels' under their keys (`tt` the timetable's view, `route` the
// highlighted line or route). MapLibre keeps the other keys when it writes
// its own, and writes the hash decoded for reading, so the panels' values
// must hold no `&`, `=`, `#` or `%` (station names, codes and dates do not).
//
// Links from before keep working: a bare view (#12/35.68/139.76) is the
// `map` key's.

export const MAP_HASH_KEY = 'map';

const VIEW = /^-?\d+(\.\d+)?\/-?\d+(\.\d+)?\/-?\d+(\.\d+)?(\/-?\d+(\.\d+)?){0,2}$/;

const paramsOf = (hash: string) => new URLSearchParams(hash.replace(/^#/, ''));

// The hash as MapLibre writes it: decoded, keys without a value bare.
export function hashOf(params: URLSearchParams) {
  const text = decodeURIComponent(params.toString()).replace(/=&/g, '&').replace(/=$/, '');
  return text ? `#${text}` : '';
}

// A hash from before the map's view had a key, rewritten with it; null when
// it needs none.
export function withMapKey(hash: string) {
  const [first, ...rest] = hash.replace(/^#/, '').split('&');
  if (!VIEW.test(first)) return null;
  return `#${[`${MAP_HASH_KEY}=${first}`, ...rest].join('&')}`;
}

// Whether the hash holds a view for the map to open at.
export function hashHasMapView(hash: string) {
  return VIEW.test(paramsOf(hash).get(MAP_HASH_KEY) ?? '');
}

export function readHashParam(key: string, hash = window.location.hash) {
  return paramsOf(hash).get(key);
}

// Sets a key of the hash, or takes it away (null), leaving the others and
// the history as they are.
export function writeHashParam(key: string, value: string | null) {
  const params = paramsOf(window.location.hash);
  if (value) params.set(key, value);
  else params.delete(key);
  const hash = hashOf(params);
  if (hash === window.location.hash || (!hash && !window.location.hash)) return;
  window.history.replaceState(window.history.state, '', window.location.href.replace(/(#.*)?$/, hash));
}

// Before the map reads the hash: an old link's view moved under its key.
export function upgradeHash() {
  const upgraded = withMapKey(window.location.hash);
  if (upgraded)
    window.history.replaceState(window.history.state, '', window.location.href.replace(/(#.*)?$/, upgraded));
}
