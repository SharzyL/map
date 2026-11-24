// Stations' ranks: how many passenger routes stop at each station element,
// from the relations step (data_builder/relations, in D1 as osm_station_ranks).
// A relation's stops carry theirs from the build; a train route's stops get
// theirs here, by their OSM elements, so the map can place the busiest
// stations' labels first. A database without the table (before its import)
// gives none rather than failing the route.

import { DataUnavailable, type Query } from './core.js';

const MAX_PARAMS = 90;

type Stop = { elements?: unknown };

// The stops with their rank, the busiest of their elements; null for a stop
// without elements, or when the ranks are not there.
export async function withRanks<T extends Stop>(stops: T[], db: Query): Promise<Array<T & { rank: number | null }>> {
  const elementsOf = (stop: T) =>
    Array.isArray(stop.elements) ? stop.elements.filter((e): e is string => typeof e === 'string') : [];
  const unique = [...new Set(stops.flatMap(elementsOf))].sort();
  const ranks = new Map<string, number>();
  try {
    for (let k = 0; k < unique.length; k += MAX_PARAMS) {
      const chunk = unique.slice(k, k + MAX_PARAMS);
      const marks = chunk.map(() => '?').join(',');
      for (const row of await db(`SELECT element, rank FROM osm_station_ranks WHERE element IN (${marks})`, chunk)) {
        ranks.set(String(row.element), Number(row.rank));
      }
    }
  } catch (e) {
    if (!(e instanceof DataUnavailable)) throw e;
    return stops.map((stop): T & { rank: number | null } => ({ ...stop, rank: null }));
  }
  return stops.map((stop): T & { rank: number | null } => {
    const elements = elementsOf(stop);
    return { ...stop, rank: elements.length ? Math.max(0, ...elements.map((e) => ranks.get(e) ?? 0)) : null };
  });
}
