import { describe, expect, it } from 'vitest';
import { parseTilePath, tileCacheControl } from './tiles.js';

describe('tileCacheControl', () => {
  it('keeps versioned tiles for a year and others for a day', () => {
    expect(tileCacheControl(new URL('https://map.shz.al/tiles/openrailwaymap/7/108/49.mvt?v=20261113a'))).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(tileCacheControl(new URL('https://map.shz.al/tiles/openrailwaymap/7/108/49.mvt'))).toBe(
      'public, max-age=86400',
    );
  });
});

describe('parseTilePath', () => {
  it('reads tile and TileJSON paths', () => {
    expect(parseTilePath('/tiles/openrailwaymap/7/108/49.mvt')).toEqual({
      ok: true,
      name: 'openrailwaymap',
      tile: [7, 108, 49],
      ext: 'mvt',
    });
    expect(parseTilePath('/tiles/openrailwaymap.json')).toEqual({
      ok: true,
      name: 'openrailwaymap',
      tile: null,
      ext: 'json',
    });
    expect(parseTilePath('/assets/index.js')).toEqual({ ok: false });
  });
});
