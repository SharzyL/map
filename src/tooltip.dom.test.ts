// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { setTooltip, tooltipPosition, tooltipText } from './tooltip.js';

const tip = () => document.querySelector<HTMLElement>('.tooltip');
const over = (target: Element, pointerType = 'mouse') =>
  target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }));

afterEach(() => {
  document.body.replaceChildren();
});

describe('setTooltip', () => {
  it('shows at once over the element, and switches at once to the next', () => {
    const first = document.createElement('button');
    const second = document.createElement('button');
    document.body.appendChild(first);
    document.body.appendChild(second);
    setTooltip(first, '08:00 G301 北京西 → 广州南\n高速动车组（G）');
    setTooltip(second, 'Other');
    over(first);
    expect(tip().hidden).toBe(false);
    // The first line of several is the head.
    expect(Array.from(tip().children).map((row) => [row.className, row.textContent])).toEqual([
      ['tooltip-head', '08:00 G301 北京西 → 广州南'],
      ['', '高速动车组（G）'],
    ]);
    over(second);
    expect(tip().textContent).toBe('Other');
    // Somewhere without one
    over(document.body);
    expect(tip().hidden).toBe(true);
  });

  it('shows for a child of the element, but not for touch', () => {
    const button = document.createElement('button');
    const inner = document.createElement('span');
    button.appendChild(inner);
    document.body.appendChild(button);
    setTooltip(button, 'Hi');
    over(inner, 'touch');
    expect(tip()?.hidden ?? true).toBe(true);
    over(inner);
    expect(tip().hidden).toBe(false);
  });

  it('builds content when shown, and describes the element by plain text', () => {
    const plain = document.createElement('span');
    const built = document.createElement('span');
    document.body.appendChild(plain);
    document.body.appendChild(built);
    setTooltip(plain, 'One\nTwo');
    expect(plain.getAttribute('aria-description')).toBe('One. Two');
    setTooltip(built, () => {
      const b = document.createElement('b');
      b.textContent = 'Built';
      return b;
    });
    expect(tooltipText(built)).toBe('Built');
    over(built);
    expect(tip().querySelector('b').textContent).toBe('Built');
  });

  it('hides on a press and on Escape, and goes when taken away', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.title = 'native';
    setTooltip(button, 'Hi');
    // No browser tooltip beside it
    expect(button.hasAttribute('title')).toBe(false);
    over(button);
    document.dispatchEvent(new PointerEvent('pointerdown'));
    expect(tip().hidden).toBe(true);
    over(document.body);
    over(button);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tip().hidden).toBe(true);
    setTooltip(button, null);
    expect(tooltipText(button)).toBeNull();
    expect(button.hasAttribute('data-tooltip')).toBe(false);
  });
});

describe('tooltipPosition', () => {
  const view = { width: 400, height: 300 };
  const tip = { width: 100, height: 30 };

  it('goes above the element, centred on it', () => {
    expect(tooltipPosition({ left: 150, top: 100, width: 40, bottom: 120 }, tip, view)).toEqual({
      left: 120,
      top: 64,
      below: false,
    });
  });

  it('goes below where there is no room above, and stays inside the window', () => {
    expect(tooltipPosition({ left: 0, top: 10, width: 20, bottom: 30 }, tip, view)).toEqual({
      left: 8,
      top: 36,
      below: true,
    });
    expect(tooltipPosition({ left: 390, top: 100, width: 10, bottom: 120 }, tip, view).left).toBe(292);
  });
});
