// Distances and encoded polylines

const EARTH_M = 6_371_000;

export type LatLon = [number, number];

const radians = (deg: number) => (deg * Math.PI) / 180;

export function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = radians(lat1);
  const p2 = radians(lat2);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// The sum of floats as Python's sum() gives it (3.12+): compensated, so the
// Worker agrees with the Python that checks the stored data
export function sum(values: Iterable<number>): number {
  let s = 0;
  let c = 0;
  for (const x of values) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}

// Rounds halves to even, as the Python that builds the stored data does
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Google encoded polyline of (lat, lon) points
export function encodePolyline(coords: readonly LatLon[], precision = 6): string {
  const factor = 10 ** precision;
  let out = '';
  let plat = 0;
  let plon = 0;
  for (const [lat, lon] of coords) {
    const ilat = roundHalfEven(lat * factor);
    const ilon = roundHalfEven(lon * factor);
    for (let d of [ilat - plat, ilon - plon]) {
      d = d < 0 ? ~(d << 1) : d << 1;
      while (d >= 0x20) {
        out += String.fromCharCode((0x20 | (d & 0x1f)) + 63);
        d >>= 5;
      }
      out += String.fromCharCode(d + 63);
    }
    plat = ilat;
    plon = ilon;
  }
  return out;
}

// (lat, lon) points of a Google encoded polyline
export function decodePolyline(text: string, precision = 6): LatLon[] {
  const factor = 10 ** precision;
  const out: LatLon[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < text.length) {
    const deltas: number[] = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = text.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += deltas[0];
    lon += deltas[1];
    out.push([lat / factor, lon / factor]);
  }
  return out;
}
