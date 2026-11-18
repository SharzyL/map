"""Japanese train paths from Yahoo stop lists, OSM service routes and rules.

Yahoo gives a train's stops (station codes), its kind and name (新幹線
のぞみ135号, 特急 サンダーバード11号) and the line of the timetable it was
opened from, but no line per leg. Each leg A→B is routed keeping to the OSM
service routes (route=train/subway/...) that stop at both A and B, ranked by:

- type: 新幹線 trains only take 新幹線 routes and the reverse;
- name: the Yahoo line (ＪＲ湘南新宿ライン ~ 湘南新宿ライン (前橋=>小田原))
  or the train's own name (サンダーバード) in the route's name;
- rules (jp-rules.csv): trains with special routes and the relations they
  take, e.g. サンダーバード via 湖西線;
- staying on the previous leg's route.

Without a common route, the leg keeps to routes named like the train or
matched by a rule, then to any passenger route's track. 新幹線 trains prefer
high-speed track; other trains avoid it. The baseline is the shortest path
with only that high-speed rule, for comparison.

Usage: jp_poc.py <graph.pkl> <jp-station-codes.csv> <jp-trains.json> <jp-rules.csv> <out dir>
"""

from __future__ import annotations

import argparse
import collections
import csv
import json
import re
import sys
from pathlib import Path

import numpy as np
from graph import PLATFORM_ROLES, ROUTES, STOP_ROLES, Graph, metres, to_xyz
from jp_assemble import core, is_shinkansen
from route import (
    Leg,
    Prefs,
    divergence_m,
    path_geojson,
    path_response,
    route_leg,
    write_index,
)
from scipy.spatial import cKDTree

ROUTE_STOP_M = 300
# Paths further apart than this differ; parallel tracks are a few metres apart
DIVERGE_M = 300
NEAR_STOPS_M = 50_000


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


def load_rules(path: Path) -> list[tuple[re.Pattern, re.Pattern, str]]:
    with open(path, encoding="utf-8") as f:
        return [
            (
                re.compile(r["train"]),
                re.compile(r["prefer"].replace(";", "|")),
                r["note"],
            )
            for r in csv.DictReader(f)
        ]


def train_hints(
    jp: Japan, train: dict, rules, stops_pos
) -> tuple[frozenset[int], set[int], list[str]]:
    """Ways the train's rules point at, and routes named like the train."""
    text = f"{train['kind']} {train['name']} {train['timetable_line']}"
    rule_ways: set[int] = set()
    notes = []
    for train_re, prefer_re, note in rules:
        if not train_re.search(text):
            continue
        notes.append(note)
        for names, ways in (
            (jp.route_name, jp.route_ways),
            (jp.line_name, jp.line_ways),
        ):
            for rid, name in names.items():
                if prefer_re.search(name) and jp.near(ways[rid], stops_pos):
                    rule_ways |= ways[rid]
    wanted = {core(train["timetable_line"]), core(train["name"])} - {""}
    named = {
        rid
        for rid, name in jp.route_name.items()
        if (c := core(name))
        and any(w in c or c in w for w in wanted)
        and jp.near(jp.route_ways[rid], stops_pos)
    }
    return frozenset(rule_ways), named, notes


