import { chinaNow, crTrainHitDate, searchCrTrains, type CrTrainHit } from './norikae.js';
import { TIMETABLE_OPEN_EVENT, type TimetableRequest } from './timetable.js';

// Places come from Photon; China Railway trains, for text that could start a
// train number, from the API's search, listed first.
const PHOTON_API_URL = 'https://photon.komoot.io/api/';
const SEARCH_SOURCE_ID = 'search';
const MIN_QUERY_LENGTH = 2;
const SEARCH_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 320;
const COMPACT_RESULTS_MEDIA_QUERY = '(max-width: 640px)';
const PHOTON_SUPPORTED_LANGUAGES = new Set(['de', 'en', 'fr']);
const TRAIN_LIMIT = 5;
// An optional letter, then digits (G1, z157, Ｇ１, 4401), as the API matches them.
const TRAIN_NUMBER_START = /^[A-Za-z]?\d/;

export function looksLikeTrainNumber(query: string) {
  return TRAIN_NUMBER_START.test(query.normalize('NFKC').replace(/\s+/g, ''));
}

const EMPTY_FEATURE_COLLECTION: { type: 'FeatureCollection'; features: PhotonPointFeature[] } = {
  type: 'FeatureCollection',
  features: [],
};

type PhotonPointFeature = {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number, ...number[]];
  };
  properties?: Record<string, unknown>;
};

type PhotonProperties = Record<string, unknown>;
type LngLatLike = { lng: number; lat: number };
type SearchGeoJsonSource = { setData?: (data: unknown) => void };
type SearchMap = {
  getContainer(): HTMLElement;
  getCenter(): LngLatLike;
  getZoom(): number;
  getSource(id: string): unknown;
  flyTo(options: Record<string, unknown>): void;
  addControl(control: unknown, position?: string): void;
  once(event: string, callback: () => void): void;
};
type PopupLike = {
  setLngLat(lngLat: [number, number]): PopupLike;
  setDOMContent(node: Node): PopupLike;
  addTo(map: SearchMap): PopupLike;
  remove(): void;
};
type SearchMaplibre = {
  Popup: new (options?: Record<string, unknown>) => PopupLike;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  parent?: Element,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : '';
}

function getPhotonLanguage() {
  const language = navigator.languages?.[0] || navigator.language || '';
  const normalized = language.split('-')[0].toLowerCase();
  return PHOTON_SUPPORTED_LANGUAGES.has(normalized) ? normalized : 'default';
}

function isCompactViewport() {
  return window.matchMedia?.(COMPACT_RESULTS_MEDIA_QUERY).matches ?? false;
}

function textValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function formatCategory(properties?: PhotonProperties) {
  if (!properties?.osm_key && !properties?.osm_value) return '';
  return [properties.osm_key, properties.osm_value].filter(Boolean).join(':');
}

function formatAddress(properties?: PhotonProperties) {
  const data = properties || {};
  const street = [data.street, data.housenumber].filter(Boolean).join(' ');
  const parts = [street, data.district, data.city, data.county, data.state, data.postcode, data.country].filter(
    (part, index, arr) => part && arr.indexOf(part) === index,
  );
  return parts.join(', ');
}

function formatDistance(meters: number) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

function haversineDistanceMeters(a: LngLatLike, b: LngLatLike) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const radius = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
}

function isPointFeature(feature: unknown): feature is PhotonPointFeature {
  if (!feature || typeof feature !== 'object') return false;
  const candidate = feature as {
    type?: unknown;
    geometry?: { type?: unknown; coordinates?: unknown };
  };
  return (
    candidate.type === 'Feature' &&
    candidate.geometry?.type === 'Point' &&
    Array.isArray(candidate.geometry.coordinates) &&
    candidate.geometry.coordinates.length >= 2 &&
    candidate.geometry.coordinates.every(Number.isFinite)
  );
}

function photonFeatures(data: unknown): PhotonPointFeature[] {
  return Array.isArray((data as { features?: unknown }).features)
    ? (data as { features: unknown[] }).features.filter(isPointFeature)
    : [];
}

function getFeatureKey(feature: PhotonPointFeature) {
  const properties = feature.properties || {};
  const [lng, lat] = feature.geometry.coordinates;
  return [properties.osm_type, properties.osm_id, properties.name, lng, lat].filter((value) => value != null).join('|');
}

function trainKey(hit: CrTrainHit) {
  return `train|${hit.train}|${hit.service.from}`;
}

