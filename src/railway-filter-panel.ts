import TrainFrontIcon from 'lucide/dist/esm/icons/train-front.mjs';
import {
  countActiveRailwayFilters,
  defaultRailwayFilterSettings,
  EARLIEST_RAILWAY_YEAR,
  RAILWAY_CATEGORIES,
  RAILWAY_DATE_STATE,
  RAILWAY_LINE_SOURCE_LAYERS,
  RAILWAY_MIN_SPEED_OPTIONS,
  RAILWAY_STATUSES,
  railwayDateState,
  railwayFilterGlobalState,
  saveRailwayFilterSettings,
  type RailwayCategory,
  type RailwayElectrification,
  type RailwayFilterSettings,
  type RailwayGauge,
  type RailwayStatus,
  type RailwayTraffic,
} from './railway-filter.js';
import { RAILWAY_COLOR_LEGENDS, type RailwayColorMode } from './railway-colors.js';
import { createPanelButton, createPanelFields, createPanelShell, el } from './map-panel.js';
import { setGlobalStatePropertyWhenReady } from './style-ready.js';
import {
  emitUiPanelOpen,
  isOtherUiPanelOpen,
  onOutsideClick,
  UI_PANEL_OPEN_EVENT,
  type OutsideClickMap,
} from './ui-panels.js';

type RailwayFilterControl = {
  onAdd(map: RailwayFilterMap): HTMLElement;
  onRemove(): void;
};
type RenderedLineFeature = { sourceLayer?: string; properties?: Record<string, unknown> };
export type RailwayFilterMap = Parameters<typeof setGlobalStatePropertyWhenReady>[0] &
  OutsideClickMap & {
    addControl(control: RailwayFilterControl, position?: string): void;
    getContainer(): HTMLElement;
    // Used to suggest operators of the lines in view; optional for tests.
    queryRenderedFeatures?(): RenderedLineFeature[];
    on?(event: 'moveend', listener: () => void): void;
    off?(event: 'moveend', listener: () => void): void;
  };

const OPERATOR_INPUT_DELAY_MS = 350;
// Dragging the year slider re-evaluates the historical line tiles, so a new
// year applies once the slider pauses (and at once when it is let go).
const DATE_INPUT_DELAY_MS = 150;
const OPERATOR_SUGGESTION_LIMIT = 40;

// The same company is often tagged with and without a legal form or a
// translation: 東海旅客鉄道, 東海旅客鉄道株式会社, 東海旅客鉄道 (JR Central).
const OPERATOR_TRANSLATION = /\s*[(（]([^()（）]+)[)）]$/;
const OPERATOR_LEGAL_PREFIX = /^株式会社\s*/;
const OPERATOR_LEGAL_SUFFIX =
  /(?:\s*(?:株式会社|股份有限公司|有限责任公司|有限公司)|,?\s+(?:Co\.,?\s*)?Ltd\.?|,?\s+(?:Inc\.?|GmbH|AG|plc|LLC|Limited|Corporation))$/i;

// Shortens an operator name to the part its variants share, plus any
// translations it carried. The operator filter matches part of a name, so the
// short form matches every variant.
export function operatorBaseName(operator: string): { name: string; translations: string[] } {
  let name = operator.trim();
  const translations: string[] = [];
  for (let previous = ''; name !== previous; ) {
    previous = name;
    const translation = OPERATOR_TRANSLATION.exec(name);
    if (translation) translations.unshift(translation[1].trim());
    const shorter = name
      .replace(OPERATOR_TRANSLATION, '')
      .replace(OPERATOR_LEGAL_PREFIX, '')
      .replace(OPERATOR_LEGAL_SUFFIX, '');
    if (shorter.trim().length >= 2) name = shorter.trim();
  }
  return { name, translations };
}

