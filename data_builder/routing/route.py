"""Train paths over the routing graph, answered as the API's train routes
(public/api/v1/doc.md).

A leg runs between two stations' attach points. The search is A* on track
length times a multiplier: sidings and industrial track cost more, high-speed
track is preferred or avoided per train, and a leg with a line hint keeps to
the hinted ways where it can. Paths more than 3x the straight distance are
implausible and come back as straight lines.
"""

from __future__ import annotations

import heapq
import itertools
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from geo import encode_polyline
from graph import MAINLINE, URBAN, Graph, metres
from shapely.geometry import LineString

IMPLAUSIBLE_RATIO = 3.0
IMPLAUSIBLE_SLACK_M = 5_000
OVERVIEW_TOLERANCE_DEG = 300 / 111_000
MAX_EXPANSIONS = 3_000_000
# Sharpest turn a train takes between stops; a reversal is 180
MAX_TURN_DEG = 90
# Cost of each sharper turn when no path avoids one (a gap in OSM's track)
SHARP_TURN_COST_M = 3000
# Cost multipliers, off the hinted ways only: the hinted lines are what the
# train runs on, high-speed or not (广昆线 is tagged highspeed=yes, and every
# train from 昆明 to 广通北 takes it). Avoiding high-speed track is mild: some
# conventional lines in China are tagged highspeed=yes where upgraded
HIGHSPEED_PREFER = 1.5
HIGHSPEED_AVOID = 3.0


@dataclass(frozen=True)
class Prefs:
    highspeed: str | None = None  # prefer / avoid
    urban: str = "allow"  # allow / avoid
    ways: frozenset[int] = frozenset()  # hinted ways (lines, routes)
    off_hint: float = 3.0  # cost multiplier off the hinted ways
    mainline: bool = False  # start and end on mainline track, not metro


@dataclass
class Leg:
    start: int  # stop indexes
    end: int
    method: str  # line / graph / straight
    edges: list[tuple[int, bool]] = field(default_factory=list)  # (edge, forward)
    length: float = 0.0
    line: int | None = None
    straight: list[tuple[float, float]] | None = None  # (lat, lon)
    note: str = ""
    expected_km: float | None = None  # from the timetable, where it has one


def multiplier(g: Graph, way_id: int, prefs: Prefs) -> float:
    w = g.ways[way_id]
    m = 1.0
    if w.service in ("siding", "yard", "spur"):
        m *= 5
    if w.usage in ("industrial", "military", "test"):
        m *= 3
    if prefs.urban == "avoid" and w.kind in URBAN:
        m *= 10
    if way_id in prefs.ways:
        return m
    if prefs.highspeed == "prefer" and not w.highspeed:
        m *= HIGHSPEED_PREFER
    elif prefs.highspeed == "avoid" and w.highspeed:
        m *= HIGHSPEED_AVOID
    if prefs.ways:
        m *= prefs.off_hint
    return m


def _bearing(g: Graph, ei: int, at_u: bool) -> float:
    """Direction (degrees) leaving the edge's u end (or v end) along it."""
    key = (ei, at_u)
    cache = g.__dict__.setdefault("_bearings", {})
    if key not in cache:
        e = g.edges[ei]
        w = g.ways[e.way]
        a, b = (e.i, e.i + 1) if at_u else (e.j, e.j - 1)
        dx = (w.lon[b] - w.lon[a]) * math.cos(math.radians(w.lat[a]))
        cache[key] = math.degrees(math.atan2(w.lat[b] - w.lat[a], dx))
    return cache[key]


def _turn(arrive: float, leave: float) -> float:
    """How far a train turns (degrees) going from one direction to another."""
    return abs((leave - arrive + 180) % 360 - 180)