// A found train's service period, when today is outside it.
export function servicePeriodNote(hit: Pick<CrTrainHit, 'service'>, today = chinaNow().date) {
  if (today < hit.service.from) return `Runs from ${hit.service.from}`;
  if (hit.service.to && today > hit.service.to) return `Ran until ${hit.service.to}`;
  return '';
}

function buildPhotonUrl(query: string, map: SearchMap) {
  const center = map.getCenter();
  const params = new URLSearchParams({
    q: query,
    lat: center.lat.toFixed(6),
    lon: center.lng.toFixed(6),
    zoom: Math.round(map.getZoom()).toString(),
    limit: SEARCH_LIMIT.toString(),
  });

  params.set('lang', getPhotonLanguage());

  return `${PHOTON_API_URL}?${params.toString()}`;
}

function setSearchFeature(map: SearchMap, feature: PhotonPointFeature | null) {
  const source = map.getSource(SEARCH_SOURCE_ID) as SearchGeoJsonSource | undefined;
  if (!source?.setData) return;
  source.setData({
    type: 'FeatureCollection',
    features: feature ? [feature] : [],
  });
}

function clearNode(node: Element) {
  while (node.firstChild) node.firstChild.remove();
}

function buildPopupContent(feature: PhotonPointFeature) {
  const properties = feature.properties || {};
  const container = el('div', 'poi-search-popup');
  const title = el('div', 'poi-search-popup-title', container);
  title.textContent = textValue(properties.name) || 'Selected place';

  const category = formatCategory(properties);
  if (category) {
    const categoryNode = el('div', 'poi-search-popup-category', container);
    categoryNode.textContent = category;
  }

  const address = formatAddress(properties);
  if (address) {
    const addressNode = el('div', 'poi-search-popup-address', container);
    addressNode.textContent = address;
  }

  return container;
}

class PhotonSearchControl {
  _maplibregl: SearchMaplibre;
  _map: SearchMap;
  _container: HTMLElement;
  _input: HTMLInputElement;
  _clearButton: HTMLButtonElement;
  _status: HTMLElement;
  _resultsToggle: HTMLButtonElement;
  _results: HTMLElement;
  _abortController: AbortController | null;
  _activeRequestId: number;
  _debounceTimer: number;
  _popup: PopupLike | null;
  _lastResults: PhotonPointFeature[];
  _lastTrains: CrTrainHit[];
  _selectedFeatureKey: string | null;
  _resultsCollapsed: boolean;

  constructor(maplibregl: SearchMaplibre) {
    this._maplibregl = maplibregl;
    this._abortController = null;
    this._activeRequestId = 0;
    this._debounceTimer = 0;
    this._popup = null;
    this._lastResults = [];
    this._lastTrains = [];
    this._selectedFeatureKey = null;
    this._resultsCollapsed = false;
  }

