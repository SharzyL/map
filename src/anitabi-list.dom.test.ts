// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnitabiWork } from './anitabi.js';
import type { AnitabiController } from './anitabi-layer.js';
import { inkOn, installAnitabiList, mainSpots, workBounds, worksInView } from './anitabi-list.js';

function work(id: number, points: Array<[number, number]>, extra: Partial<AnitabiWork> = {}): AnitabiWork {
  return {
    id,
    cn: `作品${id}`,
    title: `Work ${id}`,
    tags: [],
    priority: 999,
    color: '#336699',
    points: points.map((geo, i) => ({ id: `${id}-${i}`, geo, priority: 999 })),
    ...extra,
  };
}

const TOKYO: Array<[number, number]> = [
  [35.68, 139.76],
  [35.69, 139.7],
  [35.66, 139.7],
  [35.71, 139.8],
  [35.73, 139.71],
];
const A = work(1, TOKYO, { cover: '/images/bangumi/1.jpg', cat: 'TV', city: '東京都' });
const B = work(2, TOKYO.slice(0, 2), { priority: 5000 });
const C = work(3, TOKYO.slice(0, 2), { priority: 10 });
const WORKS = new Map([A, B, C].map((w) => [w.id, w]));

const spot = (aid: number, pid: string) => ({ properties: { aid, pid } });

describe('worksInView', () => {
  it('counts each work’s spots once, the most first, then by anitabi’s rank', () => {
    const list = worksInView(
      [spot(1, '1-0'), spot(1, '1-0'), spot(1, '1-1'), spot(1, '1-2'), spot(2, '2-0'), spot(3, '3-0'), spot(9, 'x')],
      (id) => WORKS.get(id),
    );
    expect(list.map(({ work: w, spots }) => [w.id, spots])).toEqual([
      [1, 3],
      [2, 1],
      [3, 1],
    ]);
  });
});

describe('framing a work', () => {
  it('leaves out the far-flung spots, as anitabi does', () => {
    // Tokyo, with one spot at Heathrow
    const points: Array<[number, number]> = [...TOKYO, [51.47, -0.49]];
    expect(mainSpots(points)).toEqual(TOKYO);
    expect(workBounds(work(4, points))).toEqual([
      [139.7, 35.66],
      [139.8, 35.73],
    ]);
    // Too few to judge, or spread evenly: all of them
    expect(mainSpots(points.slice(4))).toEqual(points.slice(4));
    expect(workBounds(work(5, []))).toBeNull();
  });
});

describe('inkOn', () => {
  it('writes dark on light colors and white on dark ones', () => {
    expect(['#dddddd', '#ffeb3b', '#fff'].map(inkOn)).toEqual(['#0f172a', '#0f172a', '#0f172a']);
    expect(['#336699', '#be8476', '#000', 'red'].map(inkOn)).toEqual(['#fff', '#fff', '#fff', '#fff']);
  });
});

describe('the panel', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function setup() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const listeners: Array<() => void> = [];
    const handlers: Record<string, () => void> = {};
    let selected: number | null = null;
    let enabled = false;
    const anitabi = {
      get enabled() {
        return enabled;
      },
      get selectedWork() {
        return selected;
      },
      onChange: (listener: () => void) => listeners.push(listener),
      work: (id: number) => WORKS.get(id),
      selectWork: vi.fn((id: number | null) => {
        selected = id;
        listeners.forEach((l) => l());
      }),
    } as unknown as AnitabiController;
    let rendered = [spot(1, '1-0'), spot(1, '1-1'), spot(2, '2-0')];
    const map = {
      getContainer: () => container,
      addControl: (control: { onAdd(map: unknown): HTMLElement }) => container.appendChild(control.onAdd(map)),
      on: (type: string, handler: () => void) => (handlers[type] = handler),
      off: () => {},
      queryRenderedFeatures: vi.fn(() => rendered),
      fitBounds: vi.fn(),
    };
    installAnitabiList(map as never, anitabi);
    const setEnabled = (next: boolean) => {
      enabled = next;
      listeners.forEach((l) => l());
    };
    const setRendered = (next: typeof rendered) => (rendered = next);
    return { container, map, anitabi, setEnabled, setRendered, handlers };
  }

  const button = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('.maplibregl-ctrl-anitabi-list');
  const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.anitabi-list-item')];
  const summary = (container: HTMLElement) => container.querySelector('.anitabi-list-summary').textContent;

  it('has its button only while the spots show', () => {
    const { container, setEnabled } = setup();
    expect(button(container).parentElement.style.display).toBe('none');
    setEnabled(true);
    expect(button(container).parentElement.style.display).toBe('');
  });

  it('lists the works on screen and follows the map', async () => {
    const { container, setEnabled, setRendered, handlers } = setup();
    setEnabled(true);
    button(container).click();
    expect(summary(container)).toBe('2 works · 3 spots in view');
    const [first] = rows(container);
    expect(first.querySelector('.anitabi-list-name').textContent).toBe('作品1');
    expect(first.querySelector('.anitabi-list-meta').textContent).toBe('Work 1 · TV · 東京都');
    expect(first.querySelector('.anitabi-list-count').textContent).toBe('2');
    expect(first.querySelector('img').src).toBe('https://img-tc.anitabi.cn/bangumi/1.jpg?plan=h160');

    setRendered([spot(3, '3-0')]);
    handlers.render();
    await vi.waitFor(() => expect(summary(container)).toBe('1 work · 1 spot in view'));
  });

  it('shows one work’s spots on a click and every work’s on another', () => {
    const { container, map, anitabi, setEnabled } = setup();
    setEnabled(true);
    button(container).click();
    rows(container)[0].click();
    expect(anitabi.selectWork).toHaveBeenLastCalledWith(1);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [139.7, 35.66],
        [139.8, 35.73],
      ],
      expect.objectContaining({ maxZoom: 15 }),
    );
    expect(summary(container)).toBe('Only 作品1');
    // The list stays to pick another from.
    expect(rows(container).map((row) => row.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(button(container).classList.contains('maplibregl-ctrl-anitabi-list-filtered')).toBe(true);
    rows(container)[0].click();
    expect(anitabi.selectWork).toHaveBeenLastCalledWith(null);

    rows(container)[1].click();
    container.querySelector<HTMLButtonElement>('.anitabi-list-show-all').click();
    expect(anitabi.selectWork).toHaveBeenLastCalledWith(null);
  });

  it('closes when the spots are switched off', () => {
    const { container, setEnabled } = setup();
    setEnabled(true);
    button(container).click();
    expect(container.querySelector('.anitabi-list-panel').getAttribute('aria-hidden')).toBe('false');
    setEnabled(false);
    expect(container.querySelector('.anitabi-list-panel').getAttribute('aria-hidden')).toBe('true');
  });
});
