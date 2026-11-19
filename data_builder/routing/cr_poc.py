"""China Railway train paths from lltskb line chains, checked against its km.

lltskb lists every line's stations in order with track kilometres
(11_线路车站明细.csv), and every train's lines with the station where it joins
each (12_车次路径.csv); every stop lies on one of the train's lines. So a
train's path is the chain of stations along its lines, and each hop between
neighbouring OSM-matched stations on a line is routed once, kept to high-speed
track on high-speed lines and off it elsewhere, and checked against the km
difference lltskb gives.

The baseline routes each leg between consecutive stops directly, with only the
train category's high-speed preference, for comparison.

Usage: cr_poc.py <graph.pkl> <lltskb csv dir> <cr-station-trains.csv> <out dir>
                 [--baseline N] [--trains G1,D1,...]
"""

from __future__ import annotations

import argparse
import collections
import csv
import itertools
import json
import math
import random
import re
import sys
import time
from pathlib import Path

from graph import Graph
from route import Leg, Prefs, path_geojson, path_response, route_leg, write_index

HIGHSPEED_LINE = ("高速", "高铁", "客专", "城际")
HIGHSPEED_TRAIN = {"高速动车", "城际高速"}
CONVENTIONAL_TRAIN = {"普速", "快速", "旅游"}
# The chain wins over a direct path this much closer to the train's km
CHAIN_BONUS = 0.02
SAMPLE_TRAINS = [
    "G1",
    "D1",
    "G79",
    "D2281",
    "Z21",
    "K1",
    "T110",
    "C1001",
    "K1011/K1014",
    "D887",
    "G6501",
]


