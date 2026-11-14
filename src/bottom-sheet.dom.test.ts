// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { sheetClosed, sheetOpened } from './bottom-sheet.js';
import { createPanelShell } from './map-panel.js';

function panel(prefix: string) {
  const shell = createPanelShell(document.body, prefix, {
    title: prefix,
    label: prefix,
    closeLabel: `Close ${prefix}`,
    onClose: () => {},
  });
  return shell.panel;
}

const covered = (sheet: HTMLElement) => sheet.classList.contains('sheet-covered');
// The panels' observer reports a change of aria-hidden a microtask later.
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('the stack of open sheets', () => {
  it('shows only the latest, and the one below again once it closes', async () => {
    const timetable = panel('timetable');
    const info = document.createElement('div');
    timetable.setAttribute('aria-hidden', 'false');
    await settle();
    expect(covered(timetable)).toBe(false);

    // An info box opened over the timetable covers it, as it was left.
    timetable.classList.add('sheet-collapsed');
    sheetOpened(info);
    expect(covered(timetable)).toBe(true);
    expect(covered(info)).toBe(false);
    sheetClosed(info);
    expect(covered(timetable)).toBe(false);
    expect(timetable.classList.contains('sheet-collapsed')).toBe(true);

    // A panel shown again goes back on top.
    sheetOpened(info);
    timetable.setAttribute('aria-hidden', 'false');
    await settle();
    expect(covered(info)).toBe(true);
    expect(covered(timetable)).toBe(false);

    // Hiding the top one uncovers the one under it, and leaves nothing covered behind.
    timetable.setAttribute('aria-hidden', 'true');
    await settle();
    expect(covered(info)).toBe(false);
    expect(covered(timetable)).toBe(false);
    sheetClosed(info);
    sheetClosed(info);
    expect(covered(info)).toBe(false);
  });
});
