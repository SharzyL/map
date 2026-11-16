import { describe, expect, it } from 'vitest';
import stars from './stars.json';
import { cameraBasis, milkyWay, siderealDegrees, starGroups } from './starfield.js';

const J2000 = Date.UTC(2000, 0, 1, 12);
const RAD = Math.PI / 180;

function direction(ra: number, dec: number) {
  return [Math.cos(dec * RAD) * Math.cos(ra * RAD), Math.cos(dec * RAD) * Math.sin(ra * RAD), Math.sin(dec * RAD)];
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('the sky around the globe', () => {
  it('turns with Greenwich sidereal time', () => {
    expect(siderealDegrees(J2000)).toBeCloseTo(280.4606, 3);
    // A sidereal day is about 3 min 56 s shorter than a solar one.
    expect(siderealDegrees(J2000 + 86_164_091)).toBeCloseTo(280.4606, 1);
  });

  // As the sky looks from below, on a star chart: north up, east on the left.
  it('shows the stars beyond the Earth, north up, east on the left', () => {
    // Looking straight down at 0°, 0° at J2000 noon: the sky behind the Earth
    // is at the right ascension opposite Greenwich's sidereal time.
    const { look, right, up } = cameraBasis({ lng: 0, lat: 0, bearing: 0, pitch: 0 }, J2000);
    const behind = 280.4606 + 180;
    expect(dot(look, direction(behind, 0))).toBeCloseTo(1, 6);
    expect(dot(up, direction(behind, 10))).toBeGreaterThan(0);
    expect(dot(right, direction(behind + 10, 0))).toBeLessThan(0);
  });

  it('looks toward the bearing as the camera tilts', () => {
    // Tilted to the horizon facing north from the equator: Polaris ahead.
    const polaris = direction(37.95, 89.26);
    expect(dot(cameraBasis({ lng: 30, lat: 0, bearing: 0, pitch: 90 }, J2000).look, polaris)).toBeGreaterThan(0.99);
    expect(dot(cameraBasis({ lng: 30, lat: 0, bearing: 180, pitch: 90 }, J2000).look, polaris)).toBeLessThan(-0.99);
  });

  it('draws every catalog star once, the brightest largest', () => {
    const groups = starGroups(stars as number[]);
    expect(groups.reduce((sum, group) => sum + group.points.length / 3, 0)).toBe((stars as number[]).length / 4);
    expect(groups.at(-1).radius).toBeGreaterThan(groups[0].radius);
    expect(milkyWay(300).reduce((sum, group) => sum + group.points.length / 3, 0)).toBeGreaterThanOrEqual(300);
  });
});
