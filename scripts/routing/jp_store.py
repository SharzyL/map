"""What a Japanese train path needs from D1, tried on a local SQLite file.

Offline, every OSM service route is cut into hops between its consecutive
stops (Yahoo codes), each routed once along the route. A request then needs
no graph: it looks up the routes stopping at the train's stops, picks one per
leg as jp_poc.py does (type, name, direction, previous leg), and joins the
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

Usage: jp_store.py build <graph.pkl> <jp-station-codes.csv> <out.sqlite>
       jp_store.py check <out.sqlite> <jp-trains.json> <graph.pkl> <jp-station-codes.csv>
"""

from __future__ import annotations

import csv
import itertools
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

from graph import Graph, metres
from jp_assemble import assemble, run_sqlite
from jp_poc import Japan
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
from shapely.geometry import LineString

# Hops adding up to more than this times the route's own track: out of order
REORDER_RATIO = 1.3
HOP_DETOUR_RATIO, HOP_DETOUR_SLACK_M = 2.5, 1000
REVERSAL_AT_STOP_M = 2000
# A rule's route keeps to its lines: off them costs this much more
RULE_OFF_HINT = 20.0

SCHEMA = """
CREATE TABLE jp_stations (code TEXT PRIMARY KEY, lat REAL, lon REAL, elements TEXT) WITHOUT ROWID;
CREATE TABLE jp_routes (
  id INTEGER PRIMARY KEY, name TEXT, shinkansen INTEGER, loop INTEGER, stops INTEGER,
  train TEXT      -- for a route made from jp-rules.csv: the pattern of the trains taking it
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
) -> tuple[int, int]:
    """Insert one route, its stops and hops: (hops stored, hops without a path)."""
    db.execute(
        "INSERT INTO jp_routes VALUES (?, ?, ?, ?, ?, ?)",
        (rid, name, shinkansen, loop, len(stops), train),
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
    db.commit()
    routes = db.execute("SELECT count(*) FROM jp_routes").fetchone()[0]
    print(
        f"{routes} routes, {n_hops} hops ({failed} without a path) in {time.time() - t0:.0f} s; "
        f"{out.stat().st_size / 1e6:.1f} MB; {len(reordered)} routes put back in order:",
        file=sys.stderr,
    )
    for line in reordered:
        print(f"  {line}", file=sys.stderr)


def check(store: Path, trains_json: Path, graph: Path, codes: Path) -> None:
    """Compare the stored-hop paths with jp_poc.py's, train by train."""
    import jp_poc

    db = sqlite3.connect(store)
    g = Graph.load(graph)
    jp = Japan(g, codes)
    rules = jp_poc.load_rules(Path(__file__).with_name("jp-rules.csv"))
    with open(trains_json, encoding="utf-8") as f:
        trains = json.load(f)
    for train in trains:
        t0 = time.perf_counter()
        legs, _, _ = run_sqlite(assemble(train), db)
        ms = (time.perf_counter() - t0) * 1000
        _, mem_legs, _ = jp_poc.route_train(jp, train, rules, True)
        km = sum(x["length_m"] for x in legs) / 1000
        mem_km = sum(x.length for x in mem_legs) / 1000
        straight = sum(x["method"] == "straight" for x in legs)
        size = len(
            json.dumps(
                {
                    "ways": [w for x in legs for w in x["ways"]],
                    "partial": [p for x in legs for p in x["partial"]],
                }
            )
        )
        # Legs whose stored path differs in length from the in-memory one by
        # more than 10%: a different route was picked, or a hop is missing
        differ = sum(
            1
            for x, y in zip(legs, mem_legs, strict=True)
            if (x["method"] == "straight") != (y.method == "straight")
            or abs(x["length_m"] - y.length) > 0.1 * max(y.length, 1)
        )
        print(
            f"{train['label']}: stored {km:.1f} km vs in-memory {mem_km:.1f} km; "
            f"{straight} straight of {len(legs)} legs; {differ} legs differ; "
            f"{ms:.1f} ms; ~{size / 1000:.0f} KB of ids and partial geometry"
        )


if __name__ == "__main__":
    if sys.argv[1] == "build":
        build(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
    else:
        check(
            Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]), Path(sys.argv[5])
        )
