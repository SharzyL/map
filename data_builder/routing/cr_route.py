"""China Railway train routes as the API answers them (public/api/v1/doc.md,
/api/v1/cr/trains/{train}/route).

A run's route follows its lltskb path (12_车次路径.csv): legs along named
lines from the station where the train joins each. A leg runs through its
line's stations in between (11_线路车站明细.csv), stops or not, keeping to the
OSM line relations matched to the line (cr_lines.py) and to the line's
kind of track (high-speed or not). Hops between placed stations continue from
where the previous one ended, turning back only at a station and at a cost
(less at a stop).

Each stretch between placed leg ends is checked against lltskb's
kilometres. One off by more than KM_TOLERANCE is also routed through the
train's stops only, directly, and without the line hint; the closest to the
kilometres wins. A leg is `line` when most of it runs on its line's
relations, `graph` when routed otherwise, `straight` when no plausible path
exists.

Usage: cr_route.py <graph.pkl> <lltskb csv dir> <cr-station-trains.csv> <cr-lines.json> <out dir>
                   [--trains G1,D1,...] [--limit N]
"""

from __future__ import annotations

import argparse
import collections
import csv
import gc
import gzip
import itertools
import json
import multiprocessing
import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import cr_lines
import cr_poc
import numpy as np
from graph import Graph, metres
from route import (
    MAX_TURN_DEG,
    OVERVIEW_TOLERANCE_DEG,
    Prefs,
    _bearing,
    _coords,
    _end,
    _runs,
    _turn,
    encode_polyline,
    route_leg,
)
from shapely.geometry import LineString

KM_TOLERANCE = 0.10
ISSUE_RATIO = 1.5  # a hop this much longer than lltskb's km goes in the issues list
IMPLAUSIBLE_KM = 0.5  # off by more than this: straight
STOP_ON_ROUTE_M = 2000
ON_LINE_SHARE = 0.7  # of a leg's length on its line's relations, for `line`
SHARP_RANK = 0.05  # a route with a sharp turn ranks as if this much further off the km
# and one turning back at a station the train does not stop at, as if this
# much: lltskb's line may list a station its trains pass by on a link (滠武线
# lists 滠口 between 武汉 and 丹水池; trains for 汉口 take the link to 丹水池)
TURN_BACK_RANK = 0.1
LINE_OFF_COST = 50.0  # by line: cost multiplier off the lines' track
STOP_MISS_M = 1000  # a route passing a stop farther than this misses it
# and a station of its line it does not stop at, farther than this: missing
# most of a leg's, at least two, the route runs on another line
LINE_STATION_MISS_M = 2000
REVERSAL_AT_STOP_M = 2000
# Trains also reverse where they do not stop for passengers, at a higher
# cost than through running
REVERSAL_AT_STATION_M = 5000
# A hop continuing on the track the last one ended on starts afresh at its
# station instead when that is this much shorter. In metres, not a share: a
# 40 km detour hides in a long hop's km tolerance (上海虹桥 → 祁门南)
FRESH_START_SAVING_M = 5000
# A route running back over track it ran, out and back over at least this,
# goes in cr-retraces.csv
RETRACE_MIN_M = 8000
SAMPLE_TRAINS = [
    "G1",
    "D1",
    "Z21",
    "K1",
    "T110",
    "C1001",
    "K1011/K1014",
    "G6501",
    "D2281",
    "Z156/Z157",
]
CR = {"urban": "avoid", "mainline": True}
JOBS = min(8, os.cpu_count() or 1)
CHUNK_RUNS = 200


