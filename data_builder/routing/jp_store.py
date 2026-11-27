"""What a Japanese train path needs from D1, tried on a local SQLite file.

Offline, every OSM service route is cut into hops between its consecutive
stops (Yahoo codes), each routed once along the route. A request then needs
no graph: it looks up the routes stopping at the train's stops, picks one per
leg (by type, name, direction and the previous leg), and joins the
picked route's hops. A leg whose joined hops are implausibly long against the
straight distance falls to the next route; legs no route covers come back
straight.

Some routes list their stops out of order (JR東海道本線's 116 stops); when a
route's hops add up to much more than its own track, its stops are put back
in order along the track. Loop lines (山手線) get a hop closing the loop.

Some trains no OSM route covers: サンライズ runs through 名古屋 and 大阪
without stopping, 特急鎌倉 takes the 武蔵野南線 freight line. jp-rules.csv
names their lines and ends; each is routed once along those lines, both
ways, and stored as a route stopping at every station on the way, which
trains matching the rule take before any other.

And a leg no service route covers at all, a stop missing from them (特急
オホーツク's route ends at 女満別, not 網走), takes the line it runs on: each
OSM line relation (route=railway) is stored as a route stopping at every
station on its track, in track order, marked `line` for a request to take
only where no service route will do.

Usage: jp_store.py build <graph.pkl> <jp-station-codes.csv> <out.sqlite>
"""

from __future__ import annotations

import collections
import csv
import itertools
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
from graph import PLATFORM_ROLES, ROUTES, STOP_ROLES, Graph, metres, to_xyz
from route import (
    OVERVIEW_TOLERANCE_DEG,
    Prefs,
    _coords,
    _end,
    _runs,
    distances,
    encode_polyline,
    route_leg,
)
from scipy.spatial import cKDTree
from shapely.geometry import LineString

# Hops adding up to more than this times the route's own track: out of order
REORDER_RATIO = 1.3
HOP_DETOUR_RATIO, HOP_DETOUR_SLACK_M = 2.5, 1000
REVERSAL_AT_STOP_M = 2000
# A rule's route keeps to its lines: off them costs this much more
RULE_OFF_HINT = 20.0

ROUTE_STOP_M = 300
NEAR_STOPS_M = 50_000


