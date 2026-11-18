import { describe, expect, it } from 'vitest';
import { archiveVersion, parseTilePath, tileCacheControl } from './tiles.js';

describe('tileCacheControl', () => {
  it('keeps versioned tiles for a year and others for a day', () => {
    expect(tileCacheControl(new URL('https://map.shz.al/tiles/openrailwaymap/7/108/49.mvt?v=20261113a'))).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(tileCacheControl(new URL('https://map.shz.al/tiles/openrailwaymap/7/108/49.mvt'))).toBe(
      'public, max-age=86400',
    );
  });

  it('keeps a tile for good only when it is of the version asked for', () => {
    const url = new URL('https://map.shz.al/tiles/openrailwaymap/7/108/49.mvt?v=0f3c2a9b7d41');
    expect(tileCacheControl(url, '0f3c2a9b7d41')).toBe('public, max-age=31536000, immutable');
    // A page opened before the archive was replaced
    expect(tileCacheControl(url, '9af4a742fbb8')).toBe('public, max-age=300');
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
    expect(parseTilePath('/tiles/openrailwaymap/version')).toEqual({
      ok: true,
      name: 'openrailwaymap',
      tile: null,
      ext: 'version',
    });
    expect(parseTilePath('/assets/index.js')).toEqual({ ok: false });
  });
});

describe('archiveVersion', () => {
  it('is the start of the ETag, safe in a URL', () => {
    expect(archiveVersion('"0f3c2a9b7d41e8aa55c0-412"')).toBe('0f3c2a9b7d41');
  });
});
