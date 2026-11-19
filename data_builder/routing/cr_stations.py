"""All China Railway stations matched to OSM, for routing.

cr-station-trains.csv (from ../stations/cr-station-trains.py) only lists the stations
trains stop at. Routing also needs those they pass: the stations along each
line tell which way the train runs where two lines go between the same stops
(广昆线 by 双湄村 and 禄丰南, or 成昆线's old line, from 昆明 to 广通北). This
runs the same matching over the stations in the routing graph, which came
with the railway extract, and keeps every station: the stops as
cr-station-trains.csv has them, the rest from this match.

usage: cr_stations.py graph.pkl lltskb-csv-dir cr-station-trains.csv out.csv
"""

from __future__ import annotations

import argparse
import collections
import csv
import importlib.util
from pathlib import Path

from graph import Graph

_spec = importlib.util.spec_from_file_location(
    "cr_station_trains", Path(__file__).resolve().parent.parent / "stations" / "cr-station-trains.py"
)
station_trains = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(station_trains)


def in_china(lat: float, lon: float) -> bool:
    """Not in Japan or Taiwan, whose kanji and hanzi names could match: the
    extract's bounding box takes them in."""
    japan = (lon >= 129 and lat <= 41.8) or (lon >= 139 and lat <= 45.7)
    taiwan = lon >= 119.9 and lat <= 25.4
    return not (japan or taiwan)


def graph_stations(g: Graph) -> list[dict]:
    """The graph's stations in the shape station_trains.osm_stations gives."""
    stations = []
    for key, (lat, lon, t) in g.points.items():
        if t.get("railway") not in ("station", "halt") or not in_china(lat, lon):
            continue
        if (
            t.get("station") in station_trains.URBAN
            or t.get("subway") == "yes"
            or t.get("light_rail") == "yes"
        ):
            continue
        primary = {
            station_trains.norm(t[k])
            for k in ("name", "name:zh", "name:zh-Hans")
            if t.get(k)
        }
        other = {
            station_trains.norm(t[k]) for k in ("official_name", "old_name") if t.get(k)
        }
        other |= {station_trains.norm(n) for n in t.get("alt_name", "").split(";") if n}
        stations.append(
            {
                "type": key[0],
                "id": int(key[1:]),
                "lat": lat,
                "lon": lon,
                "primary": primary,
                "other": other - primary,
            }
        )
    return stations


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("graph", type=Path)
    ap.add_argument("timetable", type=Path)
    ap.add_argument("stops", type=Path)
    ap.add_argument("out", type=Path)
    args = ap.parse_args()

    g = Graph.load(args.graph)
    match, status, _ = station_trains.match_stations(args.timetable, graph_stations(g))
    stops: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
    with open(args.stops, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            stops[r["cr_name"]].append((r["osm_type"], r["osm_id"]))

    rows = []
    for name, elems in stops.items():
        rows += [(t, i, name) for t, i in elems]
    for name in sorted(set(match) - set(stops)):
        rows += [(s["type"], str(s["id"]), name) for s in match[name]]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["osm_type", "osm_id", "cr_name"])
        w.writerows(sorted(rows, key=lambda r: (r[2], r[0], r[1])))

    # How far this agrees with cr-station-trains.csv where both match a stop
    same = sum(
        1
        for name, elems in stops.items()
        if name in match
        and {(s["type"], str(s["id"])) for s in match[name]} & set(elems)
    )
    both = sum(1 for name in stops if name in match)
    added = set(match) - set(stops)
    print(
        f"{len(stops)} stops from {args.stops.name}; {len(added)} more stations matched;"
        f" by status: {dict(collections.Counter(status[n] for n in added))};"
        f" unmatched: {dict(collections.Counter(s for n, s in status.items() if n not in match))}"
    )
    print(f"stops matched here too: {both}, to the same OSM station: {same}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