# Japan's stations by Yahoo code, and its OSM service routes with their stops
# on the routing graph
class Japan:
    def __init__(self, g: Graph, codes_csv: Path) -> None:
        self.g = g
        refs: dict[str, list[str]] = collections.defaultdict(list)
        with open(codes_csv, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                for code in r["codes"].split(";"):
                    refs[code].append(r["osm_type"] + r["osm_id"])
        self.elements = dict(refs)
        elem_codes: dict[str, set[str]] = collections.defaultdict(set)
        for code, elems in refs.items():
            for e in elems:
                elem_codes[e].add(code)
        # Stop areas: member -> areas, area -> its station elements
        areas_of: dict[str, list[int]] = collections.defaultdict(list)
        area_stations: dict[int, list[str]] = {}
        for aid, rel in g.relations.items():
            if rel.tags.get("public_transport") == "stop_area":
                members = [f"{t.upper()}{r}" for t, r, _ in rel.members]
                area_stations[aid] = [m for m in members if m in elem_codes]
                for m in members:
                    areas_of[m].append(aid)
        self.attach = {}
        self.position = {}
        for code, elems in refs.items():
            att = sorted({v for e in elems for v in g.attach.get(e, [])})
            pts = [g.points[e][:2] for e in elems if e in g.points]
            if att:
                self.attach[code] = att
            if pts:
                self.position[code] = (
                    sum(p[0] for p in pts) / len(pts),
                    sum(p[1] for p in pts) / len(pts),
                )

        # Passenger routes, their ways and the stations they stop at
        by_vertex: dict[int, set[str]] = collections.defaultdict(set)
        for code, att in self.attach.items():
            for v in att:
                by_vertex[v].add(code)
        # The stations attached at each vertex, for the lines' stations
        self.codes_at: dict[int, set[str]] = dict(by_vertex)
        codes = list(self.position)
        tree = cKDTree(
            to_xyz(
                np.array([self.position[c][0] for c in codes]),
                np.array([self.position[c][1] for c in codes]),
            )
        )
        self.route_ways: dict[int, frozenset[int]] = {}
        self.route_name: dict[int, str] = {}
        self.route_hs: dict[int, bool] = {}  # a 新幹線 service
        self.route_order: dict[int, dict[str, int]] = {}  # stop code -> position
        self.route_seq: dict[
            int, list[str]
        ] = {}  # stop codes in member order, repeats kept
        self.routes_at: dict[str, set[int]] = collections.defaultdict(set)
        for rid, rel in g.relations.items():
            if rel.tags.get("type") != "route" or rel.tags.get("route") not in ROUTES:
                continue
            ways = frozenset(
                ref for t, ref, _ in rel.members if t == "w" and ref in g.ways
            )
            if not ways:
                continue
            self.route_ways[rid] = ways
            self.route_name[rid] = rel.tags.get("name", "")
            # 新幹線 services are named for the service (のぞみ, こまち列車), so
            # go by track: mini-新幹線 like こまち run partly on conventional lines
            share = sum(g.ways[w].highspeed for w in ways) / len(ways)
            self.route_hs[rid] = share >= 0.3 or "新幹線" in self.route_name[rid]
            order = self.route_order[rid] = {}
            seq = self.route_seq[rid] = []
            for t, ref, role in rel.members:
                if role not in STOP_ROLES | PLATFORM_ROLES:
                    continue
                # A stop belongs to the stations of its stop area; without one,
                # to the nearest station only: attach points reach the main
                # tracks within 400 m, so at 名古屋 a 新幹線 stop would also
                # count for 名鉄名古屋
                elem = f"{t.upper()}{ref}"
                found = {
                    c
                    for a in areas_of.get(elem, ())
                    for e in area_stations[a]
                    for c in elem_codes.get(e, ())
                }
                if not found:
                    pos = g.vertex_pos.get(ref) if t == "n" else None
                    pos = pos or (g.points[elem][:2] if elem in g.points else None)
                    if not pos:
                        continue
                    near = tree.query_ball_point(
                        to_xyz(np.array([pos[0]]), np.array([pos[1]]))[0], ROUTE_STOP_M
                    )
                    candidates = {codes[k] for k in near} | set(
                        by_vertex.get(ref, ()) if t == "n" else ()
                    )
                    if not candidates:
                        continue
                    found = {
                        min(candidates, key=lambda c: metres(*pos, *self.position[c]))
                    }
                for c in sorted(found):
                    self.routes_at[c].add(rid)
                    order.setdefault(c, len(order))
                    seq.append(c)
        # Line relations too, for rules that name infrastructure lines
        self.line_ways: dict[int, frozenset[int]] = {}
        self.line_name: dict[int, str] = {}
        for rid, rel in g.relations.items():
            if rel.tags.get("route") == "railway":
                ways = frozenset(
                    ref for t, ref, _ in rel.members if t == "w" and ref in g.ways
                )
                if ways:
                    self.line_ways[rid] = ways
                    self.line_name[rid] = rel.tags.get("name", "")
        self.passenger_ways = frozenset(
            w for ways in self.route_ways.values() for w in ways
        )
        print(
            f"{len(self.attach)} Yahoo codes on track, {len(self.route_ways)} passenger routes",
            file=sys.stderr,
        )

    def near(self, ways: frozenset[int], stops: list[tuple[float, float]]) -> bool:
        """Whether any of the ways passes near the train's stops."""
        for w in list(ways)[:50]:
            way = self.g.ways[w]
            lat, lon = way.lat[0], way.lon[0]
            if any(metres(lat, lon, *p) < NEAR_STOPS_M for p in stops):
                return True
        return False


SCHEMA = """
CREATE TABLE jp_stations (code TEXT PRIMARY KEY, lat REAL, lon REAL, elements TEXT) WITHOUT ROWID;
CREATE TABLE jp_routes (
  id INTEGER PRIMARY KEY, name TEXT, shinkansen INTEGER, loop INTEGER, stops INTEGER,
  train TEXT,     -- for a route made from jp-rules.csv: the pattern of the trains taking it
  line INTEGER    -- 1 for a line relation's: taken only where no service route will do
);
CREATE TABLE jp_route_stops (code TEXT, route_id INTEGER, seq INTEGER, PRIMARY KEY (code, route_id, seq)) WITHOUT ROWID;
CREATE TABLE jp_hops (
  route_id INTEGER, seq INTEGER, from_code TEXT, to_code TEXT, length_m INTEGER,
  ways TEXT,      -- JSON: ways covered whole, in order
  partial TEXT,   -- JSON: encoded polylines of ways covered partly
  line TEXT,      -- encoded polyline, simplified for the overview
  start TEXT,     -- JSON [lon, lat]: where the hop leaves from_code on the track
  end TEXT,       -- and reaches to_code
  highspeed REAL, -- share of its length on high-speed track
  PRIMARY KEY (route_id, seq)
) WITHOUT ROWID;
"""


def hop_rows(
    g: Graph, edges: list[tuple[int, bool]]
) -> tuple[list[int], list[str], str]:
    ways, partial, pts = [], [], []
    for way, i, j, forward in _runs(g, edges):
        run = _coords(g, way, i, j, forward)
        if i == 0 and j == len(g.ways[way].nodes) - 1:
            ways.append(way)
        else:
            partial.append(encode_polyline(run))
        pts.extend(run if not pts or pts[-1] != run[0] else run[1:])
    line = ""
    if len(pts) >= 2:
        simple = LineString([(lon, lat) for lat, lon in pts]).simplify(
            OVERVIEW_TOLERANCE_DEG
        )
        line = encode_polyline([(lat, lon) for lon, lat in simple.coords])
    return ways, partial, line


def track_length(g: Graph, ways: frozenset[int]) -> float:
    return sum(
        sum(
            metres(w.lat[k - 1], w.lon[k - 1], w.lat[k], w.lon[k])
            for k in range(1, len(w.nodes))
        )
        for w in (g.ways[x] for x in ways)
    )


def reorder(jp: Japan, stops: list[str], prefs: Prefs, bound: float) -> list[str]:
    """Stops in track order: the farthest stop from any one is an end; sort
    by distance from it. Stops out of reach are dropped."""
    targets = {v: c for c in stops for v in jp.attach[c]}
    first = distances(jp.g, jp.attach[stops[0]], targets, prefs, bound)
    end = max(first, key=first.get)
    from_end = distances(jp.g, jp.attach[end], targets, prefs, bound)
    return sorted(from_end, key=from_end.get)


def route_hops(jp: Japan, stops: list[str], prefs: Prefs, loop: bool) -> list[tuple]:
    pairs = list(itertools.pairwise(stops)) + ([(stops[-1], stops[0])] if loop else [])
    hops, arriving = [], None
    for a, b in pairs:
        # Carry on from where the previous hop ended, in its direction, so the
        # hops join up; turning back at a stop costs REVERSAL_AT_STOP_M. If
        # that finds nothing, start afresh from any of the stop's attach points
        found = None
        if arriving is not None:
            found = route_leg(
                jp.g,
                [_end(jp.g, arriving, first=False)],
                jp.attach[b],
                prefs,
                arriving,
                REVERSAL_AT_STOP_M,
            )
        if found is None or found[0] == "straight":
            found = route_leg(jp.g, jp.attach[a], jp.attach[b], prefs)
        method, edges, length, _ = found
        if method == "straight" or not edges:
            hops.append((a, b, None if method == "straight" else (length, edges)))
            arriving = None
            continue
        hops.append((a, b, (length, edges)))
        arriving = edges[-1]
    return hops


def store_route(
    db: sqlite3.Connection,
    g: Graph,
    jp: Japan,
    rid: int,
    name: str,
    shinkansen: bool,
    loop: bool,
    stops: list[str],
    hops: list[tuple],
    train: str | None = None,
    line: bool = False,
) -> tuple[int, int]:
    """Insert one route, its stops and hops: (hops stored, hops without a path)."""
    db.execute(
        "INSERT INTO jp_routes VALUES (?, ?, ?, ?, ?, ?, ?)",
        (rid, name, shinkansen, loop, len(stops), train, int(line)),
    )
    db.executemany(
        "INSERT INTO jp_route_stops VALUES (?, ?, ?)",
        ((c, rid, s) for s, c in enumerate(stops)),
    )
    stored = failed = 0
    for seq, (a, b, found) in enumerate(hops):
        if found is None:
            failed += 1
            continue
        length, edges = found
        ways, partial, line = hop_rows(g, edges)
        # A hop between stops sharing an attach point has no track
        start = g.vertex_pos[_end(g, edges[0], first=True)] if edges else jp.position[a]
        end = g.vertex_pos[_end(g, edges[-1], first=False)] if edges else jp.position[b]
        db.execute(
            "INSERT INTO jp_hops VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                rid,
                seq,
                a,
                b,
                round(length),
                json.dumps(ways),
                json.dumps(partial),
                line,
                json.dumps([round(start[1], 6), round(start[0], 6)]),
                json.dumps([round(end[1], 6), round(end[0], 6)]),
                round(
                    sum(
                        g.edges[e].length
                        for e, _ in edges
                        if g.ways[g.edges[e].way].highspeed
                    )
                    / length,
                    3,
                )
                if length
                else 0.0,
            ),
        )
        stored += 1
    return stored, failed


