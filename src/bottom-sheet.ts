// On phones the info box (popup.ts) and the map panels (map-panel.ts) are
// sheets along the bottom of the map. A grabber along a sheet's top taps or
// drags it down to its head and back up, like Apple Maps' sheets. style.css
// moves a sheet with `translate` (by --sheet-peek when collapsed, by
// --sheet-drag while dragged), which adds to whatever transform it already
// has, and keeps the sheet's bottom padding (the home indicator's safe area)
// in view below its head.
export const SHEET_MEDIA_QUERY = '(max-width: 640px)';
const DRAG_THRESHOLD = 24;

export function isSheetLayout() {
  return window.matchMedia?.(SHEET_MEDIA_QUERY).matches ?? false;
}

export type SheetOptions = {
  // Named in the grabber's label: "Collapse <label>".
  label: string;
  // How much of the sheet shows when collapsed, from its top.
  peek: () => number;
  // Where a drag can start besides the grabber, such as a panel's header.
  handles?: HTMLElement[];
  // Where a tap opens a collapsed sheet again.
  expandZone?: HTMLElement;
};

export function installSheetCollapse(sheet: HTMLElement, grabber: HTMLButtonElement, options: SheetOptions) {
  const { label, peek, handles = [], expandZone = sheet } = options;
  grabber.type = 'button';
  grabber.classList.add('sheet-grabber');

  const isCollapsed = () => sheet.classList.contains('sheet-collapsed');
  const setCollapsed = (collapsed: boolean) => {
    if (collapsed) sheet.style.setProperty('--sheet-peek', `${peek()}px`);
    sheet.classList.toggle('sheet-collapsed', collapsed);
    grabber.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${label}`);
    grabber.setAttribute('aria-expanded', String(!collapsed));
  };
  setCollapsed(false);
  const collapsedOffset = () => {
    const inset = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
    return Math.max(0, sheet.getBoundingClientRect().height - peek() - inset);
  };

  // A tap on the grabber toggles (as a click, so keys work too); a drag goes
  // the way it moved, or to the nearer end when it moved only a little.
  let drag: { pointerId: number; startY: number; from: number; max: number; offset: number } = null;
  let dragged = false;
  const startDrag = (handle: HTMLElement) => (event: PointerEvent) => {
    if (!isSheetLayout() || event.button > 0) return;
    if (handle !== grabber && (event.target as Element).closest?.('button, a, input, select, [role="button"]')) return;
    const max = collapsedOffset();
    const from = isCollapsed() ? max : 0;
    drag = { pointerId: event.pointerId, startY: event.clientY, from, max, offset: from };
    dragged = false;
    handle.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!dragged && Math.abs(event.clientY - drag.startY) <= 4) return;
    dragged = true;
    drag.offset = Math.min(drag.max, Math.max(0, drag.from + event.clientY - drag.startY));
    sheet.classList.add('sheet-dragging');
    sheet.style.setProperty('--sheet-drag', `${drag.offset}px`);
  };
  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { from, max, offset } = drag;
    drag = null;
    sheet.classList.remove('sheet-dragging');
    if (!dragged) return;
    // Past the click this drag ends in (below).
    setTimeout(() => (dragged = false));
    const moved = offset - from;
    setCollapsed(Math.abs(moved) >= DRAG_THRESHOLD ? moved > 0 : offset > max / 2);
  };
  for (const handle of [grabber, ...handles]) {
    handle.addEventListener('pointerdown', startDrag(handle));
    handle.addEventListener('pointermove', moveDrag);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
  // A drag ends in a click on the element it started on; that click is the
  // drag's, not a tap.
  sheet.addEventListener(
    'click',
    (event) => {
      if (!dragged) return;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
  grabber.addEventListener('click', () => setCollapsed(!isCollapsed()));
  expandZone.addEventListener('click', (event) => {
    if (!isCollapsed() || event.target === grabber) return;
    if ((event.target as Element).closest?.('a, button, [role="button"]')) return;
    setCollapsed(false);
  });

  return { setCollapsed, isCollapsed };
}

// The sheets open on a phone, oldest first. Only the latest shows: those
// under it slide away (`sheet-covered`, style.css) until it closes, as a card
// pushed onto Apple Maps' stack covers the one it was opened from; then the
// one below comes back as it was left, collapsed or not.
const openSheets: HTMLElement[] = [];

function uncoverTop() {
  openSheets.forEach((sheet, index) => sheet.classList.toggle('sheet-covered', index < openSheets.length - 1));
}

export function sheetOpened(sheet: HTMLElement) {
  const index = openSheets.indexOf(sheet);
  if (index >= 0) openSheets.splice(index, 1);
  openSheets.push(sheet);
  uncoverTop();
}

export function sheetClosed(sheet: HTMLElement) {
  const index = openSheets.indexOf(sheet);
  if (index < 0) return;
  openSheets.splice(index, 1);
  sheet.classList.remove('sheet-covered');
  uncoverTop();
}
