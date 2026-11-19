"""Match lltskb's China Railway lines to OSM line relations (route=railway).

A line matches the relations whose track passes its stations: within
NEAR_M of a station's position, since high-speed station nodes sit on the
square, away from the viaduct. OSM splits long lines into sections under a
parent relation (沪昆线, 杭昌高速线), so a relation's track includes its child
relations', and one lltskb line may take several relations, picked greedily
by how many more of its stations each covers.

- name: relations whose cleaned name equals the line's, or one contains the
  other (京哈沈哈段 ~ 沈哈), covering at least NAME_COVER of its stations;
- stations: without a name match, relations covering STATIONS_COVER of a
  line with at least 3 placed stations (a two-station link would trivially
  lie on whatever line passes both ends), of the same kind if they can
  (津霸线 runs through 天津 on 津山线 and 京沪线, not 京津城际线 beside them);
- name only: a line with at most 2 placed stations takes a same-named
  relation passing one of them, else the only same-named relation: a link
  between two junctions (黄东联络线) ends where it joins the lines, which may
  be more than NEAR_M from the stations there;
- cr-line-relations.csv overrides all of these.

Usage: cr_lines.py <graph.pkl> <lltskb csv dir> <cr-station-trains.csv> <out.json>
"""

from __future__ import annotations

import collections
import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

import cr_poc
import numpy as np
from graph import Graph, to_xyz
from scipy.spatial import cKDTree

NEAR_M = 1000
NAME_COVER = 0.5
STATIONS_COVER = 0.8
HIGHSPEED = (
    "高速铁路",
    "高速线",
    "高速",
    "高铁",
    "客运专线",
    "客专",
    "城际铁路",
    "城际线",
    "城际",
)
SUFFIXES = HIGHSPEED + ("铁路", "联络线", "联络", "支线", "货线", "线", "段")


def clean(name: str) -> str:
    n = unicodedata.normalize("NFKC", name).strip()
    n = re.sub(r"[(（].*?[)）]", "", n)
    for suffix in SUFFIXES:
        n = n.replace(suffix, "")
    return n


def is_highspeed(name: str) -> bool:
    return any(h in name for h in HIGHSPEED)


