export const UI_PANEL_OPEN_EVENT = 'ui-panel:open';

export type UiPanelId = 'annotations' | 'weather' | 'railways' | 'map-layers' | 'timetable' | 'route';

export type UiPanelOpenDetail = {
  id: UiPanelId;
};

export function emitUiPanelOpen(container: HTMLElement, id: UiPanelId) {
  container.dispatchEvent(new CustomEvent<UiPanelOpenDetail>(UI_PANEL_OPEN_EVENT, { detail: { id } }));
}

export function isOtherUiPanelOpen(event: Event, id: UiPanelId) {
  if (!(event instanceof CustomEvent)) return false;
  return event.detail?.id && event.detail.id !== id;
}

export type OutsideClickMap = {
  getContainer(): HTMLElement;
  on?(event: 'click', listener: () => void): unknown;
  off?(event: 'click', listener: () => void): unknown;
};

// Calls `close` on a press outside `parts` (a panel and its toggle button).
// On the map itself only MapLibre's click counts, which it skips after a drag,
// so panning to see a setting's effect keeps the panel open. Returns a
// function that removes the listeners.
export function onOutsideClick(map: OutsideClickMap, parts: () => Array<Element | undefined>, close: () => void) {
  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (parts().some((part) => part?.contains(target))) return;
    if (map.getContainer().querySelector('.maplibregl-canvas-container')?.contains(target)) return;
    close();
  };
  document.addEventListener('pointerdown', handlePointerDown, true);
  map.on?.('click', close);
  return () => {
    document.removeEventListener('pointerdown', handlePointerDown, true);
    map.off?.('click', close);
  };
}
