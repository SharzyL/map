// OSRM request and formatting helpers for the annotation Route tool.

export const DEFAULT_OSRM_ENDPOINT = 'https://router.project-osrm.org';

export type LngLatLike = { lng: number; lat: number };
export type OsrmProfile = 'driving' | 'walking' | 'cycling';
type Coordinates = [number, number];
type OsrmLineStringGeometry = { type?: string; coordinates?: Coordinates[] };
type OsrmWaypoint = { name?: string; location?: number[]; distance?: number };
type OsrmRoute = {
  geometry?: OsrmLineStringGeometry;
  distance?: number;
  duration?: number;
};
export type OsrmRouteResponse = {
  code?: string;
  message?: string;
  routes?: OsrmRoute[];
  waypoints?: OsrmWaypoint[];
};

export function normalizeEndpoint(value: string | null | undefined) {
  const endpoint = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  if (!endpoint) return DEFAULT_OSRM_ENDPOINT;
  try {
    const url = new URL(endpoint, window.location.href);
    return url.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_OSRM_ENDPOINT;
  }
}

export function formatDistance(meters: number | string | null | undefined) {
  if (meters == null) return '';
  const value = Number(meters);
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.round(value)} m`;
  if (value < 10000) return `${(value / 1000).toFixed(1)} km`;
  return `${Math.round(value / 1000)} km`;
}

export function formatDuration(seconds: number | string | null | undefined) {
  if (seconds == null) return '';
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '';
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function buildRouteUrl(endpoint: string, from: LngLatLike, to: LngLatLike, profile: OsrmProfile = 'driving') {
  const coordinates = [from, to].map((point) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`).join(';');
  const url = new URL(`/route/v1/${profile}/${coordinates}`, normalizeEndpoint(endpoint));
  url.searchParams.set('alternatives', 'false');
  url.searchParams.set('steps', 'true');
  url.searchParams.set('annotations', 'duration,distance,speed,nodes');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  return url.href;
}
