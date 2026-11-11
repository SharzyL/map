// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultRailwayFilterSettings,
  loadRailwayFilterSettings,
  RAILWAY_FILTER_STORAGE_KEY,
  type RailwayFilterSettings,
} from './railway-filter.js';
import { installRailwayFilter, type RailwayFilterMap } from './railway-filter-panel.js';
import { emitUiPanelOpen } from './ui-panels.js';

type TestMap = RailwayFilterMap & {
  container: HTMLElement;
  globalState: Record<string, unknown>;
  controls: HTMLElement[];
  clickListeners: Set<() => void>;
};

function createMap(): TestMap {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const map: TestMap = {
    container,
    globalState: {},
    controls: [],
    clickListeners: new Set(),
    _styleInitialized: true,
    isStyleLoaded: () => true,
    once: () => {},
    setGlobalStateProperty(name, value) {
      map.globalState[name] = value;
    },
    addControl(control) {
      map.controls.push(control.onAdd(map));
    },
    getContainer: () => container,
    on(event: string, listener: () => void) {
      if (event === 'click') map.clickListeners.add(listener);
    },
    off(event: string, listener: () => void) {
      if (event === 'click') map.clickListeners.delete(listener);
    },
  };
  return map;
}

function setup(settings: RailwayFilterSettings = defaultRailwayFilterSettings()) {
  const map = createMap();
  installRailwayFilter(map, settings);
  const panel = map.container.querySelector<HTMLElement>('.railway-filter-panel');
  const button = map.controls[0].querySelector<HTMLButtonElement>('.maplibregl-ctrl-railways');
  const checkbox = (label: string) => {
    const row = Array.from(panel.querySelectorAll('label')).find((node) =>
      node.querySelector('.railway-filter-check-label')?.textContent?.startsWith(label),
    );
    return row.querySelector('input');
  };
  const selects = panel.querySelectorAll('select');
  return {
    map,
    panel,
    button,
    checkbox,
    colorSelect: selects[0],
    speedSelect: selects[1],
    gaugeSelect: selects[2],
    trafficSelect: selects[3],
    electrificationSelect: selects[4],
    operatorInput: panel.querySelector<HTMLInputElement>('input[type="search"]'),
  };
}

function toggle(input: HTMLInputElement) {
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change'));
}