  onAdd(map: SearchMap) {
    this._map = map;
    this._container = el('div', 'maplibregl-ctrl poi-search');
    this._container.addEventListener('contextmenu', (e: Event) => e.stopPropagation());
    this._container.addEventListener('dblclick', (e: Event) => e.stopPropagation());
    this._container.addEventListener('mousedown', (e: Event) => e.stopPropagation());
    this._container.addEventListener('touchstart', (e: Event) => e.stopPropagation(), { passive: true });
    this._container.addEventListener('wheel', (e: Event) => e.stopPropagation(), { passive: true });

    const form = el('form', 'poi-search-form', this._container);
    this._input = el('input', 'poi-search-input', form);
    this._input.type = 'search';
    this._input.placeholder = 'Search places or trains';
    this._input.autocomplete = 'off';
    this._input.spellcheck = false;
    this._input.setAttribute('aria-label', 'Search places or trains');

    this._clearButton = el('button', 'poi-search-clear', form);
    this._clearButton.type = 'button';
    this._clearButton.title = 'Clear';
    this._clearButton.setAttribute('aria-label', 'Clear search');
    this._clearButton.textContent = 'x';

    this._status = el('div', 'poi-search-status', this._container);
    this._status.setAttribute('role', 'status');
    this._status.setAttribute('aria-live', 'polite');
    this._resultsToggle = el('button', 'poi-search-results-toggle', this._container);
    this._resultsToggle.type = 'button';
    this._resultsToggle.setAttribute('aria-controls', 'poi-search-results');
    this._resultsToggle.addEventListener('click', () => {
      this._resultsCollapsed = !this._resultsCollapsed;
      this._syncResultsVisibility();
    });
    this._results = el('div', 'poi-search-results', this._container);
    this._results.id = 'poi-search-results';
    this._results.setAttribute('role', 'listbox');

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this._lastTrains.length > 0) {
        this._selectTrain(this._lastTrains[0]);
      } else if (this._lastResults.length > 0) {
        this._selectFeature(this._lastResults[0]);
      } else {
        this._searchNow();
      }
    });
    this._input.addEventListener('input', () => this._scheduleSearch());
    this._input.addEventListener('keydown', (e: KeyboardEvent) => this._handleInputKeydown(e));
    this._clearButton.addEventListener('click', () => this._clear());

    return this._container;
  }

  onRemove() {
    window.clearTimeout(this._debounceTimer);
    this._abortController?.abort();
    this._popup?.remove();
    this._container.parentNode?.removeChild(this._container);
    this._map = undefined;
  }

  _handleInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._clear();
      return;
    }

    if (e.key !== 'ArrowDown') return;
    if (this._resultsCollapsed && this._resultCount() > 0) {
      this._resultsCollapsed = false;
      this._syncResultsVisibility();
    }
    const firstResult = this._results.querySelector<HTMLElement>('.poi-search-result');
    if (!firstResult) return;
    e.preventDefault();
    firstResult.focus();
  }

  _scheduleSearch() {
    window.clearTimeout(this._debounceTimer);
    const query = this._input.value.trim();
    this._clearButton.classList.toggle('visible', query.length > 0);

    if (query.length < MIN_QUERY_LENGTH) {
      this._abortController?.abort();
      this._setResults([]);
      this._setStatus('');
      return;
    }

    this._setStatus('Searching...');
    this._debounceTimer = window.setTimeout(() => this._searchNow(), SEARCH_DEBOUNCE_MS);
  }

  async _searchNow() {
    const query = this._input.value.trim();
    if (query.length < MIN_QUERY_LENGTH) return;

    this._abortController?.abort();
    this._abortController = new AbortController();
    const requestId = ++this._activeRequestId;

    const signal = this._abortController.signal;
    const places = fetch(buildPhotonUrl(query, this._map), { signal, headers: { Accept: 'application/json' } }).then(
      async (response) => {
        if (!response.ok) throw new Error(`Photon request failed: ${response.status}`);
        return photonFeatures(await response.json());
      },
    );
    const trains = looksLikeTrainNumber(query) ? searchCrTrains(query, TRAIN_LIMIT, signal) : Promise.resolve([]);
    // Each source on its own: one failing still shows the other's results.
    const [placeResult, trainResult] = await Promise.allSettled([places, trains]);
    if (requestId !== this._activeRequestId) return;
    const failed = [placeResult, trainResult].filter((result) => result.status === 'rejected');
    for (const result of failed) {
      const error = (result as PromiseRejectedResult).reason;
      if (errorName(error) === 'AbortError') return;
      console.error(error);
    }
    const features = placeResult.status === 'fulfilled' ? placeResult.value : [];
    const hits = trainResult.status === 'fulfilled' ? trainResult.value : [];
    this._setResults(features, hits);
    // Nothing found means "No results" only when every source asked answered.
    this._setStatus(features.length + hits.length > 0 ? '' : failed.length > 0 ? 'Search failed' : 'No results');
  }

  _resultCount() {
    return this._lastResults.length + this._lastTrains.length;
  }

  _setStatus(message: string) {
    this._status.textContent = message;
    this._status.classList.toggle('visible', Boolean(message));
  }

  _setResults(features: PhotonPointFeature[], trains: CrTrainHit[] = []) {
    this._lastResults = features;
    this._lastTrains = trains;
    this._resultsCollapsed = false;
    clearNode(this._results);

    for (const hit of trains) {
      const button = el('button', 'poi-search-result poi-search-train', this._results);
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.dataset.featureKey = trainKey(hit);
      el('span', 'poi-search-result-name', button).textContent = hit.train;
      el('span', 'poi-search-result-meta', button).textContent = `Train - ${hit.origin} → ${hit.destination}`;
      const period = servicePeriodNote(hit);
      if (period) el('span', 'poi-search-result-address', button).textContent = period;
      button.addEventListener('click', () => this._selectTrain(hit));
      button.addEventListener('keydown', (e: KeyboardEvent) => this._handleResultKeydown(e, button));
    }

    const center = this._map.getCenter();
    for (const feature of features) {
      const button = el('button', 'poi-search-result', this._results);
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.dataset.featureKey = getFeatureKey(feature);

      const name = el('span', 'poi-search-result-name', button);
      name.textContent = textValue(feature.properties?.name) || 'Unnamed place';

      const meta = el('span', 'poi-search-result-meta', button);
      const distance = formatDistance(
        haversineDistanceMeters(center, {
          lng: feature.geometry.coordinates[0],
          lat: feature.geometry.coordinates[1],
        }),
      );
      meta.textContent = [distance, formatCategory(feature.properties)].filter(Boolean).join(' - ');

      const address = formatAddress(feature.properties || {});
      if (address) {
        const addressNode = el('span', 'poi-search-result-address', button);
        addressNode.textContent = address;
      }

      button.addEventListener('click', () => this._selectFeature(feature));
      button.addEventListener('keydown', (e: KeyboardEvent) => this._handleResultKeydown(e, button));
    }

    this._syncSelectedResultState();
    this._syncResultsVisibility();
  }

  _syncResultsVisibility() {
    const count = this._resultCount();
    const hasResults = count > 0;
    const collapsed = hasResults && this._resultsCollapsed;
    this._results.classList.toggle('visible', hasResults && !collapsed);
    this._resultsToggle.classList.toggle('visible', hasResults);
    this._resultsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    this._resultsToggle.textContent = collapsed ? `Show ${count} results` : `Hide ${count} results`;
  }

  _syncSelectedResultState() {
    const buttons = this._results.querySelectorAll<HTMLElement>('.poi-search-result');
    for (const button of buttons) {
      const selected = Boolean(this._selectedFeatureKey) && button.dataset.featureKey === this._selectedFeatureKey;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  _handleResultKeydown(e: KeyboardEvent, button: HTMLButtonElement) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._input.focus();
      return;
    }

    const move = e.key === 'ArrowDown' ? 'nextElementSibling' : e.key === 'ArrowUp' ? 'previousElementSibling' : null;
    if (!move) return;

    e.preventDefault();
    const target = (button[move] as HTMLElement | null) || (e.key === 'ArrowUp' ? this._input : null);
    target?.focus();
  }

  _selectFeature(feature: PhotonPointFeature) {
    const [lng, lat] = feature.geometry.coordinates;
    this._selectedFeatureKey = getFeatureKey(feature);
    setSearchFeature(this._map, feature);
    this._popup?.remove();
    this._popup = new this._maplibregl.Popup({ offset: 16, maxWidth: '320px' })
      .setLngLat([lng, lat])
      .setDOMContent(buildPopupContent(feature))
      .addTo(this._map);

    this._map.flyTo({
      center: [lng, lat],
      zoom: Math.max(this._map.getZoom(), 15),
      essential: true,
    });

    this._syncSelectedResultState();
    if (isCompactViewport()) {
      this._resultsCollapsed = true;
    }
    this._syncResultsVisibility();
    this._clearButton.classList.add('visible');
  }

  // Opens a found train in the timetable panel, which draws its track, and
  // folds the results away so they do not cover it.
  _selectTrain(hit: CrTrainHit) {
    this._selectedFeatureKey = trainKey(hit);
    this._popup?.remove();
    this._popup = null;
    setSearchFeature(this._map, null);
    const request: TimetableRequest = { name: hit.train, crTrain: hit.train, date: crTrainHitDate(hit) };
    this._map.getContainer().dispatchEvent(new CustomEvent(TIMETABLE_OPEN_EVENT, { bubbles: true, detail: request }));
    this._syncSelectedResultState();
    this._resultsCollapsed = true;
    this._syncResultsVisibility();
    this._clearButton.classList.add('visible');
    this._input.blur();
  }

  _clear() {
    this._abortController?.abort();
    window.clearTimeout(this._debounceTimer);
    this._activeRequestId += 1;
    this._input.value = '';
    this._lastResults = [];
    this._lastTrains = [];
    this._selectedFeatureKey = null;
    this._resultsCollapsed = false;
    this._clearButton.classList.remove('visible');
    this._setStatus('');
    this._setResults([]);
    this._popup?.remove();
    this._popup = null;
    setSearchFeature(this._map, null);
    this._input.focus();
  }
}

export function installPhotonSearch(map: SearchMap, maplibregl: SearchMaplibre) {
  map.addControl(new PhotonSearchControl(maplibregl), 'top-left');
  map.once('load', () => {
    const source = map.getSource(SEARCH_SOURCE_ID) as SearchGeoJsonSource | undefined;
    source?.setData?.(EMPTY_FEATURE_COLLECTION);
  });
}