def search(
    g: Graph,
    sources: list[int],
    targets: list[int],
    prefs: Prefs,
    arriving: tuple[int, bool] | None = None,
    reverse_cost: float = math.inf,
    sharp_cost: float = math.inf,
    expect: float = 0.0,
) -> tuple[float, list[tuple[int, bool]]] | None:
    """Cheapest path from any source vertex to any target vertex.

    Trains do not turn sharper than MAX_TURN_DEG on the way: the search runs
    on (vertex, edge arrived by). A path starts in either direction, unless
    `arriving` (the last step of the previous hop) says how the train came
    in; then turning back costs `reverse_cost` (a reversal at a stop).
    `sharp_cost` allows sharper turns on the way at that cost each, for
    track OSM does not connect through. `expect` is a length known to be
    plausible (from the timetable), however far round it goes.
    """
    target_set = set(targets)
    tpos = [g.vertex_pos[t] for t in targets]

    def h(v: int) -> float:
        lat, lon = g.vertex_pos[v]
        return min(metres(lat, lon, la, lo) for la, lo in tpos)

    straight = min(h(s) for s in sources)
    # Generous bound: a path this costly is implausible however it is weighted
    worst = {"prefer": HIGHSPEED_PREFER, "avoid": HIGHSPEED_AVOID}.get(
        prefs.highspeed or "", 1
    )
    bound = (
        max(straight * IMPLAUSIBLE_RATIO + IMPLAUSIBLE_SLACK_M, expect)
        * worst
        * (prefs.off_hint if prefs.ways else 1)
        * 1.2
    )
    # A state is (vertex, edge arrived by, its direction); None at a free start
    State = tuple[int, int | None, bool]
    starts: list[tuple[float, State]] = []
    for s in sources:
        if arriving is not None and s == _end(g, arriving, first=False):
            starts.append((0.0, (s, arriving[0], arriving[1])))
            if reverse_cost < math.inf:
                starts.append((reverse_cost, (s, None, True)))
        else:
            starts.append((0.0, (s, None, True)))
    dist: dict[State, float] = {st: c for c, st in starts}
    prev: dict[State, tuple[State, int, bool]] = {}
    # Entries that tie on cost go by the order they came in, never by their
    # states, which hold None and edge numbers in the same place.
    order = itertools.count()
    heap = [(c + h(st[0]), c, next(order), st) for c, st in starts]
    heapq.heapify(heap)
    done: set[State] = set()
    while heap and len(done) < MAX_EXPANSIONS:
        f, c, _, state = heapq.heappop(heap)
        if state in done:
            continue
        if f > bound:
            return None
        done.add(state)
        v, in_edge, in_fwd = state
        if v in target_set:
            path = []
            while state in prev:
                state, e, forward = prev[state]
                path.append((e, forward))
            return c, path[::-1]
        if in_edge is not None:
            # Direction of travel into v: the reverse of leaving v back along it
            arrive = (_bearing(g, in_edge, at_u=not in_fwd) + 180) % 360
        for ei in g.adj.get(v, ()):
            e = g.edges[ei]
            forward = e.u == v
            extra = 0.0
            if in_edge is not None and (
                (ei == in_edge and e.u != e.v)
                or _turn(arrive, _bearing(g, ei, at_u=forward)) > MAX_TURN_DEG
            ):
                if sharp_cost == math.inf:
                    continue
                extra = sharp_cost
            u = e.v if forward else e.u
            nxt = (u, ei, forward)
            if nxt in done:
                continue
            nc = c + extra + e.length * multiplier(g, e.way, prefs)
            if nc < dist.get(nxt, math.inf):
                dist[nxt] = nc
                prev[nxt] = (state, ei, forward)
                heapq.heappush(heap, (nc + h(u), nc, next(order), nxt))
    return None