function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('railway filter panel', () => {
  it('opens from the control button and closes when another panel opens', () => {
    const { map, panel, button } = setup();
    expect(panel.classList.contains('railway-filter-panel-visible')).toBe(false);

    button.click();
    expect(panel.classList.contains('railway-filter-panel-visible')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(map.container.dataset.railwayFilterPanelOpen).toBe('true');

    emitUiPanelOpen(map.container, 'map-layers');
    expect(panel.classList.contains('railway-filter-panel-visible')).toBe(false);
  });

  it('closes on a press outside it or a map click, but not when the map is dragged', () => {
    const { map, panel, button, colorSelect } = setup();
    const canvasContainer = document.createElement('div');
    canvasContainer.className = 'maplibregl-canvas-container';
    map.container.appendChild(canvasContainer);
    const press = (target: EventTarget) => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const isOpen = () => panel.classList.contains('railway-filter-panel-visible');

    button.click();
    press(colorSelect);
    expect(isOpen()).toBe(true);
    // A press on the map may start a drag; only MapLibre's click closes the panel.
    press(canvasContainer);
    expect(isOpen()).toBe(true);
    for (const listener of map.clickListeners) listener();
    expect(isOpen()).toBe(false);

    button.click();
    press(document.body);
    expect(isOpen()).toBe(false);
  });

  it('pushes changed settings to global state and remembers them', () => {
    const { map, panel, checkbox, speedSelect, electrificationSelect } = setup();

    toggle(checkbox('Service tracks'));
    choose(speedSelect, '200');
    toggle(checkbox('Keep lines without this data'));
    choose(electrificationSelect, 'electrified');
    toggle(checkbox('Abandoned'));

    expect(map.globalState).toEqual({
      railwayShowService: false,
      railwayMinSpeed: 200,
      railwayIncludeUnknown: false,
      railwayElectrification: 'electrified',
      showAbandonedInfrastructure: true,
    });
    expect(panel.querySelector('.railway-filter-summary').textContent).toBe('4 filters active');

    const saved = loadRailwayFilterSettings();
    expect(saved.categories.service).toBe(false);
    expect(saved.minSpeed).toBe(200);
    expect(saved.electrification).toBe('electrified');
    expect(localStorage.getItem(RAILWAY_FILTER_STORAGE_KEY)).not.toBeNull();
  });

  it('applies gauge, traffic and a typed operator after a pause', async () => {
    const { map, gaugeSelect, trafficSelect, operatorInput, checkbox } = setup();
    expect(checkbox('Keep lines without this data').disabled).toBe(true);

    choose(gaugeSelect, 'broad');
    choose(trafficSelect, 'freight');
    expect(checkbox('Keep lines without this data').disabled).toBe(false);

    operatorInput.value = 'RZD';
    operatorInput.dispatchEvent(new Event('input'));
    expect(map.globalState.railwayOperator).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(map.globalState).toEqual({ railwayGauge: 'broad', railwayTraffic: 'freight', railwayOperator: 'rzd' });
    expect(loadRailwayFilterSettings().operator).toBe('RZD');
  });

  it('suggests operators of the lines in view', () => {
    const map = createMap();
    map.queryRenderedFeatures = () => [
      { sourceLayer: 'railway_line_high', properties: { operator: 'SNCF Réseau' } },
      { sourceLayer: 'railway_line_high', properties: { operator: 'SNCF Réseau\u001eSBB' } },
      { sourceLayer: 'standard_railway_text_stations', properties: { operator: 'Station Operator' } },
    ];
    installRailwayFilter(map, defaultRailwayFilterSettings());
    map.controls[0].querySelector<HTMLButtonElement>('.maplibregl-ctrl-railways').click();
    const options = Array.from(map.container.querySelectorAll('datalist option')).map((option) =>
      option.getAttribute('value'),
    );
    expect(options).toEqual(['SNCF Réseau', 'SBB']);
  });

  it('hides the overlay and disables the other filters', () => {
    const { map, panel, button, checkbox, speedSelect } = setup();

    toggle(checkbox('Show railway overlay'));
    expect(map.globalState).toEqual({ railwayOverlay: false });
    expect(checkbox('Main lines').disabled).toBe(true);
    expect(speedSelect.disabled).toBe(true);
    expect(panel.querySelector('.railway-filter-summary').textContent).toBe('Overlay hidden');
    expect(button.classList.contains('maplibregl-ctrl-railways-filtered')).toBe(true);
  });

  it('only enables razed tracks while abandoned tracks are shown', () => {
    const { checkbox } = setup();
    expect(checkbox('Razed').disabled).toBe(true);
    toggle(checkbox('Abandoned'));
    expect(checkbox('Razed').disabled).toBe(false);
  });

  it('starts from the given settings and resets them to the defaults', () => {
    const settings = defaultRailwayFilterSettings();
    settings.categories.main = false;
    settings.minSpeed = 160;
    settings.colorBy = 'speed';
    const { map, panel, checkbox, speedSelect, colorSelect } = setup(settings);
    expect(checkbox('Main lines').checked).toBe(false);
    expect(speedSelect.value).toBe('160');
    expect(colorSelect.value).toBe('speed');

    panel.querySelector<HTMLButtonElement>('.railway-filter-reset').click();
    expect(map.globalState).toEqual({ railwayShowMain: true, railwayMinSpeed: 0 });
    expect(checkbox('Main lines').checked).toBe(true);
    expect(colorSelect.value).toBe('speed');
    expect(panel.querySelector('.railway-filter-summary').textContent).toBe('All railways shown');
  });

  it('switches line colors and shows a legend for attribute colors', () => {
    const { map, panel, colorSelect } = setup();
    const legend = panel.querySelector<HTMLElement>('.railway-filter-legend');
    const legendLabels = () =>
      Array.from(legend.querySelectorAll('.railway-filter-legend-item')).map((item) => item.textContent);
    expect(colorSelect.value).toBe('default');
    expect(legend.hidden).toBe(false);
    expect(legendLabels()).toEqual(['Lines take the color of their route; others are colored by usage.']);

    choose(colorSelect, 'gauge');
    expect(map.globalState).toEqual({ railwayColorBy: 'gauge' });
    expect(legend.hidden).toBe(false);
    expect(legendLabels()).toContain('Standard (1435 mm)');
    expect(panel.querySelector('.railway-filter-summary').textContent).toBe('All railways shown');
    expect(loadRailwayFilterSettings().colorBy).toBe('gauge');

    choose(colorSelect, 'electrification');
    expect(legendLabels()).toContain('AC 15 kV 16.7 Hz');
    expect(legendLabels()).not.toContain('Standard (1435 mm)');

    choose(colorSelect, 'usage');
    expect(legend.hidden).toBe(true);
    expect(map.globalState).toEqual({ railwayColorBy: 'usage' });
  });
});