const CATEGORY_LABELS: Record<RailwayCategory, { label: string; hint: string }> = {
  main: { label: 'Main lines', hint: 'Mainline passenger and freight routes' },
  branch: { label: 'Branch lines', hint: 'Secondary and regional lines' },
  industrial: { label: 'Industrial & military', hint: 'Industrial, freight-only, military and test tracks' },
  service: { label: 'Service tracks', hint: 'Sidings, yards, spurs, crossovers and junctions' },
  urban: { label: 'Urban transit', hint: 'Tram, subway, light rail, monorail and funicular' },
  tourism: { label: 'Heritage & tourism', hint: 'Tourist, heritage and miniature railways' },
  other: { label: 'Other tracks', hint: 'Tracks without a usage tag' },
};

const STATUS_LABELS: Record<RailwayStatus, string> = {
  showConstructionInfrastructure: 'Under construction',
  showProposedInfrastructure: 'Proposed',
  showAbandonedInfrastructure: 'Abandoned',
  showRazedInfrastructure: 'Razed',
};

const COLOR_MODE_LABELS: Record<RailwayColorMode, string> = {
  default: 'Default',
  usage: 'Usage',
  operator: 'Operator',
  speed: 'Maximum speed',
  electrification: 'Electrification',
  gauge: 'Gauge',
  tracks: 'Number of tracks',
};

const ELECTRIFICATION_LABELS: Record<RailwayElectrification, string> = {
  any: 'Any',
  electrified: 'Electrified',
  'not-electrified': 'Not electrified',
};

const GAUGE_LABELS: Record<RailwayGauge, string> = {
  any: 'Any gauge',
  standard: 'Standard (1435 mm)',
  broad: 'Broad (over 1435 mm)',
  narrow: 'Narrow (under 1435 mm)',
};

const TRAFFIC_LABELS: Record<RailwayTraffic, string> = {
  any: 'Any traffic',
  passenger: 'Passenger',
  freight: 'Freight',
};

const { checkboxRow, selectField, rangeField, group } = createPanelFields('railway-filter');

class RailwayFilterPanel {
  _settings: RailwayFilterSettings;
  _map: RailwayFilterMap;
  _control: HTMLElement;
  _button: HTMLButtonElement;
  _panel: HTMLElement;
  _summary: HTMLElement;
  _overlayInput: HTMLInputElement;
  _filters: HTMLElement;
  _presentYear: number;
  _year: number;
  _dateInput: HTMLInputElement;
  _dateValue: HTMLElement;
  _todayButton: HTMLButtonElement;
  _dateNote: HTMLElement;
  _dateTimer: ReturnType<typeof setTimeout> | null = null;
  _colorSelect: HTMLSelectElement;
  _legend: HTMLUListElement;
  _legendMode: RailwayColorMode | null = null;
  _tunnelsAndBridgesInput: HTMLInputElement;
  _categoryInputs = new Map<RailwayCategory, HTMLInputElement>();
  _statusInputs = new Map<RailwayStatus, HTMLInputElement>();
  _speedSelect: HTMLSelectElement;
  _electrificationSelect: HTMLSelectElement;
  _gaugeSelect: HTMLSelectElement;
  _trafficSelect: HTMLSelectElement;
  _operatorInput: HTMLInputElement;
  _operatorSuggestions: HTMLDataListElement;
  _unknownInput: HTMLInputElement;
  _operatorTimer: ReturnType<typeof setTimeout> | null = null;
  _boundMoveEnd: () => void;
  _resetButton: HTMLButtonElement;
  _expanded = false;
  _boundEscape: (event: KeyboardEvent) => void;
  _boundAnyPanelOpen: (event: Event) => void;
  _removeOutsideClick: () => void;

