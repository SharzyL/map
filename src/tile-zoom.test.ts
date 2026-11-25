import { describe, expect, it, vi } from 'vitest';
import { installSteadyTileZoom, steadyTileZoom } from './tile-zoom.js';

describe('steadyTileZoom', () => {
  // As MapLibre's level of detail: near the middle a little above the map's
  // zoom, farther off (a pitched view's distance) lower.
  const lod = (offset: number) => steadyTileZoom(() => 7.98 + offset);

  it('takes the map’s zoom for tiles MapLibre would pick within half a level of it', () => {
    // At z7.98 MapLibre takes z8 tiles in the middle, without the layers ending at z8.
    expect(lod(0.08)(7.98, 0, 0, 0, 36.87)).toBe(7.98);
    expect(lod(-0.3)(7.98, 0, 0, 0, 36.87)).toBe(7.98);
  });

  it('keeps coarser tiles for a pitched view’s distance', () => {
    expect(lod(-2.4)(7.98, 0, 0, 0, 36.87)).toBeCloseTo(5.58);
  });
});

describe('installSteadyTileZoom', () => {
  it('wraps the level of detail of vector sources only', () => {
    const sources: Record<string, { calculateTileZoom?: (...args: number[]) => number }> = {
      orm: {},
      dem: {},
    };
    const map = {
      getStyle: () => ({ sources: { orm: { type: 'vector' }, dem: { type: 'raster-dem' } } }),
      getSource: (id: string) => sources[id],
      setSourceTileLodParams: vi.fn((_max: number, _ratio: number, id: string) => {
        sources[id].calculateTileZoom = (center: number) => center + 0.08;
      }),
    };
    installSteadyTileZoom(map);
    expect(map.setSourceTileLodParams).toHaveBeenCalledTimes(1);
    expect(sources.orm.calculateTileZoom(7.98, 0, 0, 0, 36.87)).toBe(7.98);
    expect(sources.dem.calculateTileZoom).toBeUndefined();
  });
});
