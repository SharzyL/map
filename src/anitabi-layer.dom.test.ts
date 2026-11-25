// @vitest-environment happy-dom

import { featureFilter, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it, vi } from 'vitest';
import type { AnitabiPoint, AnitabiWork } from './anitabi.js';
import {
  ANITABI_FILTER,
  ANITABI_LAYER,
  ANITABI_PRIORITY_FILTER,
  ANITABI_SOURCE,
  addAnitabiToStyle,
  anitabiFeatures,
  anitabiPopupContent,
  formatSceneTime,
  installAnitabi,
  loadImage,
} from './anitabi-layer.js';

const POINT: AnitabiPoint = {
  id: 'm4jxh3w',
  geo: [34.668813, 134.959308],
  priority: 472,
  name: '小久保西交差点',
  cn: '小久保西路口',
  image: '/images/points/419801/m4jxh3w_1.webp',
  ep: 2,
  s: 484,
  mark: '向南拍摄',
  origin: 'Shiro',
  originLink: 'https://example.com/a',
  uid: 1057,
};
const WORK: AnitabiWork = {
  id: 419801,
  cn: '无法向繁星许愿的恋情',
  title: 'この恋を星には願わない',
  city: '兵庫県',
  color: '#be8476',
  cat: '漫画系列',
  tags: [],
  priority: 90458,
  points: [POINT, { id: 'bare', geo: [34.6, 134.9], priority: 999 }],
};

describe('style', () => {
  it('adds a valid source and layer, shown only while switched on', () => {
    const style = addAnitabiToStyle({
      version: 8,
      sources: {},
      layers: [],
      state: { showAnitabi: { default: false } },
    });
    expect(validateStyleMin(style as never)).toEqual([]);
    expect(style.layers.at(-1)).toMatchObject({ id: ANITABI_LAYER, source: ANITABI_SOURCE });
  });

  it('thins spots by priority as anitabi does', () => {
    const filter = featureFilter(ANITABI_PRIORITY_FILTER as never, 'filter');
    const shown = (priority: number, zoom: number) =>
      filter.filter({ zoom }, { type: 1, properties: { priority }, geometry: [] } as never);
    expect([shown(70000, 1), shown(50000, 1), shown(50000, 2)]).toEqual([true, false, true]);
    expect([shown(4, 15), shown(4, 16), shown(1, 16), shown(1, 17)]).toEqual([false, true, false, true]);
  });

  it('shows only the selected work’s spots, all of them at every zoom', () => {
    const shown = (aid: number, priority: number, zoom: number, anitabiWork: number) =>
      featureFilter(ANITABI_FILTER as never, 'filter', { anitabiWork }).filter({ zoom }, {
        type: 1,
        properties: { aid, priority },
        geometry: [],
      } as never);
    expect([shown(1, 4, 15, 0), shown(1, 4, 16, 0)]).toEqual([false, true]);
    expect([shown(1, 4, 2, 1), shown(2, 99999, 2, 1)]).toEqual([true, false]);
  });

  it('draws spots with a screenshot over those without', () => {
    const { features } = anitabiFeatures([WORK]);
    expect(features.map((f) => f.properties.pid)).toEqual(['bare', 'm4jxh3w']);
    expect(features[1]).toMatchObject({
      geometry: { coordinates: [134.959308, 34.668813] },
      properties: { aid: 419801, color: '#be8476', priority: 472 },
    });
  });
});

describe('info box', () => {
  it('shows the scene, the work and its Bangumi page', () => {
    const box = anitabiPopupContent(WORK, POINT, new Map([[1057, '卜卜口']]));
    expect(box.querySelector('.orm-popup-title').textContent).toBe('小久保西路口');
    expect(box.querySelector('.anitabi-popup-subtitle').textContent).toBe('小久保西交差点');
    expect(box.querySelector('.orm-popup-label').textContent).toBe('无法向繁星许愿的恋情');
    expect(box.querySelector<HTMLImageElement>('.anitabi-popup-image img').src).toBe(
      'https://img-tc.anitabi.cn/points/419801/m4jxh3w_1.webp?plan=h360',
    );
    const fields = Object.fromEntries(
      [...box.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]),
    );
    expect(fields).toMatchObject({
      Episode: 'EP 2',
      Time: '8:04',
      Note: '向南拍摄',
      Source: 'Shiro',
      Contributor: '卜卜口',
      Title: 'この恋を星には願わない',
      Type: '漫画系列',
      Area: '兵庫県',
      Spots: '2',
    });
    const links = Object.fromEntries([...box.querySelectorAll('a')].map((a) => [a.textContent, a.href]));
    expect(links).toMatchObject({
      'bgm.tv/subject/419801': 'https://bgm.tv/subject/419801',
      'Open in anitabi': 'https://www.anitabi.cn/map?bangumiId=419801&pid=m4jxh3w',
      Shiro: 'https://example.com/a',
    });
  });

  it('opens the spot’s work from its name, when it can', () => {
    expect(anitabiPopupContent(WORK, POINT).querySelector('.anitabi-popup-work')).toBeNull();
    const openWork = vi.fn();
    const box = anitabiPopupContent(WORK, POINT, new Map(), openWork);
    const button = box.querySelector<HTMLButtonElement>('.orm-popup-label .anitabi-popup-work');
    expect(button.textContent).toBe('无法向繁星许愿的恋情');
    expect(button.title).toBe('Show 无法向繁星许愿的恋情: all 2 of its spots');
    button.click();
    expect(openWork).toHaveBeenCalledWith(WORK);
  });

  it('shows a spot without details by its place', () => {
    const box = anitabiPopupContent(WORK, WORK.points[1]);
    expect(box.querySelector('.orm-popup-title').textContent).toBe('Pilgrimage spot');
    expect(box.querySelector('.anitabi-popup-image')).toBeNull();
    expect([...box.querySelectorAll('dt')].map((dt) => dt.textContent)).toContain('Position');
  });

  it('formats times in the episode', () => {
    expect([formatSceneTime(undefined), formatSceneTime(59), formatSceneTime(3725)]).toEqual([
      undefined,
      '0:59',
      '1:02:05',
    ]);
  });
});

