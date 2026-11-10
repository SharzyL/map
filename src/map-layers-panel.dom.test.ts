// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { defaultMapLayerSettings, loadMapLayerSettings, type MapLayerSettings } from './map-layers.js';
import { installMapLayers, type MapLayersMap } from './map-layers-panel.js';
import { emitUiPanelOpen } from './ui-panels.js';

type TestMap = MapLayersMap & {
  container: HTMLElement;
  globalState: Record<string, unknown>;
  terrain: unknown;
  controls: HTMLElement[];
};

function createMap(): TestMap {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const map: TestMap = {
    container,
    globalState: {},
    terrain: null,
    controls: [],
    _styleInitialized: true,
    isStyleLoaded: () => true,
    once: () => {},
    setGlobalStateProperty(name, value) {
      map.globalState[name] = value;
    },
    setTerrain(terrain) {
      map.terrain = terrain;
      return map;
    },
    addControl(control) {
      map.controls.push(control.onAdd(map));
    },
    getContainer: () => container,
  };
  return map;
}

function setup(settings: MapLayerSettings = defaultMapLayerSettings()) {
  const map = createMap();
  installMapLayers(map, settings);
  const panel = map.container.querySelector<HTMLElement>('.map-layers-panel');
  const input = (label: string) =>
    Array.from(panel.querySelectorAll('label'))
      .find((row) => row.querySelector('.map-layers-check-label')?.textContent === label)
      .querySelector('input');
  const summary = () => panel.querySelector('.map-layers-summary').textContent;
  return { map, panel, input, summary };
}

function choose(input: HTMLInputElement) {
  input.checked = !input.checked || input.type === 'radio';
  input.dispatchEvent(new Event('change'));
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('map display panel', () => {
  it('opens from its button and closes when another panel opens', () => {
    const { map, panel } = setup();
    map.controls[0].querySelector<HTMLButtonElement>('.maplibregl-ctrl-map-layers').click();
    expect(panel.classList.contains('map-layers-panel-visible')).toBe(true);
    emitUiPanelOpen(map.container, 'railways');
    expect(panel.classList.contains('map-layers-panel-visible')).toBe(false);
  });

  it('switches the base map and terrain layers through global state', () => {
    const { map, input, summary } = setup();
    expect(summary()).toBe('Map · hillshade · contours');

    choose(input('Hybrid'));
    choose(input('Hillshade'));
    expect(map.globalState).toEqual({ baseMap: 'hybrid', showHillshade: false });
    expect(input('Map').checked).toBe(false);
    expect(summary()).toBe('Hybrid · contours');
    expect(loadMapLayerSettings()).toMatchObject({ base: 'hybrid', hillshade: false });
  });

  it('sets base map saturation from the slider and the label language from the menu', () => {
    const { map, panel, summary } = setup();
    const slider = panel.querySelector<HTMLInputElement>('input[type="range"]');
    const value = panel.querySelector('.map-layers-range-value');
    expect(slider.value).toBe('100');
    expect(value.textContent).toBe('100%');

    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    expect(map.globalState).toEqual({ baseSaturation: 0.4 });
    expect(value.textContent).toBe('40%');

    const labels = panel.querySelector('select');
    labels.value = 'zh';
    labels.dispatchEvent(new Event('change'));
    expect(map.globalState).toEqual({ baseSaturation: 0.4, labelLanguage: 'zh' });
    expect(summary()).toBe('Map · 40% color · 中文 · hillshade · contours');
    expect(loadMapLayerSettings()).toMatchObject({ saturation: 0.4, labels: 'zh' });
  });

  it('starts from saved saturation and language', () => {
    const { panel } = setup({ ...defaultMapLayerSettings(), saturation: 0.25, labels: 'local' });
    expect(panel.querySelector<HTMLInputElement>('input[type="range"]').value).toBe('25');
    expect(panel.querySelector('select').value).toBe('local');
  });

  it('turns 3D terrain on and off with the DEM source', () => {
    const { map, input } = setup();
    choose(input('3D terrain'));
    expect(map.terrain).toEqual({ source: 'hillshadeSource', exaggeration: 1 });
    choose(input('3D terrain'));
    expect(map.terrain).toBeNull();
  });

  it('restores saved 3D terrain on start', () => {
    const { map } = setup({ ...defaultMapLayerSettings(), terrain3d: true });
    expect(map.terrain).toEqual({ source: 'hillshadeSource', exaggeration: 1 });
  });
});
