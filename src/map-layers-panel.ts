import LayersIcon from 'lucide/dist/esm/icons/layers.mjs';
import {
  LABEL_LANGUAGES,
  MAP_BASES,
  mapLayerGlobalState,
  saveMapLayerSettings,
  type LabelLanguage,
  type MapBase,
  type MapLayerSettings,
} from './map-layers.js';
import { createPanelButton, createPanelFields, createPanelShell } from './map-panel.js';
import { runWhenStyleInfrastructureReady, setGlobalStatePropertyWhenReady } from './style-ready.js';
import {
  emitUiPanelOpen,
  isOtherUiPanelOpen,
  onOutsideClick,
  UI_PANEL_OPEN_EVENT,
  type OutsideClickMap,
} from './ui-panels.js';

type MapLayersControl = {
  onAdd(map: MapLayersMap): HTMLElement;
  onRemove(): void;
};
export type MapLayersMap = Parameters<typeof setGlobalStatePropertyWhenReady>[0] &
  Parameters<typeof runWhenStyleInfrastructureReady>[0] &
  OutsideClickMap & {
    addControl(control: MapLayersControl, position?: string): void;
    getContainer(): HTMLElement;
    setTerrain(terrain: { source: string; exaggeration: number } | null): unknown;
  };

// The raster-dem source added with the hillshade layer (main.ts addMapterhornTerrain).
const TERRAIN_SOURCE = 'hillshadeSource';

const BASE_LABELS: Record<MapBase, { label: string; hint: string }> = {
  map: { label: 'Map', hint: 'OpenStreetMap vector map' },
  satellite: { label: 'Satellite', hint: 'Aerial imagery only' },
  hybrid: { label: 'Hybrid', hint: 'Imagery with roads, boundaries and labels' },
};

const LABEL_NAMES: Record<LabelLanguage, string> = {
  bilingual: 'Latin + local',
  local: 'Local language',
  en: 'English',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  ru: 'Русский',
};

const { checkboxRow, group, rangeField, selectField } = createPanelFields('map-layers');

class MapLayersPanel {
  _settings: MapLayerSettings;
  _map: MapLayersMap;
  _control: HTMLElement;
  _button: HTMLButtonElement;
  _panel: HTMLElement;
  _summary: HTMLElement;
  _baseInputs = new Map<MapBase, HTMLInputElement>();
  _saturationInput: HTMLInputElement;
  _saturationValue: HTMLElement;
  _highlightRoadsInput: HTMLInputElement;
  _highlightBoundariesInput: HTMLInputElement;
  _labelSelect: HTMLSelectElement;
  _hillshadeInput: HTMLInputElement;
  _contoursInput: HTMLInputElement;
  _terrainInput: HTMLInputElement;
  _expanded = false;
  _boundEscape: (event: KeyboardEvent) => void;
  _boundAnyPanelOpen: (event: Event) => void;
  _removeOutsideClick: () => void;

  constructor(settings: MapLayerSettings) {
    this._settings = structuredClone(settings);
    this._boundEscape = (event) => {
      if (event.key === 'Escape' && this._expanded) this.setExpanded(false);
    };
    this._boundAnyPanelOpen = (event) => {
      if (isOtherUiPanelOpen(event, 'map-layers')) this.setExpanded(false);
    };
  }