def distances(
    g: Graph, sources: list[int], targets: dict[int, str], prefs: Prefs, bound: float
) -> dict[str, float]:
    """Cost from the sources to each target label (by its vertices), up to bound."""
    dist: dict[int, float] = {s: 0.0 for s in sources}
    found: dict[str, float] = {}
    heap = [(0.0, s) for s in sources]
    done: set[int] = set()
    while heap:
        c, v = heapq.heappop(heap)
        if v in done or c > bound:
            continue
        done.add(v)
        if v in targets and targets[v] not in found:
            found[targets[v]] = c
        for ei in g.adj.get(v, ()):
            e = g.edges[ei]
            u = e.v if e.u == v else e.u
            nc = c + e.length * multiplier(g, e.way, prefs)
            if u not in done and nc < dist.get(u, math.inf):
                dist[u] = nc
                heapq.heappush(heap, (nc, u))
    return found


def leg_length(g: Graph, edges: list[tuple[int, bool]]) -> float:
    return sum(g.edges[e].length for e, _ in edges)


def route_leg(
    g: Graph,
    a: list[int],
    b: list[int],
    prefs: Prefs,
    arriving: tuple[int, bool] | None = None,
    reverse_cost: float = math.inf,
    expect: float = 0.0,
) -> tuple[str, list[tuple[int, bool]], float, str]:
    """method, edges, length, note for one leg between attach-point lists.

    A path more than IMPLAUSIBLE_RATIO times the straight distance is not
    plausible, unless the timetable says the train goes that far (`expect`:
    G5063 loops 51 km from 南昌 round to 南昌西, 12 km away)."""
    if prefs.mainline:
        a = _mainline(g, a) or a
        b = _mainline(g, b) or b
    if set(a) & set(b):
        return "graph", [], 0.0, "same attach point"
    loose = Prefs(prefs.highspeed, prefs.urban, mainline=prefs.mainline)

    def plausible(found) -> tuple[list, float] | None:
        if found is None:
            return None
        edges = found[1]
        length = leg_length(g, edges)
        start = g.vertex_pos[_end(g, edges[0], first=True)]
        end = g.vertex_pos[_end(g, edges[-1], first=False)]
        limit = metres(*start, *end) * IMPLAUSIBLE_RATIO + IMPLAUSIBLE_SLACK_M
        if length > max(limit, expect):
            return None
        return edges, length

    # Strictly first, then without the hint, then with sharp turns at a cost:
    # OSM does not always connect the track through (or joins it at an odd
    # angle), and a path that goes round instead is as wrong as none
    attempts = [
        (prefs, math.inf, ""),
        *([(loose, math.inf, "hint dropped")] if prefs.ways else []),
        (prefs, SHARP_TURN_COST_M, "sharp turn"),
    ]
    for p, sharp, note in attempts:
        found = plausible(search(g, a, b, p, arriving, reverse_cost, sharp, expect))
        if found is not None:
            edges, length = found
            break
    else:
        return "straight", [], 0.0, "no plausible path"
    return ("line" if prefs.ways else "graph"), edges, length, note


def _mainline(g: Graph, vertices: list[int]) -> list[int]:
    return [
        v
        for v in vertices
        if any(g.ways[g.edges[e].way].kind in MAINLINE for e in g.adj.get(v, ()))
    ]


def _end(g: Graph, step: tuple[int, bool], first: bool) -> int:
    e, forward = step
    edge = g.edges[e]
    if first:
        return edge.u if forward else edge.v
    return edge.v if forward else edge.u


# ── Response ────────────────────────────────────────────


def _runs(g: Graph, edges: list[tuple[int, bool]]) -> list[tuple[int, int, int, bool]]:
    """Consecutive edges on one way merged: (way, i, j, forward)."""
    runs: list[list] = []
    for ei, forward in edges:
        e = g.edges[ei]
        if runs and runs[-1][0] == e.way and runs[-1][3] == forward:
            run = runs[-1]
            run[1], run[2] = min(run[1], e.i), max(run[2], e.j)
        else:
            runs.append([e.way, e.i, e.j, forward])
    return [tuple(r) for r in runs]


def _coords(
    g: Graph, way: int, i: int, j: int, forward: bool
) -> list[tuple[float, float]]:
    w = g.ways[way]
    pts = [(w.lat[k], w.lon[k]) for k in range(i, j + 1)]
    return pts if forward else pts[::-1]