def rows(directory: Path, name: str) -> list[dict[str, str]]:
    with open(directory / name, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


class Lines:
    def __init__(self, g: Graph, stations: cr_poc.Stations) -> None:
        self.g, self.st = g, stations
        rels = {
            rid: r for rid, r in g.relations.items() if r.tags.get("route") == "railway"
        }
        self.names = {rid: r.tags.get("name", "") for rid, r in rels.items()}

        def ways_of(rid: int, seen: frozenset[int] = frozenset()) -> set[int]:
            out = set()
            for t, ref, _ in rels[rid].members:
                if t == "w" and ref in g.ways:
                    out.add(ref)
                elif t == "r" and ref in rels and ref not in seen:
                    out |= ways_of(ref, seen | {rid})
            return out

        self.ways = {rid: ways_of(rid) for rid in rels}
        self.ways = {rid: w for rid, w in self.ways.items() if w}
        by_way: dict[int, set[int]] = collections.defaultdict(set)
        for rid, ways in self.ways.items():
            for w in ways:
                by_way[w].add(rid)
        # Every node of the relations' track, labelled with its way
        lat, lon, way = [], [], []
        for w in by_way:
            gw = g.ways[w]
            lat.extend(gw.lat)
            lon.extend(gw.lon)
            way.extend([w] * len(gw.lat))
        self.node_way = np.array(way)
        self.tree = cKDTree(to_xyz(np.array(lat), np.array(lon)))
        self.by_way = by_way
        self.keys: dict[str, set[int]] = collections.defaultdict(set)
        for rid, r in rels.items():
            if rid not in self.ways:
                continue
            for k in (
                "name",
                "name:zh",
                "alt_name",
                "old_name",
                "official_name",
                "ref",
            ):
                for v in r.tags.get(k, "").split(";"):
                    if v and (c := clean(v)):
                        self.keys[c].add(rid)
        self._near: dict[str, set[int]] = {}

    def near(self, station: str) -> set[int]:
        """Relations whose track passes within NEAR_M of the station."""
        if station not in self._near:
            lat, lon = self.st.position[station]
            hits = self.tree.query_ball_point(
                to_xyz(np.array([lat]), np.array([lon]))[0], NEAR_M
            )
            self._near[station] = {
                r for w in set(self.node_way[hits].tolist()) for r in self.by_way[w]
            }
        return self._near[station]

    def by_name(self, line: str) -> set[int]:
        k = clean(line)
        if not k:
            return set()
        found = set(self.keys.get(k, ()))
        if len(k) >= 2:
            for key, rids in self.keys.items():
                if len(key) >= 2 and (key in k or k in key):
                    found |= rids
        return found

    def cover(
        self, stations: list[str], candidates: set[int]
    ) -> tuple[list[int], set[str]]:
        """Greedy set cover of the stations by candidate relations."""
        near = {s: self.near(s) & candidates for s in stations}
        chosen, covered = [], set()
        while True:
            gain = collections.Counter(
                r for s, rs in near.items() if s not in covered for r in rs
            )
            if not gain:
                break
            # Most new stations; then the smaller relation, the more specific
            r, n = max(gain.items(), key=lambda x: (x[1], -len(self.ways[x[0]])))
            if n < 2 and chosen:
                break
            chosen.append(r)
            covered |= {s for s, rs in near.items() if r in rs}
        return chosen, covered

    def match(self, line: str, stations: list[str]) -> dict:
        placed = [s for s in stations if s in self.st.position]
        named = self.by_name(line)
        hs = is_highspeed(line)
        # Same kind first: 京沪高速线 should not take 京沪线
        same_kind = {r for r in named if is_highspeed(self.names[r]) == hs} or named
        result = {
            "relations": [],
            "method": "none",
            "placed": len(placed),
            "covered": 0,
        }
        # Same kind first, then any: lltskb's section names (京哈沈哈段) carry
        # no high-speed word even on high-speed lines
        for pool in (same_kind, named):
            if len(placed) >= 2 and pool:
                chosen, covered = self.cover(placed, pool)
                if (
                    chosen
                    and len(covered) >= 2
                    and len(covered) / len(placed) >= NAME_COVER
                ):
                    return {
                        **result,
                        "relations": chosen,
                        "method": "name",
                        "covered": len(covered),
                    }
        if len(placed) >= 3:
            candidates = set().union(*(self.near(s) for s in placed))
            alike = {r for r in candidates if is_highspeed(self.names[r]) == hs}
            for pool in (alike, candidates):
                chosen, covered = self.cover(placed, pool)
                if chosen and len(covered) / len(placed) >= STATIONS_COVER:
                    return {
                        **result,
                        "relations": chosen,
                        "method": "stations",
                        "covered": len(covered),
                    }
        if len(placed) <= 2 and same_kind:
            near = set().union(*(self.near(s) for s in placed)) if placed else set()
            chosen = sorted(same_kind & near) or (
                sorted(same_kind) if len(same_kind) == 1 else []
            )
            if chosen:
                return {
                    **result,
                    "relations": chosen,
                    "method": "name only",
                    "covered": len(placed),
                }
        return result


def load_overrides(path: Path, lines: Lines) -> dict[str, list[int]]:
    if not path.exists():
        return {}
    out = {}
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            ids = []
            for part in r["relations"].split(";"):
                part = part.strip()
                if part.isdigit():
                    ids.append(int(part))
                elif part:
                    ids.extend(rid for rid, n in lines.names.items() if n == part)
            out[r["line"]] = ids
    return out


def main() -> int:
    graph, timetable, matches, out = (Path(a) for a in sys.argv[1:5])
    g = Graph.load(graph)
    st = cr_poc.Stations(g, matches)
    lines = Lines(g, st)
    overrides = load_overrides(Path(__file__).with_name("cr-line-relations.csv"), lines)

    stations: dict[str, list[str]] = collections.defaultdict(list)
    km: dict[str, dict[str, int]] = collections.defaultdict(dict)
    for r in rows(timetable, "11_线路车站明细.csv"):
        stations[r["线路名"]].append(r["车站"])
        km[r["线路名"]][r["车站"]] = int(r["里程"])
    # Train-km per line: from where a train joins it to where it leaves
    last_stop = {}
    for r in rows(timetable, "07_车次停站时刻表.csv"):
        last_stop[r["车次"]] = r["车站"]
    paths: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)
    for r in rows(timetable, "12_车次路径.csv"):
        paths[r["车次"]].append((r["经由车站"], r["线路名"]))
    train_km: collections.Counter = collections.Counter()
    for t, segs in paths.items():
        for k, (via, line) in enumerate(segs):
            nxt = segs[k + 1][0] if k + 1 < len(segs) else last_stop.get(t)
            if via in km[line] and nxt in km[line]:
                train_km[line] += abs(km[line][nxt] - km[line][via])

    result = {}
    for line, sts in stations.items():
        if line in overrides:
            result[line] = {
                "relations": overrides[line],
                "method": "manual",
                "placed": 0,
                "covered": 0,
            }
        else:
            result[line] = lines.match(line, sts)
        result[line]["names"] = [lines.names[r] for r in result[line]["relations"]]
        result[line]["train_km"] = train_km[line]
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    total = sum(train_km.values())
    by = collections.Counter()
    count = collections.Counter()
    for r in result.values():
        by[r["method"]] += r["train_km"]
        count[r["method"]] += 1
    print("method: lines / share of train-km", file=sys.stderr)
    for m, v in by.most_common():
        print(f"  {m}: {count[m]} / {v / total:.1%}", file=sys.stderr)
    print("unmatched lines carrying the most train-km:", file=sys.stderr)
    for line, r in sorted(result.items(), key=lambda x: -x[1]["train_km"]):
        if r["method"] == "none" and r["train_km"] / total > 0.0005:
            print(
                f"  {line}: {r['train_km'] / total:.2%}, {r['placed']}/{len(stations[line])} stations placed",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