def route_train(
    jp: Japan, train: dict, rules, heuristic: bool
) -> tuple[list[dict], list[Leg], list[str]]:
    g = jp.g
    shinkansen = is_shinkansen(f"{train['name']} {train['timetable_line']}")
    hs = "prefer" if shinkansen else "avoid"
    stops = [
        {
            "name": s["name"],
            "code": s["code"],
            "elements": jp.elements.get(s["code"], []),
            "position": jp.position.get(s["code"]),
        }
        for s in train["stops"]
    ]
    stops_pos = [s["position"] for s in stops if s["position"]]
    rule_ways, named, notes = (
        train_hints(jp, train, rules, stops_pos)
        if heuristic
        else (frozenset(), set(), [])
    )

    def type_ok(rid: int) -> bool:
        return jp.route_hs[rid] == shinkansen

    legs, prev_route = [], None
    for k in range(len(stops) - 1):
        a, b = stops[k]["code"], stops[k + 1]["code"]
        leg = Leg(k, k + 1, "graph")
        if a not in jp.attach or b not in jp.attach:
            leg.method, leg.note = "straight", "stop not in OSM"
            leg.straight = [
                p for p in (stops[k]["position"], stops[k + 1]["position"]) if p
            ]
            legs.append(leg)
            continue
        prefs, chosen = Prefs(highspeed=hs), None
        if heuristic:
            common = jp.routes_at.get(a, set()) & jp.routes_at.get(b, set())
            if common:
                # Type first (a local route may still cover a mini-新幹線 leg),
                # then rules, name, direction (one-way routes list one track)
                # and staying on the previous leg's route
                scores = {
                    r: 4 * type_ok(r)
                    + 3 * bool(jp.route_ways[r] & rule_ways)
                    + 2 * (r in named)
                    + (jp.route_order[r].get(a, 0) < jp.route_order[r].get(b, 0))
                    + (r == prev_route)
                    for r in common
                }
                best = max(scores.values())
                top = sorted(r for r in common if scores[r] == best)
                chosen = top[0]
                ways = frozenset().union(*(jp.route_ways[r] for r in top)) | rule_ways
                prefs = Prefs(highspeed=hs, ways=ways)
                leg.note = "route " + " / ".join(jp.route_name[r] for r in top[:3])
            else:
                around = jp.routes_at.get(a, set()) | jp.routes_at.get(b, set())
                ways = rule_ways | frozenset().union(
                    *(jp.route_ways[r] for r in (named & around) or named), frozenset()
                )
                if ways:
                    prefs = Prefs(highspeed=hs, ways=ways)
                    leg.note = "named routes / rules"
                else:
                    prefs = Prefs(highspeed=hs, ways=jp.passenger_ways, off_hint=1.5)
                    leg.note = "passenger track"
        method, edges, length, note = route_leg(g, jp.attach[a], jp.attach[b], prefs)
        leg.method, leg.edges, leg.length = method, edges, length
        if chosen is not None and method == "line":
            leg.line = chosen
            prev_route = chosen
        if method == "line" and chosen is None:
            leg.method = "graph"
        if note:
            leg.note = f"{leg.note}; {note}" if leg.note else note
        if method == "straight":
            leg.straight = [stops[k]["position"], stops[k + 1]["position"]]
        legs.append(leg)
    return stops, legs, notes


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("graph", type=Path)
    ap.add_argument("codes", type=Path)
    ap.add_argument("trains", type=Path)
    ap.add_argument("rules", type=Path)
    ap.add_argument("out", type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    g = Graph.load(args.graph)
    jp = Japan(g, args.codes)
    rules = load_rules(args.rules)
    with open(args.trains, encoding="utf-8") as f:
        trains = json.load(f)

    lines = ["# Japanese train paths: proof of concept", ""]
    for train in trains:
        tag = re.sub(r"[^\w]+", "-", train["label"]).strip("-")
        results = {}
        for method, heuristic in (("heuristic", True), ("baseline", False)):
            stops, legs, notes = route_train(jp, train, rules, heuristic)
            results[method] = legs
            (args.out / f"jp-{tag}-{method}.json").write_text(
                json.dumps(path_response(g, stops, legs, "poc"), ensure_ascii=False)
            )
            gj = path_geojson(
                g, stops, legs, {"train": train["label"], "method": method}
            )
            (args.out / f"jp-{tag}-{method}.geojson").write_text(
                json.dumps(gj, ensure_ascii=False)
            )
        h, b = results["heuristic"], results["baseline"]
        km = lambda legs: sum(l.length for l in legs) / 1000
        differ = [
            f"{train['stops'][x.start]['name']}→{train['stops'][x.end]['name']} "
            f"({d / 1000:.1f} km apart; {x.length / 1000:.1f} vs {y.length / 1000:.1f} km)"
            for x, y in zip(h, b, strict=True)
            if (d := divergence_m(g, x.edges, y.edges)) > DIVERGE_M
        ]
        methods = collections.Counter(l.method for l in h)
        lines += [
            f"## {train['label']} {train['name']} ({train['timetable_line']}, {len(train['stops'])} stops)",
            "",
            f"- heuristic {km(h):.1f} km, baseline {km(b):.1f} km; legs {dict(methods)}",
            f"- legs more than {DIVERGE_M} m from the baseline: {'; '.join(differ) or 'none'}",
        ]
        if notes:
            lines.append(f"- rules: {'; '.join(notes)}")
        for leg in h:
            if (
                leg.method == "straight"
                or "passenger track" in leg.note
                or "hint dropped" in leg.note
            ):
                lines.append(
                    f"  - {train['stops'][leg.start]['name']}→{train['stops'][leg.end]['name']}: {leg.method} ({leg.note})"
                )
        lines.append("")
    (args.out / "jp-report.md").write_text("\n".join(lines), encoding="utf-8")
    write_index(args.out)
    print("\n".join(lines), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