def rows(directory: Path, name: str) -> list[dict[str, str]]:
    with open(directory / name, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


@dataclass
class Waypoint:
    name: str
    leg: int  # the leg this station ends (or, for the first, starts)
    stop: int | None = None  # index among the train's stops


@dataclass
class Stretch:
    """Legs between two placed leg ends, routed as one."""

    legs: list[int]
    points: list[Waypoint]
    expected_km: float | None
    steps: list[tuple[int, bool]] = field(default_factory=list)
    length: float = 0.0
    method: str = "straight"
    on_hint: float = 0.0
    note: str = ""


class Builder:
    def __init__(
        self, g: Graph, timetable: Path, matches: Path, lines_json: Path
    ) -> None:
        self.g = g
        self.st = cr_poc.Stations(g, matches)
        self.line_order: dict[str, list[str]] = collections.defaultdict(list)
        self.line_km: dict[str, dict[str, int]] = collections.defaultdict(dict)
        for r in sorted(
            rows(timetable, "11_线路车站明细.csv"),
            key=lambda r: (r["线路名"], int(r["顺序"])),
        ):
            self.line_order[r["线路名"]].append(r["车站"])
            self.line_km[r["线路名"]][r["车站"]] = int(r["里程"])
        with open(lines_json, encoding="utf-8") as f:
            matched = json.load(f)
        relation_ways = cr_lines.Lines(g, self.st).ways
        self.line_ways = {
            line: frozenset().union(
                *(relation_ways.get(r, set()) for r in m["relations"])
            )
            for line, m in matched.items()
            if m["relations"]
        }
        self.cache: dict[tuple, tuple[str, list, float, str]] = {}
        self.searches = 0
        # Hops pointing at gaps in OSM: (line, from, to) -> (km, lltskb km, note)
        self.issues: dict[tuple[str, str, str], tuple[float, int | None, str]] = {}
        self.issue_runs: collections.Counter = collections.Counter()
        # Stops the route passes more than STOP_ON_ROUTE_M away: a station
        # matched to the wrong OSM station, or missing from OSM's track
        self.stop_issues: collections.Counter = collections.Counter()

    def prefs(self, lines: list[str], hint: str = "hint") -> Prefs:
        """hint: "line" keeps to the lines' track (off it costs LINE_OFF_COST),
        "hint" prefers it, "none" ignores it."""
        hs = [
            any(k in line for k in cr_poc.HIGHSPEED_LINE)
            for line in lines
            if "联络" not in line
        ]
        highspeed = (
            "prefer" if hs and all(hs) else "avoid" if hs and not any(hs) else None
        )
        ways = (
            frozenset().union(
                *(self.line_ways.get(line, frozenset()) for line in lines)
            )
            if hint != "none"
            else frozenset()
        )
        off = LINE_OFF_COST if hint == "line" else Prefs.off_hint
        return Prefs(highspeed=highspeed, ways=ways, off_hint=off, **CR)

    def hop(
        self,
        a: str,
        b: str,
        prefs: Prefs,
        arriving,
        reverse_cost: float,
        expect: float = 0.0,
    ):
        key = (a, b, prefs, arriving, reverse_cost, expect)
        if key not in self.cache:
            self.searches += 1
            start = (
                [_end(self.g, arriving, first=False)] if arriving else self.st.attach[a]
            )
            self.cache[key] = route_leg(
                self.g, start, self.st.attach[b], prefs, arriving, reverse_cost, expect
            )
        return self.cache[key]

    def fit(self, points: list[Waypoint], lo: int, hi: int, name: str) -> int:
        """Where among points[lo:hi] a station goes in with the least detour."""
        pos = self.st.position
        if name not in pos:
            return lo

        def near(i: int, step: int) -> tuple[float, float] | None:
            while 0 <= i < len(points):
                if points[i].name in pos:
                    return pos[points[i].name]
                i += step
            return None

        best = None
        for i in range(lo, hi + 1):
            a, b = near(i - 1, -1), near(i, 1)
            cost = (
                (metres(*a, *pos[name]) if a else 0.0)
                + (metres(*pos[name], *b) if b else 0.0)
                - (metres(*a, *b) if a and b else 0.0)
            )
            if best is None or cost < best[0]:
                best = (cost, i)
        return best[1]

    def on_track(self, station: str, ways: frozenset[int]) -> bool:
        """Whether one of the station's attach points lies on these ways."""
        return any(
            self.g.edges[e].way in ways
            for v in self.st.attach.get(station, ())
            for e in self.g.adj.get(v, ())
        )

    def missed(
        self, steps: list[tuple[int, bool]], stops: list[Waypoint], within: float = 0.0
    ) -> list[Waypoint]:
        """Stops the route passes no closer than `within` (STOP_MISS_M)."""
        within = within or STOP_MISS_M
        if not stops or not steps:
            return []
        verts = [_end(self.g, s, first=False) for s in steps]
        pts = np.array([self.g.vertex_pos[v] for v in verts])
        far = []
        for p in stops:
            lat, lon = self.st.position.get(p.name, (None, None))
            if lat is None:
                continue
            dx = (pts[:, 1] - lon) * np.cos(np.radians(lat)) * 111_320
            dy = (pts[:, 0] - lat) * 110_540
            if np.min(dx * dx + dy * dy) > within**2:
                far.append(p)
        return far

    def on_other_line(
        self, steps: list[tuple[int, bool]], along: list[Waypoint]
    ) -> list[Waypoint]:
        """The lines' stations the route misses on legs where it misses most of
        them, at least two: there it runs on another line. One station off
        the route is no sign: 襄渝线 lists 白河县 on the old line, 3.7 km from
        白河东 on the new one."""
        far = self.missed(steps, along, LINE_STATION_MISS_M)
        per_leg = collections.Counter(p.leg for p in along)
        missed = collections.Counter(p.leg for p in far)
        return [
            p for p in far if missed[p.leg] >= 2 and missed[p.leg] > per_leg[p.leg] / 2
        ]

    def turns_back(self, arrived: tuple[int, bool], leaving: tuple[int, bool]) -> bool:
        """Whether the train turns back between two steps, also where the second
        starts afresh on another track at the station."""
        g = self.g
        e, fwd = arrived
        if leaving[0] == e and g.edges[e].u != g.edges[e].v:
            return True
        arrive = (_bearing(g, e, at_u=not fwd) + 180) % 360
        return _turn(arrive, _bearing(g, leaving[0], at_u=leaving[1])) > MAX_TURN_DEG

    def route_points(
        self,
        points: list[Waypoint],
        lines: list[str],
        arriving,
        hint: str = "hint",
        expect: float = 0.0,
    ):
        """Route through placed points in order: steps, length, note, hinted share.

        A hop with no plausible path is tried again allowing `expect`, the
        length the timetable gives the stretch."""
        steps: list[tuple[int, bool]] = []
        length, notes = 0.0, set()
        issues: list[tuple[tuple, tuple]] = []
        prefs = self.prefs(lines, hint)
        for p, q in itertools.pairwise(points):
            reverse = (
                REVERSAL_AT_STOP_M if p.stop is not None else REVERSAL_AT_STATION_M
            )
            # Only a hop over the whole stretch may go as far as its km
            whole = expect if len(points) == 2 else 0.0
            for far in (0.0, whole) if whole else (0.0,):
                method, edges, hop_len, note = self.hop(
                    p.name, q.name, prefs, arriving, reverse, far
                )
                if method == "straight" and arriving is not None:
                    # The track the last hop ended on may not lead on: start afresh
                    method, edges, hop_len, note = self.hop(
                        p.name, q.name, prefs, None, reverse, far
                    )
                    note = "fresh start" + (f"; {note}" if note else "")
                elif arriving is not None:
                    # Or lead the wrong way: the last hop can end on a platform
                    # track that reaches the next line only by turning back (at
                    # 上海虹桥 from 虹封线, 40 km round by 封浜)
                    fresh = self.hop(p.name, q.name, prefs, None, reverse, far)
                    if fresh[0] != "straight" and hop_len > fresh[2] + FRESH_START_SAVING_M:
                        method, edges, hop_len, note = fresh
                        note = "fresh start" + (f"; {note}" if note else "")
                if method != "straight":
                    break
            # Against lltskb's km only along a single line; a span over several
            # (a junction OSM does not have, like 塘厦所) is listed as 莞塘深线+京九线
            line = lines[0] if len(set(lines)) == 1 else None
            km = self.line_km.get(line, {})
            label = "+".join(dict.fromkeys(lines))
            want = (
                abs(km[q.name] - km[p.name]) if p.name in km and q.name in km else None
            )
            if (
                "sharp" in note
                or method == "straight"
                or (want and hop_len > ISSUE_RATIO * want * 1000 + 1000)
            ):
                issues.append(
                    ((label, p.name, q.name), (hop_len / 1000, want, note or method))
                )
            if method == "straight":
                return None, 0.0, note, 0.0, issues
            if p.stop is None and steps and edges and self.turns_back(steps[-1], edges[0]):
                notes.add(f"turns back at {p.name}")
            steps.extend(edges)
            length += hop_len
            if note:
                notes.add(note)
            if edges:
                arriving = edges[-1]
        on = sum(
            self.g.edges[e].length
            for e, _ in steps
            if self.g.edges[e].way in prefs.ways
        )
        return (
            steps,
            length,
            "; ".join(sorted(notes)),
            (on / length if length else 0.0),
            issues,
        )

    def route_run(
        self, run: dict, stops: list[dict], path: list[tuple[str, str]]
    ) -> dict:
        names = [s["车站"] for s in stops]
        # Legs: (from, to, line); without an lltskb path, stop to stop
        if path:
            legs = [
                (via, path[k + 1][0] if k + 1 < len(path) else names[-1], line)
                for k, (via, line) in enumerate(path)
            ]
        else:
            legs = [(a, b, None) for a, b in itertools.pairwise(names)]
        points: list[Waypoint] = []
        for k, (a, b, line) in enumerate(legs):
            order = self.line_order.get(line, [])
            if a in order and b in order:
                i, j = order.index(a), order.index(b)
                part = order[i : j + 1] if i <= j else order[j : i + 1][::-1]
            else:
                part = [a, b]
            for name in part:
                if points and points[-1].name == name:
                    continue
                points.append(Waypoint(name, k))
        # Mark the stops along the points, in order. lltskb's path passes
        # junctions near some stops rather than the stops (Z21: 太原南 for
        # 太原), and its last leg may end off its line (K1229's 通让线 ends at
        # 大庆西, the train goes on to 齐齐哈尔), so a stop the chain misses is
        # put in where it falls: before any later stop, where it adds the
        # least distance between its neighbours
        at = 0
        for k, name in enumerate(names):
            found = next(
                (
                    j
                    for j in range(at, len(points))
                    if points[j].name == name and points[j].stop is None
                ),
                None,
            )
            if found is None:
                later = set(names[k + 1 :])
                end = next(
                    (j for j in range(at, len(points)) if points[j].name in later),
                    len(points),
                )
                found = self.fit(points, at, end, name)
                # A point lies on the leg of the point after it
                leg = points[found].leg if found < len(points) else points[-1].leg
                points.insert(found, Waypoint(name, leg, k))
            points[found].stop = k
            at = found + 1

        # Stretches between placed leg ends
        stretches: list[Stretch] = []
        # Stretches break where the line changes at a stop. Where it changes
        # without a stop, lltskb's station is the junction of its fare path,
        # which the train need not pass: G2711 leaves 京港赣深段 for 莞塘深线
        # before 东莞南, 石德线 trains reach 石太线 by 石家庄直通线, 6.5 km off
        # 石家庄. Such a station is left out
        changes = {
            i
            for i, p in enumerate(points)
            if i + 1 < len(points) and points[i + 1].leg != p.leg
        }
        boundaries = (
            {0} | {i for i in changes if points[i].stop is not None} | {len(points) - 1}
        )
        skip = changes - boundaries
        cut = [i for i in sorted(boundaries) if points[i].name in self.st.attach]
        for a, b in itertools.pairwise(cut):
            span = [
                p
                for i, p in enumerate(points[a : b + 1], a)
                if p.name in self.st.attach and i not in skip
            ]
            leg_ids = sorted({p.leg for p in points[a + 1 : b + 1]})
            want = 0.0
            for k in leg_ids:
                f, t, line = legs[k]
                km = self.line_km.get(line, {})
                if f in km and t in km:
                    want += abs(km[t] - km[f])
                else:
                    want = None
                    break
            if want is None and None not in (points[a].stop, points[b].stop):
                # Where the lines' km do not reach (通让线 ends at 大庆西, K1229
                # goes on to 齐齐哈尔), the train's own km between the stops,
                # where they grow (Y839's are 0 past 格尔木)
                start, end = (float(stops[points[i].stop]["累计里程"]) for i in (a, b))
                want = end - start if end > start else None
            stretches.append(Stretch(leg_ids, span, want))
        if not stretches:
            return self.response(run, names, legs, [], points)

        arriving = None
        for sx in stretches:
            lines = [legs[k][2] for k in sx.legs if legs[k][2]]
            if any("轮渡" in line for line in lines):
                # A train ferry (粤海轮渡): no track to draw, a straight line is right
                sx.method, sx.note, arriving = "straight", "ferry", None
                continue
            first_issues = None
            stops_only = (
                [sx.points[0]]
                + [p for p in sx.points[1:-1] if p.stop is not None]
                + [sx.points[-1]]
            )
            # By line first: one search along the lines' track from end to end,
            # through only the stops the lines do not pass (Z21's 太原 for
            # 太原南). Stations in between are no boundaries, so a hop cannot
            # end on a track that does not lead on. Then the older ways: hop
            # by hop through the line's stations, the stops, directly, and
            # without the lines. Those starting afresh begin from any of the
            # first station's attach points: where lines meet (广通北), the
            # track the previous stretch ended on may only connect beyond it
            line_ways = self.prefs(lines).ways
            inner = [p for p in sx.points[1:-1] if p.stop is not None]
            off_line = [p for p in inner if not self.on_track(p.name, line_ways)]
            # The lines' stations the train passes without stopping, where OSM
            # has them on the lines' track: the route should pass them too. Of
            # two ways along the lines, they tell which one lltskb means (广昆线
            # by 双湄村 and 禄丰南, not 成昆线's old line, from 昆明 to 广通北)
            along = [
                p
                for p in sx.points[1:-1]
                if p.stop is None and self.on_track(p.name, line_ways)
            ]
            ends = [sx.points[0], sx.points[-1]]
            line_points = [
                ends[0],
                *[p for p in sx.points[1:-1] if p.stop is not None or p in along],
                ends[1],
            ]
            by_line = [ends[0], *off_line, ends[1]]
            options = [
                ("by line", by_line, "line", arriving),
                ("by line, fresh start", by_line, "line", None),
                ("by line through stops", [ends[0], *inner, ends[1]], "line", arriving),
                ("line", line_points, "hint", arriving),
                ("stops", stops_only, "hint", arriving),
                ("direct", ends, "hint", arriving),
                ("line, fresh start", line_points, "hint", None),
                ("no hint", line_points, "none", None),
            ]
            expect = (
                sx.expected_km * 1000 * (1 + IMPLAUSIBLE_KM) if sx.expected_km else 0.0
            )
            best = None
            n = 0
            while n < len(options):
                label, pts, hint, entry = options[n]
                n += 1
                steps, length, note, on, issues = self.route_points(
                    pts, lines, entry, hint, expect
                )
                if first_issues is None:
                    first_issues = issues
                if steps is None:
                    continue
                err = (
                    abs(length / (sx.expected_km * 1000) - 1) if sx.expected_km else 0.0
                )
                # A route passing a stop at more than STOP_MISS_M, or running
                # on another line than a leg's, ranks below any that does not;
                # a sharp turn (track OSM does not connect through), or turning
                # back where the train does not stop, below a route without one
                other = self.on_other_line(steps, along)
                missed = len(self.missed(steps, inner)) + len(other)
                if label == "by line" and other:
                    # Next, the same through the stations it missed
                    through = [
                        p for p in sx.points[1:-1] if p in off_line or p in other
                    ]
                    options.insert(
                        n,
                        (
                            "by line through its stations",
                            [ends[0], *through, ends[1]],
                            "line",
                            arriving,
                        ),
                    )
                rank = (
                    err
                    + (1.0 if missed else 0.0)
                    + (SHARP_RANK if "sharp" in note else 0.0)
                    + (TURN_BACK_RANK if "turns back" in note else 0.0)
                )
                if best is None or rank < best[0] - 0.01:
                    best = (rank, label, steps, length, note, on, err, issues)
                # Good enough to stop: close to the km, past every stop, and
                # without a sharp turn or turning back (else a later way may
                # avoid it)
                if (
                    err <= KM_TOLERANCE
                    and not missed
                    and "sharp" not in note
                    and "turns back" not in note
                    and best[1] == label
                ):
                    break
            # Only the chosen way's hops count as issues
            for key, value in best[7] if best else first_issues or []:
                self.issues[key] = value
                self.issue_runs[key] += 1
            if best is None:
                sx.method, sx.note = "straight", "no path"
                arriving = None
                continue
            _, label, sx.steps, sx.length, note, sx.on_hint, err, _ = best
            if sx.expected_km and sx.length > sx.expected_km * 1000 * (
                1 + IMPLAUSIBLE_KM
            ):
                # Far longer than lltskb's distance is a detour round a gap in
                # OSM, not the train's route: draw it straight. Far shorter is
                # kept: lltskb's km are fare km, which may go round (6259's
                # path runs out to 富拉尔基 and back to 昂昂溪)
                sx.method, sx.note = (
                    "straight",
                    f"{label}: {err:+.0%} against lltskb's km",
                )
                sx.steps, arriving = [], None
                continue
            has_hint = any(self.line_ways.get(legs[k][2]) for k in sx.legs)
            sx.method = "line" if has_hint and sx.on_hint >= ON_LINE_SHARE else "graph"
            sx.note = label + (f"; {note}" if note else "")
            arriving = sx.steps[-1] if sx.steps else arriving
        return self.response(run, names, legs, stretches, points)

    def response(self, run, names, legs, stretches, points) -> dict:
        g = self.g
        method = {}
        for sx in stretches:
            for k in sx.legs:
                method[k] = sx
        ways, seen, partial, pieces = [], set(), [], []
        for sx in stretches:
            if sx.method == "straight":
                continue
            line: list[tuple[float, float]] = []
            for way, i, j, forward in _runs(g, sx.steps):
                pts = _coords(g, way, i, j, forward)
                if i == 0 and j == len(g.ways[way].nodes) - 1:
                    if way not in seen:
                        seen.add(way)
                        ways.append(way)
                else:
                    partial.append(encode_polyline(pts))
                line.extend(pts if not line or line[-1] != pts[0] else pts[1:])
            if line:
                if pieces and pieces[-1][-1] == line[0]:
                    pieces[-1].extend(line[1:])
                else:
                    pieces.append(line)
        overview, all_pts = [], [p for piece in pieces for p in piece]
        for piece in pieces:
            if len(piece) >= 2:
                simple = LineString([(lon, lat) for lat, lon in piece]).simplify(
                    OVERVIEW_TOLERANCE_DEG
                )
                overview.append(
                    encode_polyline([(lat, lon) for lon, lat in simple.coords])
                )
        bbox = None
        if all_pts:
            bbox = [
                min(p[1] for p in all_pts),
                min(p[0] for p in all_pts),
                max(p[1] for p in all_pts),
                max(p[0] for p in all_pts),
            ]
        out_legs = []
        for k, (a, b, line) in enumerate(legs):
            sx = method.get(k)
            leg = {
                "from": a,
                "to": b,
                "line": line,
                "method": sx.method if sx else "straight",
            }
            if leg["method"] == "straight":
                ends = [self.st.position.get(a), self.st.position.get(b)]
                if all(ends):
                    leg["straight"] = encode_polyline(ends)
            out_legs.append(leg)
        # Where the route passes each stop: the first of the stop's attach
        # points along it, else the nearest route vertex within STOP_ON_ROUTE_M
        path = [
            v
            for sx in stretches
            for e, fwd in sx.steps
            for v in (_end(g, (e, fwd), True), _end(g, (e, fwd), False))
        ]
        at, stops = 0, []
        for n in names:
            att = set(self.st.attach.get(n, ()))
            hit = next((i for i in range(at, len(path)) if path[i] in att), None)
            if hit is None and n in self.st.position and path:
                d, i = min(
                    (metres(*self.st.position[n], *g.vertex_pos[v]), i)
                    for i, v in enumerate(path)
                )
                hit = i if d <= STOP_ON_ROUTE_M else None
            if hit is not None:
                lat, lon = g.vertex_pos[path[hit]]
                at = hit
            elif n in self.st.position:
                lat, lon = self.st.position[n]
                if path:
                    self.stop_issues[n] += 1  # the route passes the station far away
            else:
                lat = lon = None
            stops.append(
                {
                    "name": n,
                    "position": [round(lon, 6), round(lat, 6)]
                    if lat is not None
                    else None,
                    "elements": self.st.elements.get(n, []),
                }
            )
        return {
            "data_version": "poc",
            "bbox": bbox,
            "ways": ways,
            "partial": partial,
            "overview": overview,
            "stops": stops,
            "legs": out_legs,
            "_stretches": [
                (sx.legs, sx.method, sx.length, sx.expected_km, sx.note)
                for sx in stretches
            ],
            "_retrace": retrace([g.vertex_pos[v] for v in path], stops),
        }


def retrace(points: list[tuple[float, float]], stops: list[dict]) -> tuple | None:
    """-> (km, (lat, lon), stop or "") where a route first runs back over track
    it ran: comes within 300 m of a point RETRACE_MIN_M or more earlier, and 2 km
    on from there meets 2 km back, so a loop (海南环线) is not one. The stop is
    the train's, if it turns there (the reversal may be real); else ""."""
    cell = 0.003  # degrees, about 300 m
    cum = [0.0]
    for a, b in itertools.pairwise(points):
        cum.append(cum[-1] + metres(*a, *b))
    grid: dict[tuple[int, int], list[int]] = collections.defaultdict(list)
    for i, p in enumerate(points):
        key = (round(p[0] / cell), round(p[1] / cell))
        for j in grid[key]:
            if cum[i] - cum[j] < RETRACE_MIN_M or metres(*p, *points[j]) > 300:
                continue
            a = next(x for x in range(j, i + 1) if cum[x] - cum[j] >= 2000)
            b = next(x for x in range(i, j - 1, -1) if cum[i] - cum[x] >= 2000)
            if metres(*points[a], *points[b]) > 500:
                continue
            k = max(range(j, i + 1), key=lambda x: metres(*points[j], *points[x]))
            turn = points[k]
            at = next(
                (
                    s["name"]
                    for s in stops
                    if s["position"]
                    and metres(*turn, s["position"][1], s["position"][0]) < STOP_MISS_M
                ),
                "",
            )
            return round((cum[i] - cum[j]) / 1000, 1), turn, at
        grid[key].append(i)
    return None


@dataclass
class Tally:
    """What routing a set of runs adds up to."""

    runs: int = 0
    # run, legs, method, routed km, lltskb km, note
    stretches: list[tuple] = field(default_factory=list)
    legs_by_method: collections.Counter = field(default_factory=collections.Counter)
    km_by_method: collections.Counter = field(default_factory=collections.Counter)
    notes: collections.Counter = field(default_factory=collections.Counter)
    issues: dict = field(default_factory=dict)
    issue_runs: collections.Counter = field(default_factory=collections.Counter)
    stop_issues: collections.Counter = field(default_factory=collections.Counter)
    # run, retrace(): routes running back over their own track
    retraces: list[tuple] = field(default_factory=list)
    searches: int = 0
    samples: dict[str, dict] = field(default_factory=dict)
    # run, its route as JSON; only with --routes
    routes: list[tuple[str, str]] = field(default_factory=list)

    def add(self, other: Tally) -> None:
        self.runs += other.runs
        self.stretches += other.stretches
        self.legs_by_method += other.legs_by_method
        self.km_by_method += other.km_by_method
        self.notes += other.notes
        self.issues.update(other.issues)
        self.issue_runs += other.issue_runs
        self.stop_issues += other.stop_issues
        self.retraces += other.retraces
        self.searches += other.searches
        self.samples.update(other.samples)
        self.routes += other.routes


# What the workers route with, set before they fork from the process that
# loaded it: the graph is shared copy-on-write rather than loaded again
_job: dict = {}


def route_chunk(names: list[str]) -> Tally:
    b, runs, stops, paths = (_job[k] for k in ("builder", "runs", "stops", "paths"))
    b.issues, b.issue_runs, b.stop_issues = (
        {},
        collections.Counter(),
        collections.Counter(),
    )
    b.searches = 0
    t = Tally(runs=len(names))
    for name in names:
        resp = b.route_run(runs[name], stops[name], paths.get(name, []))
        for legs, method, length, want, note in resp.pop("_stretches"):
            t.stretches.append(
                (
                    name,
                    "-".join(map(str, legs)),
                    method,
                    round(length / 1000, 1),
                    want,
                    note,
                )
            )
            t.notes[note.split(";")[0] or "-"] += 1
        back = resp.pop("_retrace")
        if back:
            t.retraces.append((name, *back))
        for leg in resp["legs"]:
            t.legs_by_method[leg["method"]] += 1
            km = b.line_km.get(leg["line"], {})
            if leg["from"] in km and leg["to"] in km:
                t.km_by_method[leg["method"]] += abs(km[leg["to"]] - km[leg["from"]])
        if name in SAMPLE_TRAINS:
            t.samples[name] = resp
        if _job["keep_routes"]:
            t.routes.append(
                (name, json.dumps(resp, ensure_ascii=False, separators=(",", ":")))
            )
    t.issues, t.issue_runs, t.stop_issues = b.issues, b.issue_runs, b.stop_issues
    t.searches = b.searches
    return t


def route_all(
    b, runs, stops, paths, names: list[str], jobs: int, keep_routes: bool = False
) -> Tally:
    """Route the runs, in `jobs` processes. Runs on the same lines go to the
    same worker, in chunks, so its searches serve them all."""
    _job.update(builder=b, runs=runs, stops=stops, paths=paths, keep_routes=keep_routes)
    order = sorted(names, key=lambda n: ([line for _, line in paths.get(n, [])], n))
    size = max(1, min(CHUNK_RUNS, len(order) // max(1, jobs * 4)))
    chunks = [order[i : i + size] for i in range(0, len(order), size)]
    total, t0 = Tally(), time.time()
    if jobs <= 1:
        results = map(route_chunk, chunks)
    else:
        # Objects made so far are left alone by the garbage collector, which
        # would otherwise write to them and unshare the graph's pages
        gc.freeze()
        pool = multiprocessing.get_context("fork").Pool(jobs)
        results = pool.imap_unordered(route_chunk, chunks)
    for t in results:
        before = total.runs
        total.add(t)
        if total.runs // 2000 > before // 2000:
            print(
                f"  {total.runs} of {len(names)} runs, {total.searches} searches,"
                f" {time.time() - t0:.0f} s",
                file=sys.stderr,
            )
    if jobs > 1:
        pool.close()
        pool.join()
    return total


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("graph", type=Path)
    ap.add_argument("timetable", type=Path)
    ap.add_argument("matches", type=Path)
    ap.add_argument("lines", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument(
        "--routes",
        type=Path,
        help="write every run's route here, as gzipped JSON lines, for export_d1.py",
    )
    ap.add_argument(
        "--jobs",
        type=int,
        default=JOBS,
        help=f"worker processes (default {JOBS}); each grows to a few GB",
    )
    args = ap.parse_args()
    t0 = time.time()
    g = Graph.load(args.graph)
    b = Builder(g, args.timetable, args.matches, args.lines)
    runs = {r["车次"]: r for r in rows(args.timetable, "06_车次信息.csv")}
    stops = collections.defaultdict(list)
    for r in rows(args.timetable, "07_车次停站时刻表.csv"):
        stops[r["车次"]].append(r)
    paths = collections.defaultdict(list)
    for r in rows(args.timetable, "12_车次路径.csv"):
        paths[r["车次"]].append((r["经由车站"], r["线路名"]))
    names = list(runs)
    if args.limit:
        random.seed(1)
        names = sorted(
            set(random.sample(names, args.limit))
            | {t for t in SAMPLE_TRAINS if t in runs}
        )
    print(
        f"ready in {time.time() - t0:.0f} s; routing {len(names)} runs", file=sys.stderr
    )

    t0 = time.time()
    total = route_all(b, runs, stops, paths, names, args.jobs, bool(args.routes))
    if args.routes:
        with gzip.open(args.routes, "wt", encoding="utf-8") as f:
            for name, route in sorted(total.routes):
                f.write(
                    f'{{"run":{json.dumps(name, ensure_ascii=False)},"route":{route}}}\n'
                )
    # Every station's OSM elements and position, for the train endpoint's stops
    with open(
        args.out / "cr-station-positions.csv", "w", newline="", encoding="utf-8"
    ) as f:
        w = csv.writer(f)
        w.writerow(["station", "elements", "lat", "lon"])
        for name in sorted(b.st.position):
            lat, lon = b.st.position[name]
            w.writerow(
                [
                    name,
                    ";".join(b.st.elements.get(name, [])),
                    round(lat, 6),
                    round(lon, 6),
                ]
            )
    for name, resp in total.samples.items():
        tag = name.replace("/", "-")
        (args.out / f"cr-{tag}-route.json").write_text(
            json.dumps(resp, ensure_ascii=False)
        )
    with open(args.out / "cr-stretches.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["run", "legs", "method", "routed_km", "lltskb_km", "note"])
        w.writerows(sorted(total.stretches))
    legs_by_method, km_by_method = total.legs_by_method, total.km_by_method
    notes = total.notes
    stretch_err = [
        (
            None if method == "straight" else km / want - 1,
            want,
            name,
            legs,
        )
        for name, legs, method, km, want, _ in total.stretches
        if want
    ]

    with open(args.out / "cr-osm-issues.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["line", "from", "to", "routed_km", "lltskb_km", "note", "runs"])
        for key, n in total.issue_runs.most_common():
            km, want, note = total.issues[key]
            w.writerow([*key, round(km, 1), want, note, n])
    print(f"{len(total.issues)} hops listed in cr-osm-issues.csv", file=sys.stderr)
    with open(args.out / "cr-stop-issues.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["station", "elements", "runs"])
        for name, n in total.stop_issues.most_common():
            w.writerow([name, ";".join(b.st.elements.get(name, [])), n])
    print(
        f"{len(total.stop_issues)} stations listed in cr-stop-issues.csv",
        file=sys.stderr,
    )
    with open(args.out / "cr-retraces.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["run", "km_out_and_back", "lat", "lon", "turns_at_stop"])
        for name, km, (lat, lon), stop in sorted(total.retraces, key=lambda r: -r[1]):
            w.writerow([name, km, round(lat, 5), round(lon, 5), stop])
    print(
        f"{len(total.retraces)} runs retracing their track listed in cr-retraces.csv"
        f" ({sum(1 for r in total.retraces if not r[3])} turn away from their stops)",
        file=sys.stderr,
    )
    total_km = sum(km_by_method.values())
    print(
        f"\n{len(names)} runs in {time.time() - t0:.0f} s, {total.searches} searches",
        file=sys.stderr,
    )
    print(f"legs by method: {dict(legs_by_method)}", file=sys.stderr)
    print(
        f"leg km by method: { {k: f'{v / total_km:.1%}' for k, v in km_by_method.items()} }",
        file=sys.stderr,
    )
    buckets = collections.Counter()
    for err, want, *_ in stretch_err:
        buckets[
            "straight"
            if err is None
            else "≤2%"
            if abs(err) <= 0.02
            else "≤5%"
            if abs(err) <= 0.05
            else "≤10%"
            if abs(err) <= 0.1
            else "≤25%"
            if abs(err) <= 0.25
            else ">25%"
        ] += want
    tot = sum(buckets.values())
    print(
        f"stretch km vs lltskb, weighted by km: { {k: f'{v / tot:.1%}' for k, v in sorted(buckets.items())} }",
        file=sys.stderr,
    )
    print(f"stretch routed as: {dict(notes.most_common(8))}", file=sys.stderr)
    worst = sorted(
        (x for x in stretch_err if x[0] is not None), key=lambda x: -abs(x[0]) * x[1]
    )[:15]
    for err, want, name, legs in worst:
        print(f"  {name} legs {legs}: {err:+.0%} of {want} km", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