def rows(directory: Path, name: str) -> list[dict[str, str]]:
    with open(directory / name, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


# China Railway trains stay on mainline track: off metro and tram lines
CR = {"urban": "avoid", "mainline": True}


def line_prefs(line: str) -> Prefs:
    if "联络线" in line:
        return Prefs(**CR)
    if any(k in line for k in HIGHSPEED_LINE):
        return Prefs(highspeed="prefer", **CR)
    return Prefs(highspeed="avoid", **CR)


def train_prefs(category: str) -> Prefs:
    if category in HIGHSPEED_TRAIN:
        return Prefs(highspeed="prefer", **CR)
    if category in CONVENTIONAL_TRAIN:
        return Prefs(highspeed="avoid", **CR)
    return Prefs(**CR)


class Stations:
    def __init__(self, g: Graph, matches: Path) -> None:
        refs: dict[str, list[str]] = collections.defaultdict(list)
        with open(matches, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                refs[r["cr_name"]].append(r["osm_type"] + r["osm_id"])
        self.elements = dict(refs)
        self.attach: dict[str, list[int]] = {}
        self.position: dict[str, tuple[float, float]] = {}
        for name, elems in refs.items():
            att = sorted({v for e in elems for v in g.attach.get(e, [])})
            pts = [g.points[e][:2] for e in elems if e in g.points]
            if att:
                self.attach[name] = att
            if pts:
                self.position[name] = (
                    sum(p[0] for p in pts) / len(pts),
                    sum(p[1] for p in pts) / len(pts),
                )

    def stop(self, name: str) -> dict:
        return {
            "name": name,
            "elements": self.elements.get(name, []),
            "position": self.position.get(name),
        }


class Router:
    def __init__(self, g: Graph, stations: Stations) -> None:
        self.g, self.s = g, stations
        self.cache: dict[tuple[str, str, Prefs], tuple[str, list, float, str]] = {}
        self.searches = 0

    def hop(self, a: str, b: str, prefs: Prefs) -> tuple[str, list, float, str]:
        key = (a, b, prefs)
        if key in self.cache:
            return self.cache[key]
        back = self.cache.get((b, a, prefs))
        if back is not None:
            method, edges, length, note = back
            result = (
                method,
                [(e, not fwd) for e, fwd in reversed(edges)],
                length,
                note,
            )
        else:
            self.searches += 1
            result = route_leg(self.g, self.s.attach[a], self.s.attach[b], prefs)
        self.cache[key] = result
        return result


def chain(
    train_lines: list[tuple[str, str]],
    last_stop: str,
    line_stations: dict[str, list[str]],
) -> list[tuple[str, str]] | None:
    """(station, line it is reached on) along the train's lines, or None when
    a via station is not on its line."""
    out: list[tuple[str, str]] = []
    for k, (via, line) in enumerate(train_lines):
        nxt = train_lines[k + 1][0] if k + 1 < len(train_lines) else last_stop
        stations = line_stations.get(line, [])
        if via not in stations or nxt not in stations:
            return None
        a, b = stations.index(via), stations.index(nxt)
        part = stations[a : b + 1] if a <= b else stations[b : a + 1][::-1]
        for name in part:
            if not out or out[-1][0] != name:
                out.append((name, line))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("graph", type=Path)
    ap.add_argument("timetable", type=Path)
    ap.add_argument("matches", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument(
        "--baseline",
        type=int,
        default=150,
        help="trains to also route the baseline way",
    )
    ap.add_argument(
        "--limit", type=int, default=0, help="only this many trains (0: all)"
    )
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    g = Graph.load(args.graph)
    print(f"graph loaded in {time.time() - t0:.0f} s", file=sys.stderr)
    st = Stations(g, args.matches)
    router = Router(g, st)

    line_rows = collections.defaultdict(list)
    for r in rows(args.timetable, "11_线路车站明细.csv"):
        line_rows[r["线路名"]].append((int(r["顺序"]), r["车站"], int(r["里程"])))
    line_stations = {l: [s for _, s, _ in sorted(v)] for l, v in line_rows.items()}
    line_km = {l: {s: km for _, s, km in v} for l, v in line_rows.items()}

    # Hops: neighbouring matched stations on each line
    hop_stats = []
    t0 = time.time()
    for line, stations in line_stations.items():
        matched = [s for s in stations if s in st.attach]
        for a, b in itertools.pairwise(matched):
            method, _, length, note = router.hop(a, b, line_prefs(line))
            expect = abs(line_km[line][b] - line_km[line][a]) * 1000
            hop_stats.append((line, a, b, method, length, expect, note))
    print(f"{len(hop_stats)} hops routed in {time.time() - t0:.0f} s", file=sys.stderr)

    trains = {r["车次"]: r for r in rows(args.timetable, "06_车次信息.csv")}
    stops: dict[str, list[dict]] = collections.defaultdict(list)
    for r in rows(args.timetable, "07_车次停站时刻表.csv"):
        stops[r["车次"]].append(r)
    paths: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
    for r in rows(args.timetable, "12_车次路径.csv"):
        paths[r["车次"]].append((r["经由车站"], r["线路名"]))

    names = list(trains)
    if args.limit:
        random.seed(1)
        names = sorted(
            set(random.sample(names, args.limit))
            | {t for t in SAMPLE_TRAINS if t in trains}
        )
    random.seed(2)
    baseline_set = set(random.sample(names, min(args.baseline, len(names)))) | {
        t for t in SAMPLE_TRAINS if t in trains
    }

    leg_stats = {"chain": [], "baseline": []}
    train_stats = collections.Counter()
    t0 = time.time()
    for n, name in enumerate(names, 1):
        train = trains[name]
        stop_rows = stops[name]
        stop_names = [r["车站"] for r in stop_rows]
        km = [int(r["累计里程"]) for r in stop_rows]
        seq = (
            chain(paths.get(name, []), stop_names[-1], line_stations)
            if name in paths
            else None
        )
        if seq is None:
            train_stats["no chain"] += 1
        legs_by_method = {}
        if seq is not None:
            legs_by_method["chain"] = chain_legs(
                router, seq, stop_names, km, train_prefs(train["类别"])
            )
        if name in baseline_set or seq is None:
            legs_by_method["baseline"] = baseline_legs(
                router, stop_names, km, train_prefs(train["类别"])
            )
        for method, legs in legs_by_method.items():
            for leg in legs:
                got = None if leg.method == "straight" else leg.length
                leg_stats[method].append(
                    (
                        name,
                        stop_names[leg.start],
                        stop_names[leg.end],
                        got,
                        (leg.expected_km or 0) * 1000,
                        leg.note,
                    )
                )
        if name in SAMPLE_TRAINS:
            for method, legs in legs_by_method.items():
                stop_objs = [st.stop(s) for s in stop_names]
                resp = path_response(g, stop_objs, legs, "poc")
                tag = name.replace("/", "-")
                (args.out / f"cr-{tag}-{method}.json").write_text(
                    json.dumps(resp, ensure_ascii=False)
                )
                gj = path_geojson(g, stop_objs, legs, {"train": name, "method": method})
                (args.out / f"cr-{tag}-{method}.geojson").write_text(
                    json.dumps(gj, ensure_ascii=False)
                )
        if n % 1000 == 0:
            print(
                f"  {n} of {len(names)} trains, {router.searches} searches, {time.time() - t0:.0f} s",
                file=sys.stderr,
            )

    report(args.out / "cr-report.md", hop_stats, leg_stats, train_stats, len(names))
    write_index(args.out)
    return 0


def chain_legs(
    router: Router,
    seq: list[tuple[str, str]],
    stop_names: list[str],
    km: list[int],
    fallback: Prefs,
) -> list[Leg]:
    """Legs between consecutive stops, each the concatenated hops between the
    matched chain stations from one stop to the next. lltskb's line tables
    are not always in track order (杭甬线 lists 钱清 after 绍兴), so a chain
    can be wrong; every leg is also routed directly, and the path closest to the
    train's own km is kept."""
    st = router.s
    positions, k = [], 0
    for i, (name, _) in enumerate(seq):
        if k < len(stop_names) and name == stop_names[k]:
            positions.append(i)
            k += 1
    if k < len(stop_names):  # a stop is not where the chain says; give up on the chain
        return baseline_legs(router, stop_names, km, fallback)
    legs = []
    for s in range(len(stop_names) - 1):
        part = seq[positions[s] : positions[s + 1] + 1]
        leg = Leg(s, s + 1, "line", line=None)
        leg.expected_km = km[s + 1] - km[s]
        matched = [(n, line) for n, line in part if n in st.attach]
        if (
            part[0][0] not in st.attach
            or part[-1][0] not in st.attach
            or len(matched) < 2
        ):
            leg.method, leg.note = "straight", "stop not in OSM"
            leg.straight = [
                p
                for p in (st.position.get(part[0][0]), st.position.get(part[-1][0]))
                if p
            ]
            legs.append(leg)
            continue
        notes = set()
        for (a, _), (b, line) in itertools.pairwise(matched):
            method, edges, length, note = router.hop(a, b, line_prefs(line))
            if method == "straight":
                leg.method, leg.edges, leg.length = "straight", [], 0.0
                leg.straight = [st.position[part[0][0]], st.position[part[-1][0]]]
                notes.add(f"hop {a}-{b} {note}")
                break
            leg.edges.extend(edges)
            leg.length += length
            if note:
                notes.add(note)
        leg.note = "; ".join(sorted(notes))
        want = leg.expected_km * 1000
        if want > 0:
            # Candidates: the chain, and the leg routed directly with the
            # train's and the line's high-speed preference; the closest to the
            # train's own km wins, the chain on near ties
            def err(length: float, want: float = want) -> float:
                return abs(length / want - 1)

            best = (
                err(leg.length) - CHAIN_BONUS if leg.method != "straight" else math.inf
            )
            for prefs in {fallback, line_prefs(part[-1][1])}:
                method, edges, length, note = router.hop(part[0][0], part[-1][0], prefs)
                if method != "straight" and err(length) < best:
                    best = err(length)
                    leg.method, leg.edges, leg.length, leg.straight = (
                        "graph",
                        edges,
                        length,
                        None,
                    )
                    leg.note = "direct" + (f"; {note}" if note else "")
        legs.append(leg)
    return legs


def baseline_legs(
    router: Router, stop_names: list[str], km: list[int], prefs: Prefs
) -> list[Leg]:
    st = router.s
    legs = []
    for s in range(len(stop_names) - 1):
        a, b = stop_names[s], stop_names[s + 1]
        leg = Leg(s, s + 1, "graph")
        leg.expected_km = km[s + 1] - km[s]
        if a not in st.attach or b not in st.attach:
            leg.method, leg.note = "straight", "stop not in OSM"
            leg.straight = [p for p in (st.position.get(a), st.position.get(b)) if p]
        else:
            leg.method, leg.edges, leg.length, leg.note = router.hop(a, b, prefs)
            if leg.method == "straight":
                leg.straight = [st.position[a], st.position[b]]
        legs.append(leg)
    return legs


def buckets(pairs: list[tuple[float | None, float]]) -> dict[str, int]:
    out = collections.Counter()
    for got, want in pairs:
        if got is None:
            out["straight"] += 1
        elif want <= 0:
            out["no km"] += 1
        else:
            r = abs(got / want - 1)
            out[
                "≤5%"
                if r <= 0.05
                else "≤15%"
                if r <= 0.15
                else "≤50%"
                if r <= 0.5
                else ">50%"
            ] += 1
    return dict(out)


def report(path: Path, hops, legs, trains, n_trains) -> None:
    lines = ["# China Railway paths: proof of concept", ""]
    lines.append(
        f"Trains: {n_trains}; without a usable lltskb chain: {trains['no chain']}."
    )
    lines += [
        "",
        "## Hops (neighbouring matched stations on an lltskb line) vs lltskb km",
        "",
    ]
    lines.append(
        f"{len(hops)} hops: {buckets([(h[4] if h[3] != 'straight' else None, h[5]) for h in hops])}"
    )
    worst = sorted(
        (h for h in hops if h[3] != "straight" and h[5] > 0),
        key=lambda h: -abs(h[4] / h[5] - 1),
    )[:25]
    lines += ["", "Worst hops:", ""]
    lines += [
        f"- {l}: {a} → {b}: {got / 1000:.1f} km routed, {want / 1000:.0f} km lltskb {('(' + note + ')') if note else ''}"
        for l, a, b, _, got, want, note in worst
    ]
    for method in ("chain", "baseline"):
        legs_m = legs[method]
        lines += ["", f"## Train legs, {method}", ""]
        lines.append(
            f"{len(legs_m)} legs: {buckets([(got, want) for _, _, _, got, want, _ in legs_m])}"
        )
        reasons = collections.Counter(
            re.sub(r"hop \S+ ", "hop ", note.split(";")[0]) or "?"
            for *_, got, _, note in legs_m
            if got is None
        )
        lines.append(f"Straight because: {dict(reasons.most_common(6))}")
        worst = sorted(
            (x[:5] for x in legs_m if x[3] is not None and x[4] > 0),
            key=lambda x: -abs(x[3] / x[4] - 1),
        )[:15]
        lines += [
            f"- {t}: {a} → {b}: {got / 1000:.1f} km routed, {want / 1000:.0f} km lltskb"
            for t, a, b, got, want in worst
        ]
    chain = {(t, a, b): (got, want) for t, a, b, got, want, _ in legs["chain"]}
    paired = [
        (chain[(t, a, b)], (got, want))
        for t, a, b, got, want, _ in legs["baseline"]
        if (t, a, b) in chain
    ]
    if paired:

        def err(x: tuple[float | None, float]) -> float:
            got, want = x
            return abs(got / want - 1) if got is not None and want > 0 else math.inf

        better = collections.Counter(
            "same"
            if abs(err(c) - err(b)) < 0.01
            else "chain"
            if err(c) < err(b)
            else "baseline"
            for c, b in paired
        )
        best = [min(c, b, key=err) for c, b in paired]
        lines += [
            "",
            "## Chain vs baseline on the same legs",
            "",
            f"{len(paired)} legs; closer to lltskb km: {dict(better)}",
            f"Chain: {buckets([c for c, _ in paired])}",
            f"Baseline: {buckets([b for _, b in paired])}",
            f"Better of the two: {buckets(best)}",
        ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:12]), file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
