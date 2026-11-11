import { describe, expect, it, vi } from 'vitest';
import {
  DemTileCache,
  demTilePosition,
  demZoom,
  formatCoordinates,
  formatElevation,
  sampleDemTile,
  type DemTileLike,
} from './cursor-position.js';

function tile(width: number, height: number, valueAt: (x: number, y: number) => number): DemTileLike {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = valueAt(x, y);
  return { width, height, data };
}

describe('cursor position formatting', () => {
  it('writes coordinates with hemispheres and wraps longitude', () => {
    expect(formatCoordinates({ lng: 139.76713, lat: 35.681236 })).toBe('35.68124° N, 139.76713° E');
    expect(formatCoordinates({ lng: -70.6693, lat: -33.4489 })).toBe('33.44890° S, 70.66930° W');
    expect(formatCoordinates({ lng: 190, lat: 0 })).toBe('0.00000° N, 170.00000° W');
  });

  it('rounds elevations to whole meters', () => {
    expect(formatElevation(8848.4)).toBe('8,848 m');
    expect(formatElevation(-27.6)).toBe('-28 m');
  });

  it('reads the DEM two zooms past the view, up to z12', () => {
    expect(demZoom(3.7)).toBe(5);
    expect(demZoom(11)).toBe(12);
    expect(demZoom(17)).toBe(12);
  });
});

describe('DEM sampling', () => {
  it('finds the Web Mercator tile and the position inside it', () => {
    expect(demTilePosition({ lng: 0, lat: 0 }, 1)).toEqual({ x: 1, y: 1, fx: 0, fy: 0 });
    const { x, y, fx, fy } = demTilePosition({ lng: 139.7671, lat: 35.6812 }, 12);
    expect([x, y]).toEqual([3638, 1612]);
    expect(fx).toBeGreaterThanOrEqual(0);
    expect(fy).toBeLessThan(1);
  });

  it('interpolates between pixel centers', () => {
    const ramp = tile(4, 4, (x) => x * 10);
    expect(sampleDemTile(ramp, 0.125, 0.5)).toBeCloseTo(0);
    expect(sampleDemTile(ramp, 0.25, 0.5)).toBeCloseTo(5);
    expect(sampleDemTile(ramp, 1, 0.5)).toBeCloseTo(30);
  });

  it('fetches each tile once, keeps failures and samples loaded tiles', async () => {
    const fetchTile = vi.fn(async (z: number, x: number) => {
      if (x === 0) throw new Error('missing');
      return tile(2, 2, () => 100 + z);
    });
    const cache = new DemTileCache(fetchTile);
    const east = { lng: 90, lat: 10 };
    const west = { lng: -90, lat: 10 };
    expect(cache.elevationAt(east, 1)).toBeUndefined();
    await Promise.all([cache.load(east, 1), cache.load(east, 1), cache.load(west, 1)]);
    expect(fetchTile).toHaveBeenCalledTimes(2);
    expect(cache.elevationAt(east, 1)).toBe(101);
    expect(cache.elevationAt(west, 1)).toBeNull();
  });
});