  constructor(settings: RailwayFilterSettings, presentYear: number) {
    this._settings = structuredClone(settings);
    this._presentYear = presentYear;
    this._year = presentYear;
    this._boundEscape = (event) => {
      if (event.key === 'Escape' && this._expanded) this.setExpanded(false);
    };
    this._boundAnyPanelOpen = (event) => {
      if (isOtherUiPanelOpen(event, 'railways')) this.setExpanded(false);
    };
    this._boundMoveEnd = () => {
      if (this._expanded) this._refreshOperatorSuggestions();
    };
  }

  onAdd(map: RailwayFilterMap) {
    this._map = map;
    map.getContainer().addEventListener(UI_PANEL_OPEN_EVENT, this._boundAnyPanelOpen);
    map.on?.('moveend', this._boundMoveEnd);
    window.addEventListener('keydown', this._boundEscape);

    ({ control: this._control, button: this._button } = createPanelButton(
      'maplibregl-ctrl-railways',
      'Railway filter',
      TrainFrontIcon,
      'railway-filter-icon',
    ));
    this._button.addEventListener('click', () => this.setExpanded(!this._expanded));

    const shell = createPanelShell(map.getContainer(), 'railway-filter', {
      title: 'Railways',
      label: 'Railway filter',
      closeLabel: 'Close railway filter',
      onClose: () => this.setExpanded(false),
    });
    this._panel = shell.panel;
    this._summary = shell.summary;
    this._removeOutsideClick = onOutsideClick(
      map,
      () => [this._panel, this._control],
      () => this.setExpanded(false),
    );
    const body = shell.body;
    this._overlayInput = checkboxRow(body, 'Show railway overlay');
    this._overlayInput.closest('label')?.classList.add('railway-filter-master');
    this._overlayInput.addEventListener('change', () => this._update((s) => (s.overlay = this._overlayInput.checked)));

    this._filters = el('div', 'railway-filter-options', body);
    const date = group(this._filters, 'Date');
    ({ input: this._dateInput, value: this._dateValue } = rangeField(date, 'Year', {
      min: EARLIEST_RAILWAY_YEAR,
      max: this._presentYear,
      step: 1,
    }));
    this._dateInput.addEventListener('input', () => this._scheduleDate());
    this._dateInput.addEventListener('change', () => this._applyDate());
    this._todayButton = el('button', 'railway-filter-today', this._dateValue.parentElement);
    this._todayButton.type = 'button';
    this._todayButton.textContent = 'Today';
    this._todayButton.title = 'Show today’s railways';
    this._todayButton.addEventListener('click', (event) => {
      // The button sits in the slider's label, which would otherwise focus the slider.
      event.preventDefault();
      this._dateInput.value = String(this._presentYear);
      this._applyDate();
    });
    this._dateNote = el('p', 'railway-filter-date-note', date);
    this._dateNote.textContent =
      'Railways of that year from OpenHistoricalMap, fullest for Europe, North America and Japan. ' +
      'The colors and filters below apply to today’s map.';
    const colors = group(this._filters, 'Line style');
    this._colorSelect = selectField(colors, 'Color by', Object.entries(COLOR_MODE_LABELS));
    this._colorSelect.addEventListener('change', () =>
      this._update((s) => (s.colorBy = this._colorSelect.value as RailwayColorMode)),
    );
    this._legend = el('ul', 'railway-filter-legend', colors);
    this._legend.setAttribute('aria-label', 'Line color legend');
    this._tunnelsAndBridgesInput = checkboxRow(colors, 'Mark tunnels and bridges', 'Faded tunnels, outlined bridges');
    this._tunnelsAndBridgesInput.addEventListener('change', () =>
      this._update((s) => (s.tunnelsAndBridges = this._tunnelsAndBridgesInput.checked)),
    );

    const types = group(this._filters, 'Line and station types');
    for (const category of RAILWAY_CATEGORIES) {
      const input = checkboxRow(types, CATEGORY_LABELS[category].label, CATEGORY_LABELS[category].hint);
      input.addEventListener('change', () => this._update((s) => (s.categories[category] = input.checked)));
      this._categoryInputs.set(category, input);
    }

    const statuses = group(this._filters, 'Status');
    for (const status of RAILWAY_STATUSES) {
      const input = checkboxRow(statuses, STATUS_LABELS[status]);
      input.addEventListener('change', () => this._update((s) => (s.statuses[status] = input.checked)));
      this._statusInputs.set(status, input);
    }

    const track = group(this._filters, 'Track attributes');
    this._speedSelect = selectField(
      track,
      'Speed',
      RAILWAY_MIN_SPEED_OPTIONS.map((value) => [String(value), value === 0 ? 'Any speed' : `At least ${value} km/h`]),
    );
    this._speedSelect.addEventListener('change', () =>
      this._update((s) => (s.minSpeed = Number(this._speedSelect.value))),
    );
    this._gaugeSelect = selectField(track, 'Gauge', Object.entries(GAUGE_LABELS));
    this._gaugeSelect.addEventListener('change', () =>
      this._update((s) => (s.gauge = this._gaugeSelect.value as RailwayGauge)),
    );
    this._trafficSelect = selectField(track, 'Traffic', Object.entries(TRAFFIC_LABELS));
    this._trafficSelect.addEventListener('change', () =>
      this._update((s) => (s.traffic = this._trafficSelect.value as RailwayTraffic)),
    );
    this._electrificationSelect = selectField(track, 'Power', Object.entries(ELECTRIFICATION_LABELS));
    this._electrificationSelect.addEventListener('change', () =>
      this._update((s) => (s.electrification = this._electrificationSelect.value as RailwayElectrification)),
    );

    const operatorLabel = el('label', 'railway-filter-field', track);
    el('span', 'railway-filter-field-label', operatorLabel).textContent = 'Operator';
    this._operatorInput = el('input', 'railway-filter-select railway-filter-input', operatorLabel);
    this._operatorInput.type = 'search';
    this._operatorInput.placeholder = 'Any operator';
    this._operatorInput.autocomplete = 'off';
    this._operatorSuggestions = el('datalist', '', operatorLabel);
    this._operatorSuggestions.id = `railway-filter-operators-${Math.random().toString(36).slice(2)}`;
    this._operatorInput.setAttribute('list', this._operatorSuggestions.id);
    this._operatorInput.addEventListener('input', () => this._scheduleOperatorUpdate());
    this._operatorInput.addEventListener('change', () => this._applyOperator());

    this._unknownInput = checkboxRow(
      track,
      'Keep lines without this data',
      'Lines missing speed, gauge or traffic tags stay visible',
    );
    this._unknownInput.addEventListener('change', () =>
      this._update((s) => (s.includeUnknown = this._unknownInput.checked)),
    );

    this._resetButton = el('button', 'railway-filter-reset', body);
    this._resetButton.type = 'button';
    this._resetButton.textContent = 'Reset filters';
    this._resetButton.addEventListener('click', () =>
      this._update((s) =>
        Object.assign(s, defaultRailwayFilterSettings(), {
          overlay: s.overlay,
          colorBy: s.colorBy,
          tunnelsAndBridges: s.tunnelsAndBridges,
        }),
      ),
    );

    this._sync();
    return this._control;
  }

