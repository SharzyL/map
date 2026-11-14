// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { createPanelShell } from './map-panel.js';

describe('createPanelShell', () => {
  it('collapses to its header from the grabber and opens expanded again', async () => {
    const container = document.createElement('div');
    const { panel } = createPanelShell(container, 'timetable', {
      title: 'Timetable',
      label: 'Station timetable',
      closeLabel: 'Close timetable',
      onClose: () => {},
    });
    panel.setAttribute('aria-hidden', 'false');
    const grabber = panel.querySelector<HTMLButtonElement>('.sheet-grabber');
    expect(grabber.getAttribute('aria-label')).toBe('Collapse timetable');

    grabber.click();
    expect(panel.classList.contains('sheet-collapsed')).toBe(true);
    expect(grabber.getAttribute('aria-label')).toBe('Expand timetable');

    panel.querySelector<HTMLElement>('.timetable-title').click();
    expect(panel.classList.contains('sheet-collapsed')).toBe(false);

    grabber.click();
    panel.setAttribute('aria-hidden', 'true');
    await vi.waitFor(() => expect(panel.classList.contains('sheet-collapsed')).toBe(false));
  });
});
