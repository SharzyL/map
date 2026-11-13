// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { CREDITS_ATTRIBUTION, installCredits } from './credits.js';
import { emitUiPanelOpen } from './ui-panels.js';

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // MapLibre's attribution line, which it re-renders as sources come and go.
  const attribution = document.createElement('div');
  attribution.className = 'maplibregl-ctrl-attrib-inner';
  attribution.innerHTML = CREDITS_ATTRIBUTION;
  container.appendChild(attribution);
  installCredits({ getContainer: () => container });
  const panel = container.querySelector<HTMLElement>('.credits-panel');
  const button = () => container.querySelector<HTMLButtonElement>('.attribution-credits');
  const isOpen = () => panel.classList.contains('credits-panel-visible');
  return { container, attribution, panel, button, isOpen };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('credits panel', () => {
  it('opens and closes from the attribution line, also after MapLibre re-renders it', () => {
    const { attribution, panel, button, isOpen } = setup();
    expect(isOpen()).toBe(false);
    expect(panel.inert).toBe(true);

    button().click();
    expect(isOpen()).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(button().getAttribute('aria-expanded')).toBe('true');

    attribution.innerHTML = `<a href="#">MapLibre</a> | ${CREDITS_ATTRIBUTION}`;
    button().click();
    expect(isOpen()).toBe(false);
  });

  it('closes with Escape, its close button, or another panel opening', () => {
    const { container, panel, button, isOpen } = setup();
    button().click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isOpen()).toBe(false);

    button().click();
    panel.querySelector<HTMLButtonElement>('.credits-close').click();
    expect(isOpen()).toBe(false);

    button().click();
    emitUiPanelOpen(container, 'map-layers');
    expect(isOpen()).toBe(false);
  });

  it('lists the credits the attribution line leaves out', () => {
    const { panel } = setup();
    const names = Array.from(panel.querySelectorAll('.credits-name'), (name) => name.textContent);
    expect(names).toEqual(
      expect.arrayContaining([
        '© OpenStreetMap contributors',
        '国土数値情報（鉄道データ）, 国土交通省',
        '© Mapterhorn',
      ]),
    );
    expect(panel.textContent).toContain('出典：国土数値情報（鉄道データ）（国土交通省）を加工して作成');
    expect(panel.textContent).not.toMatch(/lltskb/i);
  });
});