  onRemove() {
    if (this._operatorTimer) clearTimeout(this._operatorTimer);
    if (this._dateTimer) clearTimeout(this._dateTimer);
    this._removeOutsideClick?.();
    this._map.off?.('moveend', this._boundMoveEnd);
    this._map.getContainer().removeEventListener(UI_PANEL_OPEN_EVENT, this._boundAnyPanelOpen);
    window.removeEventListener('keydown', this._boundEscape);
    this._panel?.remove();
    this._control?.remove();
    this._map = undefined;
  }

  setExpanded(expanded: boolean) {
    const next = Boolean(expanded);
    if (this._expanded === next) return;
    this._expanded = next;
    if (next) {
      emitUiPanelOpen(this._map.getContainer(), 'railways');
      this._refreshOperatorSuggestions();
    }
    this._sync();
  }

  _scheduleOperatorUpdate() {
    if (this._operatorTimer) clearTimeout(this._operatorTimer);
    // Every filter change re-evaluates the line tiles, so wait for a pause in typing.
    this._operatorTimer = setTimeout(() => this._applyOperator(), OPERATOR_INPUT_DELAY_MS);
  }

  _applyOperator() {
    if (this._operatorTimer) clearTimeout(this._operatorTimer);
    this._operatorTimer = null;
    const operator = this._operatorInput.value.trim();
    if (operator !== this._settings.operator) this._update((s) => (s.operator = operator));
  }

