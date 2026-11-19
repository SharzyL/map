import { describe, expect, it } from 'vitest';
import { metres } from './geo.js';
import { JP, loadJp, match } from './osm-stations.js';

// The tests run on fixtures/stations/, the stations the other fixtures name;
// data_builder/stations/check-stations.py checks the files the build makes.
describe('JP', () => {
  it('gives typed OSM ids at the station', () => {
    const shibuya = JP.get('22715');
    // One Yahoo code per complex, one OSM node per operator
    expect(shibuya.osm.length).toBeGreaterThan(1);
    expect(shibuya.osm.every((r) => /^[NWR][0-9]+$/.test(r))).toBe(true);
    expect(metres(shibuya.lat, shibuya.lon, 35.6585, 139.7018)).toBeLessThan(300);
  });
});

describe('match', () => {
  it('places a code at the centre of its placed features', () => {
    const coords = new Map<string, [number, number]>([
      ['N1', [35.0, 139.0]],
      ['N2', [35.002, 139.004]],
    ]);
    expect(match(['N1', 'N2', 'N3'], coords)).toEqual({ osm: ['N1', 'N2', 'N3'], lat: 35.001, lon: 139.002 });
    expect(match(['N3'], coords)).toEqual({ osm: ['N3'], lat: null, lon: null });
  });
});

describe('loadJp', () => {
  it('joins the codes of every feature', () => {
    const jp = loadJp(
      'osm_type,osm_id,name,codes,status\nN,1,日暮里,22862;29616,several\nN,2,日暮里,22862,unique\n',
      'osm_type,osm_id,lat,lon\nN,1,35.0,139.0\nN,2,35.002,139.004\n',
    );
    expect(jp.get('22862')).toEqual({ osm: ['N1', 'N2'], lat: 35.001, lon: 139.002 });
    expect(jp.get('29616')).toEqual({ osm: ['N1'], lat: 35.0, lon: 139.0 });
  });
});
