import { describe, expect, it } from 'vitest';
import coordsCsv from '../../../data/station-coords.csv?raw';
import { metres } from './geo.js';
import { csvRows, JP, loadJp, match } from './osm-stations.js';

const SHIBUYA = JP.get('22715');

describe('JP', () => {
  it('gives typed OSM ids', () => {
    const matches = [...JP.values()];
    const refs = matches.flatMap((m) => m.osm);
    expect(refs.length).toBeGreaterThan(9000);
    expect(refs.every((r) => /^[NWR][0-9]+$/.test(r))).toBe(true);
    // One Yahoo code per complex, one OSM node per operator
    expect(SHIBUYA.osm.length).toBeGreaterThan(1);
    // Nearly every code gets a position
    expect(matches.filter((m) => m.lat === null).length).toBeLessThan(matches.length / 100);
  });

  it('keeps the features of a code in one place', () => {
    // The builder keeps features within 3 km of Yahoo's point of the code
    expect(metres(SHIBUYA.lat, SHIBUYA.lon, 35.6585, 139.7018)).toBeLessThan(300);
    const coords = new Map(csvRows(coordsCsv).map((r) => [r.osm_type + r.osm_id, [+r.lat, +r.lon]]));
    const spread = [...JP]
      .filter(([, m]) => m.osm.every((r) => coords.has(r)))
      .map(([code, m]) => {
        const pts = m.osm.map((r) => coords.get(r));
        return [code, Math.max(...pts.flatMap((a) => pts.map((b) => metres(a[0], a[1], b[0], b[1]))))] as const;
      });
    expect(spread.filter(([, d]) => d > 6000)).toEqual([]);
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
