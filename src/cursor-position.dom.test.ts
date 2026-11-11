// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLocate, type LocateMap } from './cursor-position.js';

type Listener = (event: { lngLat: { lng: number; lat: number } }) => void;

function setup() {
  const container = document.createElement('div');
  const canvasContainer = document.createElement('div');
  container.appendChild(canvasContainer);
  document.body.appendChild(container);
  const listeners = new Map<string, Set<Listener>>();
  const controls: HTMLElement[] = [];
  const map: LocateMap = {
    addControl: (control) => controls.push(control.onAdd(map)),
    getContainer: () => container,
    getCanvasContainer: () => canvasContainer,
    getZoom: () => 10,
    on: (event, listener) => listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)),
    off: (event, listener) => listeners.get(event)?.delete(listener),
  };
  const fetchTile = vi.fn(async () => ({ width: 1, height: 1, data: new Float32Array([1234.4]) }));
  installLocate(map, fetchTile);
  const emit = (event: string, lng: number, lat: number) => {
    for (const listener of listeners.get(event) ?? []) listener({ lngLat: { lng, lat } });
  };
  return {
    button: controls[0].querySelector<HTMLButtonElement>('.maplibregl-ctrl-locate'),
    readout: container.querySelector<HTMLElement>('.cursor-position'),
    canvasContainer,
    emit,
    fetchTile,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('Locate control', () => {
  it('shows coordinates and elevation under the pointer while switched on', async () => {
    vi.useFakeTimers();
    const { button, readout, canvasContainer, emit, fetchTile } = setup();
    expect(readout.hidden).toBe(true);
    emit('mousemove', 139.7671, 35.6812);
    expect(readout.hidden).toBe(true);

    button.click();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(readout.textContent).toBe('Point at the map');

    emit('mousemove', 139.7671, 35.6812);
    expect(readout.querySelector('.cursor-position-coordinates').textContent).toBe('35.68120° N, 139.76710° E');
    expect(readout.querySelector('.cursor-position-elevation').textContent).toBe('Elevation …');
    // The tile is fetched once the pointer rests.
    expect(fetchTile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchTile).toHaveBeenCalledWith(12, 3638, 1612);
    expect(readout.querySelector('.cursor-position-elevation').textContent).toBe('Elevation 1,234 m');

    // Touch screens: a tap shows the tapped point.
    emit('click', 2.35, 48.85);
    expect(readout.querySelector('.cursor-position-coordinates').textContent).toBe('48.85000° N, 2.35000° E');

    canvasContainer.dispatchEvent(new Event('mouseleave'));
    expect(readout.textContent).toBe('Point at the map');

    button.click();
    expect(readout.hidden).toBe(true);
  });
});
