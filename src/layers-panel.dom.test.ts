// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { installLayersPanel } from './layers-panel.js';

type TestMap = {
  container: HTMLElement;
  controls: HTMLElement[];
  addControl(control: { onAdd(map: TestMap): HTMLElement }): void;
};

function section(className: string, bodyClass: string, children: string[] = []) {
  const panel = document.createElement('section');
  panel.className = className;
  panel.setAttribute('aria-hidden', 'true');
  const header = document.createElement('div');
  header.className = `${className}-header`;
  const body = document.createElement('div');
  body.className = bodyClass;
  for (const child of children) {
    const node = document.createElement(child === 'url' ? 'form' : 'div');
    node.className = `layer-manager-${child === 'url' ? 'url-form' : child}`;
    body.appendChild(node);
  }
  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

function control(panel: HTMLElement) {
  return {
    panelElement: panel,
    added: 0,
    onAdd(map: TestMap) {
      this.added += 1;
      map.container.appendChild(panel);
      return document.createElement('div');
    },
    onRemove() {},
  };
}

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const map: TestMap = {
    container,
    controls: [],
    addControl(control) {
      map.controls.push(control.onAdd(map));
    },
  };
  const layerManager = control(
    section('layer-manager-panel', 'layer-manager-body', ['import-row', 'url', 'status', 'empty', 'list', 'details']),
  );
  const mapLayers = control(section('map-layers-panel', 'map-layers-body'));
  const routingStates: boolean[] = [];
  const routing = {
    ...control(section('routing-panel', 'routing-body')),
    setExpanded: (on: boolean) => routingStates.push(on),
  };
  installLayersPanel(map, { layerManager, mapLayers, routing });
  const body = layerManager.panelElement.querySelector('.layer-manager-body');
  const setOpen = async (open: boolean) => {
    layerManager.panelElement.setAttribute('aria-hidden', open ? 'false' : 'true');
    await Promise.resolve();
  };
  const navigation = body.querySelector<HTMLDetailsElement>('.layers-panel-navigation');
  const toggleNavigation = (open: boolean) => {
    navigation.open = open;
    navigation.dispatchEvent(new Event('toggle'));
  };
  return { map, body, layerManager, mapLayers, routing, routingStates, setOpen, toggleNavigation };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('layers panel', () => {
  it('puts map toggles first, then layers, then the Import and Navigation folds', () => {
    const { map, body, mapLayers, routing } = setup();
    expect(map.controls).toHaveLength(1);
    expect(mapLayers.added).toBe(1);
    expect(routing.added).toBe(1);
    const order = Array.from(body.children).map((node) => node.className.split(' ').at(-1));
    expect(order).toEqual([
      'layers-panel-map',
      'layer-manager-empty',
      'layer-manager-list',
      'layer-manager-details',
      'layers-panel-import',
      'layer-manager-status',
      'layers-panel-navigation',
    ]);
    const importFold = body.querySelector('.layers-panel-import');
    expect(importFold.querySelector('.layer-manager-import-row')).not.toBeNull();
    expect(importFold.querySelector('.layer-manager-url-form')).not.toBeNull();
    expect(body.querySelector('.layers-panel-navigation .routing-panel')).not.toBeNull();
    expect(map.container.querySelector('.map-layers-panel')).toBeNull();
  });

  it('marks embedded content so the layer manager leaves its controls alone', () => {
    const { body } = setup();
    expect(body.querySelector<HTMLElement>('.layers-panel-map').dataset.embeddedPanel).toBe('map-layers');
    expect(body.querySelector<HTMLElement>('.routing-panel').dataset.embeddedPanel).toBe('routing');
  });

  it('activates routing only while the panel is open and Navigation is unfolded', async () => {
    const { setOpen, toggleNavigation, routingStates, body } = setup();
    expect(routingStates.at(-1)).toBe(false);
    expect(body.querySelector<HTMLElement>('.layers-panel-map').inert).toBe(true);

    await setOpen(true);
    expect(routingStates.at(-1)).toBe(false);
    expect(body.querySelector<HTMLElement>('.layers-panel-map').inert).toBe(false);

    toggleNavigation(true);
    expect(routingStates.at(-1)).toBe(true);

    await setOpen(false);
    expect(routingStates.at(-1)).toBe(false);

    await setOpen(true);
    expect(routingStates.at(-1)).toBe(true);

    toggleNavigation(false);
    expect(routingStates.at(-1)).toBe(false);
  });
});