  _scheduleDate() {
    this._dateValue.textContent = this._yearLabel(Number(this._dateInput.value));
    if (this._dateTimer) clearTimeout(this._dateTimer);
    this._dateTimer = setTimeout(() => this._applyDate(), DATE_INPUT_DELAY_MS);
  }

  _applyDate() {
    if (this._dateTimer) clearTimeout(this._dateTimer);
    this._dateTimer = null;
    const year = Number(this._dateInput.value);
    if (year !== this._year) {
      this._year = year;
      setGlobalStatePropertyWhenReady(this._map, RAILWAY_DATE_STATE, railwayDateState(year, this._presentYear));
    }
    this._sync();
  }

  _yearLabel(year: number) {
    return year >= this._presentYear ? 'Today' : String(year);
  }

  // Suggest the most common operators among the railway lines in view, one
  // entry per company however its name is spelled, with its translations as
  // the label.
  _refreshOperatorSuggestions() {
    const features = this._map.queryRenderedFeatures?.() ?? [];
    const lineSourceLayers = new Set(RAILWAY_LINE_SOURCE_LAYERS);
    const suggestions = new Map<string, { count: number; translations: Set<string> }>();
    for (const feature of features) {
      if (!lineSourceLayers.has(feature.sourceLayer || '')) continue;
      const operators = String(feature.properties?.operator ?? '').split('\u001e');
      for (const operator of operators.map((value) => value.trim()).filter(Boolean)) {
        const { name, translations } = operatorBaseName(operator);
        const suggestion = suggestions.get(name) ?? { count: 0, translations: new Set() };
        suggestion.count += 1;
        for (const translation of translations) suggestion.translations.add(translation);
        suggestions.set(name, suggestion);
      }
    }
    if (suggestions.size === 0) return;
    this._operatorSuggestions.replaceChildren(
      ...[...suggestions.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .slice(0, OPERATOR_SUGGESTION_LIMIT)
        .map(([name, { translations }]) => {
          const option = document.createElement('option');
          option.value = name;
          if (translations.size) option.setAttribute('label', [...translations].join(' · '));
          return option;
        }),
    );
  }

  _renderLegend(mode: RailwayColorMode) {
    if (this._legendMode === mode) return;
    this._legendMode = mode;
    const classes = mode === 'default' || mode === 'usage' || mode === 'operator' ? [] : RAILWAY_COLOR_LEGENDS[mode];
    const items = classes.map(({ label, color }) => {
      const item = el('li', 'railway-filter-legend-item');
      el('span', 'railway-filter-legend-swatch', item).style.background = color;
      el('span', '', item).textContent = label;
      return item;
    });
    if (mode === 'default') {
      const note = el('li', 'railway-filter-legend-item railway-filter-legend-note');
      note.textContent = 'Lines take the color of their route; others are colored by usage.';
      items.push(note);
    }
    if (mode === 'operator') {
      const note = el('li', 'railway-filter-legend-item railway-filter-legend-note');
      note.textContent = 'Each operator has its own color; lines without an operator are gray.';
      items.push(note);
    }
    this._legend.hidden = items.length === 0;
    this._legend.replaceChildren(...items);
  }

  _update(mutate: (settings: RailwayFilterSettings) => void) {
    const previous = railwayFilterGlobalState(this._settings);
    mutate(this._settings);
    for (const [name, value] of Object.entries(railwayFilterGlobalState(this._settings))) {
      if (previous[name] !== value) setGlobalStatePropertyWhenReady(this._map, name, value);
    }
    saveRailwayFilterSettings(this._settings);
    this._sync();
  }

  _sync() {
    const settings = this._settings;
    const activeFilters = countActiveRailwayFilters(settings);
    const historical = this._year < this._presentYear;
    this._button.classList.toggle('maplibregl-ctrl-railways-enabled', this._expanded);
    this._button.classList.toggle(
      'maplibregl-ctrl-railways-filtered',
      !settings.overlay || activeFilters > 0 || historical,
    );
    this._button.setAttribute('aria-pressed', this._expanded ? 'true' : 'false');
    this._panel.classList.toggle('railway-filter-panel-visible', this._expanded);
    this._panel.setAttribute('aria-hidden', this._expanded ? 'false' : 'true');
    this._panel.inert = !this._expanded;
    this._map.getContainer().dataset.railwayFilterPanelOpen = this._expanded ? 'true' : 'false';

    this._summary.textContent = !settings.overlay
      ? 'Overlay hidden'
      : historical
        ? `Railways in ${this._year}`
        : activeFilters === 0
          ? 'All railways shown'
          : `${activeFilters} filter${activeFilters === 1 ? '' : 's'} active`;
    this._overlayInput.checked = settings.overlay;
    this._filters.toggleAttribute('data-disabled', !settings.overlay);
    this._dateInput.value = String(this._year);
    this._dateInput.disabled = !settings.overlay;
    this._dateValue.textContent = this._yearLabel(this._year);
    this._todayButton.hidden = !historical;
    this._todayButton.disabled = !settings.overlay;
    this._dateNote.hidden = !historical;
    for (const [category, input] of this._categoryInputs) {
      input.checked = settings.categories[category];
      input.disabled = !settings.overlay;
    }
    for (const [status, input] of this._statusInputs) {
      input.checked = settings.statuses[status];
      input.disabled = !settings.overlay;
    }
    // The style only draws razed tracks while abandoned ones are shown.
    this._statusInputs.get('showRazedInfrastructure').disabled =
      !settings.overlay || !settings.statuses.showAbandonedInfrastructure;
    this._colorSelect.value = settings.colorBy;
    this._renderLegend(settings.colorBy);
    this._tunnelsAndBridgesInput.checked = settings.tunnelsAndBridges;
    this._tunnelsAndBridgesInput.disabled = !settings.overlay;
    this._speedSelect.value = String(settings.minSpeed);
    this._gaugeSelect.value = settings.gauge;
    this._trafficSelect.value = settings.traffic;
    this._electrificationSelect.value = settings.electrification;
    for (const field of [
      this._colorSelect,
      this._speedSelect,
      this._gaugeSelect,
      this._trafficSelect,
      this._electrificationSelect,
    ]) {
      field.disabled = !settings.overlay;
    }
    if (document.activeElement !== this._operatorInput) this._operatorInput.value = settings.operator;
    this._operatorInput.disabled = !settings.overlay;
    this._unknownInput.checked = settings.includeUnknown;
    this._unknownInput.disabled =
      !settings.overlay || (settings.minSpeed === 0 && settings.gauge === 'any' && settings.traffic === 'any');
    this._resetButton.disabled = !settings.overlay || activeFilters === 0;
  }
}

// presentYear is the style's default `date`, the year that shows today's map.
export function installRailwayFilter(
  map: RailwayFilterMap,
  settings: RailwayFilterSettings,
  presentYear = new Date().getFullYear(),
) {
  map.addControl(new RailwayFilterPanel(settings, presentYear), 'top-right');
}