def cut_at_stations(jp: Japan, edges: list[tuple[int, bool]]) -> tuple[list, list]:
    """A path's stations in order (those with an attach point on it) and the
    hops between them."""
    g = jp.g
    verts = [_end(g, edges[0], first=True)] + [_end(g, e, first=False) for e in edges]
    first_at: dict[int, int] = {}
    for i, v in enumerate(verts):
        first_at.setdefault(v, i)
    on = sorted(
        (min(first_at[v] for v in att if v in first_at), c)
        for c, att in jp.attach.items()
        if any(v in first_at for v in att)
    )
    hops = [
        (a, b, (sum(g.edges[e].length for e, _ in edges[i:j]), edges[i:j]))
        for (i, a), (j, b) in itertools.pairwise(on)
    ]
    return [c for _, c in on], hops


def rule_routes(jp: Japan, rules: Path, names: dict[str, str]) -> list[tuple]:
    """Routes for the rules with ends: along the rule's lines (line relations
    and OSM routes named like them), both ways. A rule may list stations in
    between (`via`) and lines for each section (`prefer` split by ";"):
    from 千葉, 富士回遊 runs on 総武快速線 to 錦糸町, on its 緩行線 to 御茶ノ水,
    then on 中央線快速, where the same lines would also allow the 緩行線
    throughout. (name, train pattern, stops, hops) each."""
    out = []
    with open(rules, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if not (r.get("from") and r.get("to")):
                continue
            ends = [r["from"], *filter(None, (r.get("via") or "").split(";")), r["to"]]
            patterns = r["prefer"].split(";")
            if len(patterns) == 1:
                patterns *= len(ends) - 1
            sections = [
                Prefs(
                    highspeed="avoid",
                    ways=frozenset().union(
                        *(
                            w
                            for rid, w in jp.route_ways.items()
                            if re.search(pat, jp.route_name[rid])
                        ),
                        *(
                            w
                            for rid, w in jp.line_ways.items()
                            if re.search(pat, jp.line_name[rid])
                        ),
                    ),
                    off_hint=RULE_OFF_HINT,
                )
                for pat in patterns
            ]
            for stations, prefs in (
                (ends, sections),
                (ends[::-1], sections[::-1]),
            ):
                name = (
                    f"{r['train']} ({names.get(stations[0], stations[0])}"
                    f" => {names.get(stations[-1], stations[-1])})"
                )
                edges, length, arriving = [], 0.0, None
                for (a, b), p in zip(itertools.pairwise(stations), prefs, strict=True):
                    # Carry on from where the last section ended, without
                    # turning back; else start afresh at the station
                    found = (
                        route_leg(
                            jp.g,
                            [_end(jp.g, arriving, first=False)],
                            jp.attach[b],
                            p,
                            arriving,
                        )
                        if arriving
                        else None
                    )
                    if found is None or found[0] == "straight":
                        found = route_leg(jp.g, jp.attach[a], jp.attach[b], p)
                    if found[0] == "straight" or not found[1]:
                        print(f"  {name}: no path {a} → {b}", file=sys.stderr)
                        break
                    edges += found[1]
                    length += found[2]
                    arriving = found[1][-1]
                else:
                    stops, hops = cut_at_stations(jp, edges)
                    print(
                        f"  {name}: {length / 1000:.1f} km, {len(stops)} stations",
                        file=sys.stderr,
                    )
                    out.append((name, r["train"], stops, hops))
    return out


def line_stations(jp: Japan, ways: frozenset[int]) -> list[str]:
    """The stations a line's track passes: those attached to a node of its
    ways (a station is attached to every line within reach, graph.py).
    China's lines, in the same graph, have none."""
    return sorted(
        {c for w in ways for n in jp.g.ways[w].nodes for c in jp.codes_at.get(n, ())}
    )


def line_routes(jp: Japan) -> list[tuple]:
    """Routes along the line relations, stopping at every station on their
    track in track order: (id, name, shinkansen, stops, hops) each."""
    out = []
    for rid, ways in jp.line_ways.items():
        stations = line_stations(jp, ways)
        if len(stations) < 2:
            continue
        share = sum(jp.g.ways[w].highspeed for w in ways) / len(ways)
        shinkansen = share >= 0.3 or "新幹線" in jp.line_name[rid]
        prefs = Prefs(highspeed="prefer" if shinkansen else "avoid", ways=ways)
        # In track order from one end; a branch's stations fall among the
        # main line's, and their hops, too long for the straight distance,
        # are left out at request time
        stops = reorder(jp, stations, prefs, track_length(jp.g, ways) * 2)
        if len(stops) < 2:
            continue
        hops = route_hops(jp, stops, prefs, False)
        out.append((rid, jp.line_name[rid], shinkansen, stops, hops))
    return out


def build(graph: Path, codes: Path, out: Path) -> None:
    g = Graph.load(graph)
    jp = Japan(g, codes)
    out.unlink(missing_ok=True)
    db = sqlite3.connect(out)
    db.executescript(SCHEMA)
    db.executemany(
        "INSERT INTO jp_stations VALUES (?, ?, ?, ?)",
        ((c, *p, json.dumps(jp.elements.get(c, []))) for c, p in jp.position.items()),
    )
    t0, n_hops, failed, reordered = time.time(), 0, 0, []
    for rid, order in jp.route_order.items():
        stops = [
            c for c, _ in sorted(order.items(), key=lambda x: x[1]) if c in jp.attach
        ]
        if len(stops) < 2:
            continue
        raw = [c for c in jp.route_seq[rid] if c in jp.attach]
        loop = len(stops) > 2 and raw[0] == raw[-1]
        shinkansen = jp.route_hs[rid]
        prefs = Prefs(
            highspeed="prefer" if shinkansen else "avoid", ways=jp.route_ways[rid]
        )
        hops = route_hops(jp, stops, prefs, loop)
        track = track_length(g, jp.route_ways[rid])
        total = sum(h[2][0] for h in hops if h[2])
        # Out of order as a whole (hops adding up to more than the route's
        # track), or locally (two stops swapped: a hop far longer than the
        # straight distance between its stops)
        overshoot = any(
            h[2]
            and h[2][0]
            > HOP_DETOUR_RATIO * metres(*jp.position[h[0]], *jp.position[h[1]])
            + HOP_DETOUR_SLACK_M
            for h in hops
        )
        if not loop and track and (total > REORDER_RATIO * track or overshoot):
            # Branching and through-running routes do not sort along one
            # line; keep the new order only when it is shorter
            new_stops = reorder(jp, stops, prefs, track * 2)
            new_hops = route_hops(jp, new_stops, prefs, loop)
            fixed = sum(h[2][0] for h in new_hops if h[2])
            if fixed < total and len(new_stops) >= 0.9 * len(stops):
                stops, hops = new_stops, new_hops
                reordered.append(
                    f"{jp.route_name[rid]}: {total / 1000:.0f} → {fixed / 1000:.0f} km (track {track / 1000:.0f} km)"
                )
        stored, lost = store_route(
            db, g, jp, rid, jp.route_name[rid], shinkansen, loop, stops, hops
        )
        n_hops, failed = n_hops + stored, failed + lost
    # Routes made from rules take ids below OSM's
    names: dict[str, str] = {}
    with open(codes, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            for c in r["codes"].split(";"):
                names.setdefault(c, r["name"])
    for k, (name, train, stops, hops) in enumerate(
        rule_routes(jp, Path(__file__).with_name("jp-rules.csv"), names), 1
    ):
        stored, lost = store_route(
            db, g, jp, -k, name, False, False, stops, hops, train
        )
        n_hops, failed = n_hops + stored, failed + lost
    # Lines, for legs no service route covers; their ids are OSM's, as the
    # service routes' (relations share one id space)
    lines = line_routes(jp)
    for rid, name, shinkansen, stops, hops in lines:
        stored, lost = store_route(
            db, g, jp, rid, name, shinkansen, False, stops, hops, line=True
        )
        n_hops, failed = n_hops + stored, failed + lost
    print(
        f"{len(lines)} lines stored as routes for legs no service covers",
        file=sys.stderr,
    )
    db.commit()
    routes = db.execute("SELECT count(*) FROM jp_routes").fetchone()[0]
    print(
        f"{routes} routes, {n_hops} hops ({failed} without a path) in {time.time() - t0:.0f} s; "
        f"{out.stat().st_size / 1e6:.1f} MB; {len(reordered)} routes put back in order:",
        file=sys.stderr,
    )
    for line in reordered:
        print(f"  {line}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "build":
        sys.exit(__doc__.strip().splitlines()[-1])
    build(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
