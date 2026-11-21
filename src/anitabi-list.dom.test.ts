// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnitabiPoint, AnitabiWork } from './anitabi.js';
import type { AnitabiChange, AnitabiController } from './anitabi-layer.js';
import { inkOn, installAnitabiList, mainSpots, spotsByEpisode, workBounds, worksInView } from './anitabi-list.js';

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

describe('spotsByEpisode', () => {
  it('groups numbered episodes in order, then named ones, then the rest, each by time', () => {
    const p = (id: string, ep?: string | number, s?: number): AnitabiPoint => ({ id, geo: [0, 0], priority: 1, ep, s });
    const groups = spotsByEpisode([
      p('a', 10, 30),
      p('b', 'OP'),
      p('c'),
      p('d', 2, 500),
      p('e', 2),
      p('f', 2, 100),
      p('g', 'ED'),
    ]);
    expect(groups.map((g) => [g.title, g.points.map((x) => x.id).join('')])).toEqual([
      ['EP 2', 'fde'],
      ['EP 10', 'a'],
      ['OP', 'b'],
      ['ED', 'g'],
      ['Other spots', 'c'],
    ]);
  });
});

describe('the panel', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  // A has details on two spots, in two episodes
  A.points[0] = {
    ...A.points[0],
    name: '東京駅',
    cn: '东京站',
    ep: 2,
    s: 484,
    image: '/images/points/1/a.jpg',
    mark: '丸の内側',
  };
  A.points[1] = { ...A.points[1], name: '新宿', ep: 1, folder: '都内' };

  function setup() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const listeners: Array<(change: AnitabiChange) => void> = [];
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
      status: { state: 'ready', text: '' },
      onStatus: () => {},
      onChange: (listener: (change: AnitabiChange) => void) => listeners.push(listener),
      work: (id: number) => WORKS.get(id),
      selectWork: vi.fn((id: number | null) => {
        selected = id;
        listeners.forEach((l) => l({}));
      }),
      spotContent: (w: AnitabiWork, point: AnitabiPoint) => {
        const box = document.createElement('div');
        box.textContent = `${w.id}/${point.id}`;
        return box;
      },
    } as unknown as AnitabiController;
    let rendered = [spot(1, '1-0'), spot(1, '1-1'), spot(2, '2-0')];
    const map = {
      getContainer: () => container,
      getZoom: () => 12,
      addControl: (control: { onAdd(map: unknown): HTMLElement }) => container.appendChild(control.onAdd(map)),
      on: (type: string, handler: () => void) => (handlers[type] = handler),
      off: () => {},
      queryRenderedFeatures: vi.fn(() => rendered),
      fitBounds: vi.fn(),
      flyTo: vi.fn(),
    };
    const list = installAnitabiList(map as never, anitabi);
    const openInfoBox = vi.fn();
    list.setInfoBox(openInfoBox);
    const setEnabled = (next: boolean, byUser = false) => {
      enabled = next;
      // As the layer does, switching off clears the selection.
      if (!next) selected = null;
      listeners.forEach((l) => l({ switchedOn: next && byUser }));
    };
    const setRendered = (next: typeof rendered) => (rendered = next);
    return { container, map, anitabi, setEnabled, setRendered, handlers, openInfoBox };
  }

  const button = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('.maplibregl-ctrl-anitabi-list');
  const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.anitabi-list-item')];
  const summary = (container: HTMLElement) => container.querySelector('.anitabi-list-summary').textContent;
  const isOpen = (container: HTMLElement) =>
    container.querySelector('.anitabi-list-panel').getAttribute('aria-hidden') === 'false';

  it('opens when the spots are switched on, but not for a setting restored at load', () => {
    const restored = setup();
    restored.setEnabled(true);
    expect(isOpen(restored.container)).toBe(false);
    expect(button(restored.container).parentElement.style.display).toBe('');
    document.body.replaceChildren();

    const switched = setup();
    expect(button(switched.container).parentElement.style.display).toBe('none');
    switched.setEnabled(true, true);
    expect(isOpen(switched.container)).toBe(true);
  });

  it('lists the works on screen and follows the map', async () => {
    const { container, setEnabled, setRendered, handlers } = setup();
    setEnabled(true, true);
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

  it('opens a work with every one of its spots, by episode, and goes back', () => {
    const { container, map, anitabi, setEnabled, setRendered } = setup();
    setEnabled(true, true);
    rows(container)[0].click();
    expect(anitabi.selectWork).toHaveBeenLastCalledWith(1);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [139.7, 35.66],
        [139.8, 35.73],
      ],
      expect.objectContaining({ maxZoom: 15 }),
    );
    expect(summary(container)).toBe('作品1 · 5 spots');
    expect(container.querySelector('.anitabi-work-title').textContent).toBe('作品1');
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.anitabi-work-links a')].map((a) => a.href);
    expect(links).toEqual(['https://bgm.tv/subject/1', 'https://www.anitabi.cn/map?bangumiId=1']);
    // All five spots, not only the two on screen
    const groups = [...container.querySelectorAll('.anitabi-spot-group-title')].map((h) => h.textContent);
    expect(groups).toEqual(['EP 1 · 1', 'EP 2 · 1', 'Other spots · 3']);
    const spots = [...container.querySelectorAll('.anitabi-spot')];
    expect(spots).toHaveLength(5);
    const tokyo = spots[1];
    expect(tokyo.querySelector('.anitabi-spot-name').textContent).toBe('东京站');
    expect(tokyo.querySelector('.anitabi-spot-meta').textContent).toBe('8:04 · 東京駅');
    expect(tokyo.querySelector('.anitabi-spot-note').textContent).toBe('丸の内側');
    expect(tokyo.querySelector('img').src).toBe('https://img-tc.anitabi.cn/points/1/a.jpg?plan=h160');
    expect(spots[0].querySelector('.anitabi-spot-meta').textContent).toBe('都内');

    // The map moving does not replace the work with the list.
    setRendered([spot(1, '1-0')]);
    expect(container.querySelector('.anitabi-work')).not.toBeNull();

    container.querySelector<HTMLButtonElement>('.anitabi-list-back').click();
    expect(anitabi.selectWork).toHaveBeenLastCalledWith(null);
    expect(container.querySelector('.anitabi-work')).toBeNull();
    expect(summary(container)).toBe('1 work · 1 spot in view');
  });

  it('flies to a spot and opens its info box', () => {
    const { container, map, setEnabled, openInfoBox } = setup();
    setEnabled(true, true);
    rows(container)[0].click();
    container.querySelectorAll<HTMLButtonElement>('.anitabi-spot')[1].click();
    expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [139.76, 35.68], zoom: 16 }));
    expect(openInfoBox).toHaveBeenCalledWith([139.76, 35.68], expect.any(HTMLElement));
    expect(openInfoBox.mock.lastCall[1].textContent).toBe('1/1-0');
  });

  it('closes, and leaves the work, when the spots are switched off', () => {
    const { container, setEnabled } = setup();
    setEnabled(true, true);
    rows(container)[0].click();
    setEnabled(false);
    expect(isOpen(container)).toBe(false);
    setEnabled(true);
    button(container).click();
    expect(container.querySelector('.anitabi-work')).toBeNull();
    expect(rows(container)).toHaveLength(2);
  });
});