  onAdd(map: MapLayersMap) {
    this._map = map;
    map.getContainer().addEventListener(UI_PANEL_OPEN_EVENT, this._boundAnyPanelOpen);
    window.addEventListener('keydown', this._boundEscape);

    ({ control: this._control, button: this._button } = createPanelButton(
      'maplibregl-ctrl-map-layers',
      'Layers',
      LayersIcon,
      'map-layers-icon',
    ));
    this._button.addEventListener('click', () => this.setExpanded(!this._expanded));

    const shell = createPanelShell(map.getContainer(), 'map-layers', {
      title: 'Layers',
      label: 'Layers',
      closeLabel: 'Close layers',
      onClose: () => this.setExpanded(false),
    });
    this._panel = shell.panel;
    this._summary = shell.summary;
    this._removeOutsideClick = onOutsideClick(
      map,
      () => [this._panel, this._control],
      () => this.setExpanded(false),
    );

    const baseGroup = group(shell.body, 'Base map');
    const baseName = `map-layers-base-${Math.random().toString(36).slice(2)}`;
    for (const base of MAP_BASES) {
      const input = checkboxRow(baseGroup, BASE_LABELS[base].label, BASE_LABELS[base].hint, 'radio');
      input.name = baseName;
      input.value = base;
      input.addEventListener('change', () => {
        if (input.checked) this._update((s) => (s.base = base));
      });
      this._baseInputs.set(base, input);
    }

    const saturation = rangeField(baseGroup, 'Saturation', { min: 0, max: 100, step: 5 });
    this._saturationInput = saturation.input;
    this._saturationValue = saturation.value;
    this._saturationInput.addEventListener('input', () =>
      this._update((s) => (s.saturation = Number(this._saturationInput.value) / 100)),
    );
    this._highlightRoadsInput = checkboxRow(baseGroup, 'Highlight roads', 'Roads in color; off, they are gray');
    this._highlightRoadsInput.addEventListener('change', () =>
      this._update((s) => (s.highlightRoads = this._highlightRoadsInput.checked)),
    );
    this._highlightBoundariesInput = checkboxRow(
      baseGroup,
      'Highlight administrative divisions',
      'Darker, slightly wider country and province borders',
    );
    this._highlightBoundariesInput.addEventListener('change', () =>
      this._update((s) => (s.highlightBoundaries = this._highlightBoundariesInput.checked)),
    );

    this._labelSelect = selectField(
      baseGroup,
      'Labels',
      LABEL_LANGUAGES.map((language) => [language, LABEL_NAMES[language]]),
    );
    this._labelSelect.addEventListener('change', () =>
      this._update((s) => (s.labels = this._labelSelect.value as LabelLanguage)),
    );

    const terrainGroup = group(shell.body, 'Terrain');
    this._hillshadeInput = checkboxRow(terrainGroup, 'Hillshade', 'Shaded relief');
    this._hillshadeInput.addEventListener('change', () =>
      this._update((s) => (s.hillshade = this._hillshadeInput.checked)),
    );
    this._contoursInput = checkboxRow(terrainGroup, 'Contour lines', 'Elevation lines and heights from zoom 8');
    this._contoursInput.addEventListener('change', () =>
      this._update((s) => (s.contours = this._contoursInput.checked)),
    );
    this._terrainInput = checkboxRow(terrainGroup, '3D terrain', 'Tilt with right-drag or two fingers');
    this._terrainInput.addEventListener('change', () =>
      this._update((s) => (s.terrain3d = this._terrainInput.checked)),
    );

    if (this._settings.terrain3d) this._applyTerrain();
    this._sync();
    return this._control;
  }

  onRemove() {
    this._removeOutsideClick?.();
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
    if (next) emitUiPanelOpen(this._map.getContainer(), 'map-layers');
    this._sync();
  }

  _update(mutate: (settings: MapLayerSettings) => void) {
    const previous = { ...this._settings };
    const previousState = mapLayerGlobalState(this._settings);
    mutate(this._settings);
    for (const [name, value] of Object.entries(mapLayerGlobalState(this._settings))) {
      if (previousState[name] !== value) setGlobalStatePropertyWhenReady(this._map, name, value);
    }
    if (previous.terrain3d !== this._settings.terrain3d) this._applyTerrain();
    saveMapLayerSettings(this._settings);
    this._sync();
  }

  _applyTerrain() {
    const enabled = this._settings.terrain3d;
    runWhenStyleInfrastructureReady(this._map, () => {
      this._map.setTerrain(enabled ? { source: TERRAIN_SOURCE, exaggeration: 1.0 } : null);
    });
  }

  _sync() {
    const settings = this._settings;
    this._button.classList.toggle('maplibregl-ctrl-map-layers-enabled', this._expanded);
    this._button.setAttribute('aria-pressed', this._expanded ? 'true' : 'false');
    this._panel.classList.toggle('map-layers-panel-visible', this._expanded);
    this._panel.setAttribute('aria-hidden', this._expanded ? 'false' : 'true');
    this._panel.inert = !this._expanded;
    this._map.getContainer().dataset.mapLayersPanelOpen = this._expanded ? 'true' : 'false';

    for (const [base, input] of this._baseInputs) input.checked = settings.base === base;
    const saturationPercent = Math.round(settings.saturation * 100);
    this._saturationInput.value = String(saturationPercent);
    this._saturationValue.textContent = `${saturationPercent}%`;
    this._highlightRoadsInput.checked = settings.highlightRoads;
    this._highlightBoundariesInput.checked = settings.highlightBoundaries;
    this._labelSelect.value = settings.labels;
    this._hillshadeInput.checked = settings.hillshade;
    this._contoursInput.checked = settings.contours;
    this._terrainInput.checked = settings.terrain3d;

    this._summary.textContent = [
      BASE_LABELS[settings.base].label,
      settings.saturation < 1 && `${Math.round(settings.saturation * 100)}% color`,
      settings.labels !== 'bilingual' && LABEL_NAMES[settings.labels],
      settings.hillshade && 'hillshade',
      settings.contours && 'contours',
      settings.terrain3d && '3D',
    ]
      .filter(Boolean)
      .join(' · ');
  }
}

export function createMapLayers(settings: MapLayerSettings) {
  return new MapLayersPanel(settings);
}

export function installMapLayers(map: MapLayersMap, settings: MapLayerSettings) {
  map.addControl(createMapLayers(settings), 'top-right');
}