describe('loadImage', () => {
  const status = (frame: HTMLElement) => frame.querySelector('.anitabi-image-status');

  it('shows a spinner until the image arrives', () => {
    const frame = document.createElement('span');
    const img = loadImage(frame, 'https://img-tc.anitabi.cn/a.jpg?plan=h160', 'Scene');
    expect(img.src).toBe('https://img-tc.anitabi.cn/a.jpg?plan=h160');
    expect(status(frame).querySelector('.anitabi-image-spinner')).not.toBeNull();
    expect(status(frame).textContent).toBe('');
    expect(frame.classList.contains('anitabi-image-loaded')).toBe(false);
    img.dispatchEvent(new Event('load'));
    expect(status(frame)).toBeNull();
    expect(frame.classList.contains('anitabi-image-loaded')).toBe(true);
  });

  it('says when there is no image, or leaves that to the caller', () => {
    const frame = document.createElement('span');
    loadImage(frame, 'https://img-tc.anitabi.cn/gone.jpg').dispatchEvent(new Event('error'));
    expect(frame.querySelector('img')).toBeNull();
    expect(status(frame).textContent).toBe('No image');
    expect(status(frame).querySelector('.anitabi-image-spinner')).toBeNull();

    const onError = vi.fn();
    const other = document.createElement('span');
    loadImage(other, 'https://img-tc.anitabi.cn/gone.jpg', '', onError).dispatchEvent(new Event('error'));
    expect(onError).toHaveBeenCalledOnce();
    expect(status(other).querySelector('.anitabi-image-spinner')).not.toBeNull();
  });

  it('drops the info box’s frame when its screenshot fails', () => {
    const box = anitabiPopupContent(WORK, POINT);
    expect(box.querySelector('.anitabi-popup-image .anitabi-image-spinner')).not.toBeNull();
    box.querySelector('.anitabi-popup-image img').dispatchEvent(new Event('error'));
    expect(box.querySelector('.anitabi-popup-image')).toBeNull();
  });
});

describe('installAnitabi', () => {
  const INDEX = [[[1, 'A', 0, 'A', 0, '#f00', 0, 0, 'TV', 1, 2, 3, ['p1', 35, 139, 10], 0, [], 0, null, 0]], 250, 5];
  const CHUNK = [[1, 0, [['p1', '駅', 0, 0, 0, 0, 0, 0, 1, '', 0, 0, 0, 0, 0]], 5]];

  function setup(fail = false) {
    const setData = vi.fn();
    const map = { _styleInitialized: true, isStyleLoaded: () => true, once: () => {}, getSource: () => ({ setData }) };
    const fetchFile = vi.fn(async (file: string) => {
      if (fail && file !== 'users.csv') return new Response('', { status: 502 });
      const body = file === 'g.json' ? INDEX : file === 'g0.json' ? CHUNK : '1,someone';
      return new Response(typeof body === 'string' ? body : JSON.stringify(body));
    });
    const cache = { read: async (): Promise<null> => null, write: async () => {} };
    const anitabi = installAnitabi(map as never, { fetchFile: fetchFile as never, cache });
    const statuses: string[] = [];
    anitabi.onStatus((status) => statuses.push(status.state));
    return { anitabi, setData, fetchFile, statuses };
  }

  it('loads nothing until switched on, then fills the layer once', async () => {
    const { anitabi, setData, fetchFile, statuses } = setup();
    anitabi.setEnabled(false);
    expect(fetchFile).not.toHaveBeenCalled();
    anitabi.setEnabled(true);
    anitabi.setEnabled(true);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('ready'));
    expect(fetchFile.mock.calls.map(([file]) => file).sort()).toEqual(['g.json', 'g0.json', 'users.csv']);
    expect(setData.mock.lastCall[0].features).toHaveLength(1);
    const box = anitabi.content({ source: ANITABI_SOURCE, properties: { aid: 1, pid: 'p1' } });
    expect(box.querySelector('.orm-popup-title').textContent).toBe('駅');
    // The work's name opens it once something offers to
    expect(box.querySelector('.anitabi-popup-work')).toBeNull();
    const openWork = vi.fn();
    anitabi.setWorkOpener(openWork);
    anitabi
      .content({ source: ANITABI_SOURCE, properties: { aid: 1, pid: 'p1' } })
      .querySelector<HTMLButtonElement>('.anitabi-popup-work')
      .click();
    expect(openWork).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(anitabi.matches({ source: 'openrailwaymap' })).toBe(false);
    expect(anitabi.content({ source: ANITABI_SOURCE, properties: { aid: 1, pid: 'gone' } })).toBeNull();
  });

  it('says when it failed, and tries again when switched on again', async () => {
    const { anitabi, fetchFile, statuses } = setup(true);
    anitabi.setEnabled(true);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('failed'));
    const asked = fetchFile.mock.calls.length;
    anitabi.setEnabled(true);
    await vi.waitFor(() => expect(fetchFile.mock.calls.length).toBeGreaterThan(asked));
  });
});