def path_response(
    g: Graph,
    stops: list[dict],
    legs: list[Leg],
    data_version: str,
) -> dict:
    """stops: [{position: (lat, lon) | None, elements: [...]}] in train order."""
    ways: list[int] = []
    seen: set[int] = set()
    partial: list[list[tuple[float, float]]] = []
    pieces: list[list[tuple[float, float]]] = []
    out_legs = []
    total = 0.0
    for leg in legs:
        line: list[tuple[float, float]] = []
        if leg.method == "straight":
            line = leg.straight or []
        for way, i, j, forward in _runs(g, leg.edges):
            pts = _coords(g, way, i, j, forward)
            if i == 0 and j == len(g.ways[way].nodes) - 1:
                if way not in seen:
                    seen.add(way)
                    ways.append(way)
            else:
                partial.append(pts)
            line.extend(pts if not line or line[-1] != pts[0] else pts[1:])
        if line:
            if pieces and leg.method != "straight" and pieces[-1][-1] == line[0]:
                pieces[-1].extend(line[1:])
            else:
                pieces.append(line)
        total += leg.length
        entry = {
            "from": leg.start,
            "to": leg.end,
            "length_m": round(leg.length),
            "method": leg.method,
            "line": leg.line,
        }
        if leg.method == "straight" and leg.straight:
            entry["straight"] = encode_polyline(leg.straight)
        if leg.note:
            entry["note"] = leg.note
        out_legs.append(entry)
    all_pts = [p for piece in pieces for p in piece]
    bbox = None
    if all_pts:
        lats, lons = [p[0] for p in all_pts], [p[1] for p in all_pts]
        bbox = [min(lons), min(lats), max(lons), max(lats)]
    overview = []
    for piece in pieces:
        if len(piece) >= 2:
            simple = LineString([(lon, lat) for lat, lon in piece]).simplify(
                OVERVIEW_TOLERANCE_DEG
            )
            overview.append(encode_polyline([(lat, lon) for lon, lat in simple.coords]))
    return {
        "data_version": data_version,
        "bbox": bbox,
        "length_m": round(total),
        "ways": ways,
        "partial": [encode_polyline(p) for p in partial],
        "overview": overview,
        "stops": [
            {
                "position": [s["position"][1], s["position"][0]]
                if s.get("position")
                else None,
                "elements": s.get("elements", []),
            }
            for s in stops
        ],
        "legs": out_legs,
    }


def write_index(out: Path) -> None:
    """The viewer's file list."""
    files = sorted(p.name for p in out.glob("*.geojson"))
    (out / "index.json").write_text(json.dumps(files, ensure_ascii=False))


def path_geojson(g: Graph, stops: list[dict], legs: list[Leg], props: dict) -> dict:
    """The same path as GeoJSON, one feature per leg, for checking by eye."""
    features = []
    for leg in legs:
        if leg.method == "straight":
            coords = [(lon, lat) for lat, lon in (leg.straight or [])]
        else:
            coords = []
            for way, i, j, forward in _runs(g, leg.edges):
                pts = [(lon, lat) for lat, lon in _coords(g, way, i, j, forward)]
                coords.extend(pts if not coords or coords[-1] != pts[0] else pts[1:])
        if len(coords) >= 2:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {
                        "from": stops[leg.start].get("name"),
                        "to": stops[leg.end].get("name"),
                        "method": leg.method,
                        "length_km": round(leg.length / 1000, 1),
                        **({"note": leg.note} if leg.note else {}),
                        **({"expected_km": leg.expected_km} if leg.expected_km else {}),
                    },
                }
            )
    for k, s in enumerate(stops):
        if s.get("position"):
            lat, lon = s["position"]
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {"stop": k, "name": s.get("name")},
                }
            )
    return {"type": "FeatureCollection", "properties": props, "features": features}
