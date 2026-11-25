// What the page shows in the map's place when it cannot draw one: why, and
// what the reader can do about it. MapLibre needs WebGL 2 and throws a
// GPUInitializationError from the Map constructor without it (or raises it as
// an error event when a lost GPU context cannot be restored); anything else
// that stops the map from starting gets a shorter note and a Reload button.
import { el } from './map-panel.js';

export const WEBGL_HELP_URL = 'https://wiki.openstreetmap.org/wiki/This_map_requires_WebGL';

type GpuErrorLike = Error & { statusMessage?: string | null };

export const isGpuInitializationError = (error: unknown): error is GpuErrorLike =>
  error instanceof Error && error.name === 'GPUInitializationError';

export function showMapUnavailable(container: HTMLElement, error: unknown) {
  container.querySelector('.map-unavailable')?.remove();
  const overlay = el('div', 'map-unavailable', container);
  overlay.setAttribute('role', 'alert');
  const card = el('div', 'map-unavailable-card', overlay);
  if (isGpuInitializationError(error)) {
    el('h1', 'map-unavailable-title', card).textContent = 'This browser cannot draw the map';
    el('p', 'map-unavailable-text', card).textContent =
      'The map needs WebGL 2, which this browser does not offer or has turned off. You could:';
    const tips = el('ul', 'map-unavailable-tips', card);
    for (const tip of [
      'Turn on hardware (graphics) acceleration in the browser’s settings, then restart it.',
      'Update the browser, or open the map in a recent Chrome, Edge, Firefox or Safari.',
      'Check that no extension or policy blocks WebGL.',
    ]) {
      el('li', undefined, tips).textContent = tip;
    }
    if (error.statusMessage) el('p', 'map-unavailable-detail', card).textContent = error.statusMessage;
    const link = el('a', 'map-unavailable-link', card);
    link.href = WEBGL_HELP_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'More about WebGL and maps';
  } else {
    el('h1', 'map-unavailable-title', card).textContent = 'The map could not start';
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (message) el('p', 'map-unavailable-detail', card).textContent = message;
    const reload = el('button', 'map-unavailable-reload', card);
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.addEventListener('click', () => window.location.reload());
  }
  return overlay;
}
