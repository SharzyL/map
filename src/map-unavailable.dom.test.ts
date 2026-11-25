// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { isGpuInitializationError, showMapUnavailable, WEBGL_HELP_URL } from './map-unavailable.js';

const gpuError = (statusMessage: string | null = null) =>
  Object.assign(new Error('WebGL2 is required to display this map.'), {
    name: 'GPUInitializationError',
    statusMessage,
  });

const text = (root: Element, selector: string) =>
  Array.from(root.querySelectorAll(selector)).map((node) => node.textContent);

describe('showMapUnavailable', () => {
  it('says the browser cannot draw the map without WebGL 2, and what to do', () => {
    const container = document.createElement('div');
    const overlay = showMapUnavailable(container, gpuError('Could not create a WebGL context'));
    expect(overlay.getAttribute('role')).toBe('alert');
    expect(text(overlay, '.map-unavailable-title')).toEqual(['This browser cannot draw the map']);
    expect(text(overlay, '.map-unavailable-tips li')).toHaveLength(3);
    // What the browser said about it
    expect(text(overlay, '.map-unavailable-detail')).toEqual(['Could not create a WebGL context']);
    expect(overlay.querySelector('a').href).toBe(WEBGL_HELP_URL);
  });

  it('says the map could not start for anything else, with Reload', () => {
    const container = document.createElement('div');
    const overlay = showMapUnavailable(container, new Error('style failed'));
    expect(text(overlay, '.map-unavailable-title')).toEqual(['The map could not start']);
    expect(text(overlay, '.map-unavailable-detail')).toEqual(['style failed']);
    expect(overlay.querySelector('.map-unavailable-reload')).not.toBeNull();
  });

  it('shows one message at a time', () => {
    const container = document.createElement('div');
    showMapUnavailable(container, new Error('first'));
    showMapUnavailable(container, gpuError());
    expect(container.querySelectorAll('.map-unavailable')).toHaveLength(1);
  });

  it('tells MapLibre’s GPU error from others by its name', () => {
    expect(isGpuInitializationError(gpuError())).toBe(true);
    expect(isGpuInitializationError(new Error('x'))).toBe(false);
    expect(isGpuInitializationError(null)).toBe(false);
  });
});
