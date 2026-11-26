// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { hashHasMapView, hashOf, readHashParam, upgradeHash, withMapKey, writeHashParam } from './url-state.js';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the URL’s hash', () => {
  it('moves an old link’s view under the map’s key, keeping the rest', () => {
    expect(withMapKey('#12/35.68/139.76')).toBe('#map=12/35.68/139.76');
    expect(withMapKey('#4.5/-33.9/-70.1/30/45&tt=crs:北京西')).toBe('#map=4.5/-33.9/-70.1/30/45&tt=crs:北京西');
    expect(withMapKey('#map=12/35.68/139.76')).toBeNull();
    expect(withMapKey('')).toBeNull();
  });

  it('tells a hash with a view for the map from any other', () => {
    expect(hashHasMapView('#map=12/35.685/139.737')).toBe(true);
    expect(hashHasMapView('#tt=crs:北京西&map=4.5/-33.9/-70.1/30/45')).toBe(true);
    expect(hashHasMapView('#12/35.685/139.737')).toBe(false);
    expect(hashHasMapView('#tt=crs:北京西')).toBe(false);
    expect(hashHasMapView('')).toBe(false);
  });

  it('keeps a panel’s key beside the map’s, readable as MapLibre writes them', () => {
    window.history.replaceState(null, '', '/#map=12/35.68/139.76');
    writeHashParam('tt', 'jpd:22715:1051:渋谷');
    expect(decodeURIComponent(window.location.hash)).toBe('#map=12/35.68/139.76&tt=jpd:22715:1051:渋谷');
    expect(readHashParam('tt')).toBe('jpd:22715:1051:渋谷');
    expect(readHashParam('map')).toBe('12/35.68/139.76');
    writeHashParam('tt', null);
    expect(decodeURIComponent(window.location.hash)).toBe('#map=12/35.68/139.76');
    expect(hashOf(new URLSearchParams(''))).toBe('');
  });

  it('upgrades the page’s own old link in place', () => {
    window.history.replaceState(null, '', '/#9/34.7/135.5&route=jp-11002:937cb9');
    upgradeHash();
    expect(readHashParam('map')).toBe('9/34.7/135.5');
    expect(readHashParam('route')).toBe('jp-11002:937cb9');
  });
});
