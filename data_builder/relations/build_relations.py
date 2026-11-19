#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["osmium", "numpy", "scipy"]
# ///
"""Build the SQL that loads the railway extract's relations into D1 for the
Worker's /api/v1/relations/{id} (src/worker/api/relations.ts).

Usage:
    python3 build_relations.py <extract.osm.pbf> <line-groups dir> <N02 Station.geojson> <version> <out.sql>

relations_sql.py drops other versions' tables once one is imported.

relations.sh runs it on the railway extract (data_builder/osm-railways) cut to the box
around China and Japan, with line-groups.sh's output for the same extract and
N02's stations. <version> is the extract's osmosis_replication_timestamp,
which the cut drops.

One row per relation (in parts, under D1's statement limit) holds the whole
answer but data_version: OSM routes and lines and their route masters with
track in the extract, and Japan's official lines (jp-<hash>, line-groups.sh).

Stations are railway=station, halt and tram_stop elements;
public_transport=station alone is as often a bus terminal or a pier. A
route's stops are its stop and platform members in order, one per station.
A line's stations are:
- OSM lines: the stations it lists as members (Chinese lines mostly do),
  and those with a station node within 100 m of its track, a stop position
  on it or a platform beside it, that serve its kind of track (no metro
  stations under a main line);
- official lines: N02's stations of that line, matched to OSM stations of
  the same name and kind of track, where the line's track passes within
  1 km (N02 keeps closed sections; a distance rule would also take every
  crossing line's stations).
They are ordered by where they lie beside the line's track between its two
farthest stations, which copes with tracks OSM joins only at their ends, old
and new alignments and gaps (or going round, for a loop), and run from the
line's from= station, else west to east or north to south.

Needs osmium (pyosmium), numpy and scipy; `uv run` installs them.
"""

import csv
import json
import math
import re
import sys
import time
import unicodedata
from collections import defaultdict
from itertools import pairwise
from pathlib import Path

import numpy as np
import osmium
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from relations_sql import table_suffix, write_sql  # noqa: E402

ROUTES = {"train", "subway", "light_rail", "tram", "monorail", "funicular"}
# Railway ways the map draws as track, in any state
TRACK = {
    "rail", "light_rail", "subway", "tram", "monorail", "narrow_gauge", "funicular", "miniature",
    "disused", "abandoned", "razed", "construction", "proposed", "preserved",
}  # fmt: skip
STATIONS = {"station", "halt", "tram_stop"}
URBAN_STATIONS = {"subway", "light_rail", "monorail", "funicular"}
URBAN_TRACK = {"subway", "light_rail", "monorail", "funicular", "tram"}
STOP_ROLES = {"stop", "platform"}

NEAR_LINE_M = 100  # a station node this close to a line's track is on it
PLATFORM_M = 40  # a platform this close to a line's track serves it
# A stop outside any stop area belongs to the nearest station this close
STOP_STATION_M = 300
SAME_STATION_M = 1000  # station elements of one name this close are one station
ON_TRACK_M = 1000  # a line's station is drawn on its track when this close
N02_NAME_M = 500  # an N02 station and the OSM station of its name
N02_NEAREST_M = 100  # ...else the nearest OSM station, whatever its name
MAX_LOOSE_ENDS = (
    3000  # pieces of a line's track joined by all their loose ends, up to this many
)
SIDE_BY_SIDE_M = 30  # tracks this close are joined when ordering stations
SAMPLE_M = 40
OVERVIEW_M = 300
# A way whose samples lie this much beside taken ones is another track
PARALLEL_SHARE = 0.8

N02_ATTRIBUTION = {
    "text": "「国土数値情報（鉄道データ）」（国土交通省）を加工して作成",
    "url": "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html",
}

EARTH_M = 6_371_008.8
M_PER_DEG = EARTH_M * math.pi / 180

# The colour keywords of CSS
CSS_NAME_LIST = """aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
    blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk
    crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki
    darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
    darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue
    dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite
    gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
    lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
    lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
    lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
    magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
    mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream
    mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
    palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
    powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown
    seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen
    steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
    yellowgreen"""
CSS_NAMES = set(CSS_NAME_LIST.split())
HEX_COLOUR = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")


# ---------------- geometry ----------------
def xyz(points) -> np.ndarray:
    """(lon, lat) points -> metres on a sphere, for KD-trees (chords are arcs at these distances)"""
    a = np.radians(np.asarray(points, dtype=float).reshape(-1, 2))
    lon, lat = a[:, 0], a[:, 1]
    return EARTH_M * np.column_stack(
        (np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat))
    )


def metres(a, b) -> float:
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG


def length_m(coords) -> float:
    return sum(metres(a, b) for a, b in pairwise(coords))


def densify(coords, step=SAMPLE_M) -> list:
    """The way's points, with more in between so none are over `step` apart"""
    out = coords[:1]
    for a, b in pairwise(coords):
        n = max(1, math.ceil(metres(a, b) / step))
        out += [
            (a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)
            for i in range(1, n + 1)
        ]
    return out


def simplify(coords, tolerance=OVERVIEW_M) -> list:
    """Douglas-Peucker in metres"""
    if len(coords) <= 2:
        return coords
    k = math.cos(math.radians(coords[0][1])) * M_PER_DEG
    p = np.array([(x * k, y * M_PER_DEG) for x, y in coords])
    keep = np.zeros(len(p), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(p) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        d = p[b] - p[a]
        rel = p[a + 1 : b] - p[a]
        seg = d @ d
        if seg == 0:
            dist = np.hypot(rel[:, 0], rel[:, 1])
        else:
            t = np.clip(rel @ d / seg, 0, 1)
            dist = np.hypot(*(rel - np.outer(t, d)).T)
        i = int(dist.argmax())
        if dist[i] > tolerance:
            keep[a + 1 + i] = True
            stack += [(a, a + 1 + i), (a + 1 + i, b)]
    return [c for c, k in zip(coords, keep) if k]


def encode(coords) -> str:
    """Google encoded polyline, precision 6, latitude first"""
    out = []
    last = (0, 0)
    for lon, lat in coords:
        cur = (round(lat * 1e6), round(lon * 1e6))
        for v in (cur[0] - last[0], cur[1] - last[1]):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        last = cur
    return "".join(out)


def chains(pieces) -> list:
    """Join (node ids, coords) pieces end to end where exactly two meet"""
    ends = defaultdict(list)
    for i, (refs, _) in enumerate(pieces):
        ends[refs[0]].append(i)
        ends[refs[-1]].append(i)
    used = [False] * len(pieces)
    out = []
    # Start at loose ends and junctions, so loops come last
    for i in sorted(range(len(pieces)), key=lambda i: len(ends[pieces[i][0][0]]) == 2):
        if used[i]:
            continue
        used[i] = True
        refs, coords = list(pieces[i][0]), list(pieces[i][1])
        for _ in range(2):
            while len(ends[refs[-1]]) == 2:
                nxt = [j for j in ends[refs[-1]] if not used[j]]
                if not nxt:
                    break
                used[nxt[0]] = True
                r, c = pieces[nxt[0]]
                if r[0] != refs[-1]:
                    r, c = r[::-1], c[::-1]
                refs += r[1:]
                coords += c[1:]
            refs.reverse()
            coords.reverse()
        out.append(coords)
    return out


# ---------------- names ----------------
ITAIJI = str.maketrans(
    {
        "驒": "騨",
        "﨑": "崎",
        "髙": "高",
        "邊": "辺",
        "邉": "辺",
        "濵": "浜",
        "嶋": "島",
        "龍": "竜",
    }
)
KANJI_DIGITS = str.maketrans("0123456789", "〇一二三四五六七八九")


def name_key(name: str) -> str:
    """A station name with spelling differences removed: 飛驒古川 and 飛騨古川,
    皆実町2丁目 and 皆実町二丁目, 押上〈スカイツリー前〉 and 押上, 虹の駅 and 虹,
    嘉兴火车站 and 嘉兴"""
    name = unicodedata.normalize("NFKC", name).replace("ヶ", "ケ").replace("ヵ", "カ")
    name = re.sub(r"[〈<（(].*?[〉>）)]", "", name)
    name = re.sub(r"\s+", "", name).translate(ITAIJI).translate(KANJI_DIGITS)
    return re.sub(r"(の駅|駅|停留場|停留所|火车站|站)$", "", name)


def urban(tags) -> bool:
    """A metro, light rail, monorail or tram station, rather than one of trains"""
    if tags.get("railway") == "tram_stop" or tags.get("station") in URBAN_STATIONS:
        return True
    return tags.get("train") != "yes" and any(
        tags.get(m) == "yes" for m in URBAN_STATIONS | {"tram"}
    )


def css_colour(value):
    """The colour tag if a browser can parse it as a colour"""
    value = (value or "").strip()
    return value if HEX_COLOUR.fullmatch(value) or value.lower() in CSS_NAMES else None


def railway_km(tags):
    """railway:position as kilometres, when it is a plain number"""
    value = (tags or {}).get("railway:position", "").replace(",", ".")
    try:
        return float(value)
    except ValueError:
        return None


def is_platform(tags) -> bool:
    """A railway platform: not a bus stop listed in a station's stop area"""
    return tags.get("railway") == "platform" or (
        tags.get("public_transport") == "platform"
        and any(tags.get(m) == "yes" for m in ROUTES | {"train"})
    )


def ref(elem) -> str:
    return f"{elem[0].upper()}{elem[1]}"


def elem_sort_key(elem):
    return ("nwr".index(elem[0]), elem[1])


# ---------------- extract ----------------
class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.nodes = {}  # tagged node -> ((lon, lat), tags), only the kinds used here
        self.ways = {}  # way -> (tags, node ids, coords) of its located nodes
        self.relations = {}  # relation -> (tags, [(type, id, role)])

    def node(self, n):
        if len(n.tags) == 0:
            return
        tags = {t.k: t.v for t in n.tags}
        if (
            tags.get("railway") in STATIONS | {"stop", "platform"}
            or "public_transport" in tags
        ):
            self.nodes[n.id] = ((n.location.lon, n.location.lat), tags)

    def way(self, w):
        refs, coords = [], []
        for nd in w.nodes:
            if nd.location.valid():
                refs.append(nd.ref)
                coords.append((nd.location.lon, nd.location.lat))
        if coords:
            self.ways[w.id] = ({t.k: t.v for t in w.tags}, refs, coords)

    def relation(self, r):
        self.relations[r.id] = (
            {t.k: t.v for t in r.tags},
            [(m.type, m.ref, m.role) for m in r.members],
        )


class Track:
    """A line's track as points at most 40 m apart, joined where its ways share
    nodes: for distance queries, and to order its stations along"""

    def __init__(self, ways, way_ids):
        index = {}  # OSM node -> point
        coords = []
        edges = {}
        for w in way_ids:
            _, refs, cs = ways[w]
            prev = None
            for node, c in zip(refs, cs):
                i = index.setdefault(node, len(coords))
                if i == len(coords):
                    coords.append(c)
                if prev is not None and prev != i:
                    a = coords[prev]
                    n = max(1, math.ceil(metres(a, c) / SAMPLE_M))
                    last = prev
                    for k in range(1, n + 1):
                        if k < n:
                            coords.append(
                                (
                                    a[0] + (c[0] - a[0]) * k / n,
                                    a[1] + (c[1] - a[1]) * k / n,
                                )
                            )
                        j = len(coords) - 1 if k < n else i
                        edges.setdefault(
                            (min(last, j), max(last, j)),
                            max(metres(coords[last], coords[j]), 0.01),
                        )
                        last = j
                prev = i
        self.coords = coords
        self.edges = edges
        self.tree = cKDTree(xyz(coords)) if coords else None
        self._graph = None

    def distance(self, point) -> float:
        return self.tree.query(xyz(point)[0])[0] if self.tree else math.inf

    def nearest(self, point):
        return self.coords[self.tree.query(xyz(point)[0])[1]]

    def graph(self):
        if self._graph is None:
            n = len(self.coords)
            pairs = list(self.edges)
            rows = [a for a, _ in pairs]
            cols = [b for _, b in pairs]
            data = list(self.edges.values())
            pts = xyz(self.coords)
            # Tracks side by side are one line, though OSM may join them only at its ends
            for a, b in self.tree.query_pairs(SIDE_BY_SIDE_M):
                rows.append(int(a))
                cols.append(int(b))
                data.append(2 * float(np.linalg.norm(pts[a] - pts[b])) + 0.01)
            g = coo_matrix((data, (rows, cols)), shape=(n, n)).tocsr()
            # Bridge gaps in the track between loose ends of different pieces
            count, label = connected_components(g, directed=False)
            if count > 1:
                degree = np.bincount(
                    np.array([a for a, _ in pairs] + [b for _, b in pairs], dtype=int),
                    minlength=n,
                )
                loose = np.flatnonzero(degree <= 1)
                # Every piece joins the others at its nearest loose ends, however far (a
                # line run by another company in between), so the line has a length
                parent = list(range(count))

                def find(c):
                    while parent[c] != c:
                        parent[c] = parent[parent[c]]
                        c = parent[c]
                    return c

                for k in (16, len(loose)):
                    if (
                        len(loose) < 2
                        or len({find(c) for c in label[loose]}) == 1
                        or k > MAX_LOOSE_ENDS
                    ):
                        break
                    d, idx = cKDTree(pts[loose]).query(pts[loose], k=min(k, len(loose)))
                    pairs_by_length = sorted(
                        (float(d[i, j]), i, int(idx[i, j]))
                        for i in range(len(loose))
                        for j in range(1, d.shape[1])
                        if label[loose[i]] != label[loose[idx[i, j]]]
                    )
                    for length, a, b in pairs_by_length:
                        ca, cb = find(label[loose[a]]), find(label[loose[b]])
                        if ca != cb:
                            parent[ca] = cb
                            rows.append(int(loose[a]))
                            cols.append(int(loose[b]))
                            data.append(2 * length)
            # Duplicate pairs would add up; keep the shortest
            best = {}
            for a, b, d in zip(rows, cols, data):
                key = (min(a, b), max(a, b))
                if key[0] != key[1] and d < best.get(key, math.inf):
                    best[key] = d
            keys = list(best)
            self._graph = coo_matrix(
                (list(best.values()), ([a for a, _ in keys], [b for _, b in keys])),
                shape=(n, n),
            ).tocsr()
        return self._graph

    def order(self, points) -> list:
        """Indices of `points` in order along the track: where they lie beside its
        longest stretch between two of them (old and new alignments, branches), or
        going round, for a loop"""
        n = len(points)
        if n <= 2 or not self.coords:
            return list(range(n))
        graph = self.graph()
        at = [int(i) for i in self.tree.query(xyz(points))[1]]
        targets = sorted(set(at))
        dist = {}
        for start in range(0, len(targets), 32):
            chunk = targets[start : start + 32]
            d = dijkstra(graph, directed=False, indices=chunk)[:, targets]
            for row, t in zip(d, chunk):
                dist[t] = dict(zip(targets, row))
        p = xyz(points)
        straight = np.linalg.norm(p[:, None, :] - p[None, :, :], axis=2)
        m = np.array([[dist[at[i]][at[j]] for j in range(n)] for i in range(n)])
        m = np.where(np.isfinite(m), m, 3 * straight)
        end = int(m[0].argmax())
        far = int(m[end].argmax())

        _, pred = dijkstra(
            graph, directed=False, indices=at[end], return_predecessors=True
        )
        path = [at[far]]
        while path[-1] != at[end] and pred[path[-1]] >= 0:
            path.append(int(pred[path[-1]]))
        path.reverse()
        if len(path) >= 2:
            along = np.concatenate(
                (
                    [0],
                    np.cumsum(
                        [
                            metres(self.coords[a], self.coords[b])
                            for a, b in pairwise(path)
                        ]
                    ),
                )
            )
            beside = along[cKDTree(xyz([self.coords[i] for i in path])).query(p)[1]]
            projected = sorted(range(n), key=lambda i: beside[i])
        else:
            projected = sorted(range(n), key=lambda i: m[end, i])
        walk = [end]
        left = set(range(n)) - {end}
        while left:
            walk.append(min(left, key=lambda j: m[walk[-1], j]))
            left.remove(walk[-1])

        def total(order):
            return sum(straight[a, b] for a, b in pairwise(order))

        return projected if total(projected) <= total(walk) * 1.01 else walk


class Builder:
    def __init__(self, extract_path):
        reader = Reader()
        reader.apply_file(str(extract_path), locations=True, idx="flex_mem")
        self.nodes, self.ways, self.relations = (
            reader.nodes,
            reader.ways,
            reader.relations,
        )

        self.stations = {}  # station element -> position
        for nid, (p, tags) in self.nodes.items():
            if tags.get("railway") in STATIONS:
                self.stations[("n", nid)] = p
        for wid, (tags, _, coords) in self.ways.items():
            if tags.get("railway") in STATIONS:
                self.stations[("w", wid)] = self.position(("w", wid))
        self.station_keys = list(self.stations)
        self.station_tree = cKDTree(xyz([self.stations[k] for k in self.station_keys]))

        self.areas_of = defaultdict(list)  # element -> stop areas listing it
        self.area_stations = {}  # stop area -> its station elements
        self.masters_of = defaultdict(list)
        self.routes_of_way = defaultdict(list)
        for rid, (tags, members) in self.relations.items():
            if tags.get("public_transport") == "stop_area":
                self.area_stations[rid] = {
                    (t, r) for t, r, _ in members if (t, r) in self.stations
                }
                for t, r, _ in members:
                    self.areas_of[(t, r)].append(rid)
            elif tags.get("type") == "route_master":
                for t, r, _ in members:
                    if t == "r":
                        self.masters_of[r].append(rid)
            elif tags.get("type") == "route" and tags.get("route") in ROUTES:
                for t, r, role in members:
                    if t == "w" and role not in STOP_ROLES:
                        self.routes_of_way[r].append(rid)

        platforms, points = [], []
        for nid, (p, tags) in self.nodes.items():
            if is_platform(tags):
                platforms.append(("n", nid))
                points.append(p)
        for wid, (tags, _, coords) in self.ways.items():
            if is_platform(tags):
                platforms += [("w", wid)] * len(coords)
                points += coords
        self.platform_of_point = platforms
        self.platform_tree = cKDTree(xyz(points)) if points else None
        self._names = {}

    # ---- elements
    def tags(self, elem):
        t, i = elem
        if t == "n":
            return self.nodes.get(i, (None, {}))[1]
        if t == "w":
            return self.ways.get(i, ({},))[0]
        return self.relations.get(i, ({},))[0]

    def position(self, elem):
        t, i = elem
        if t == "n":
            return self.nodes[i][0] if i in self.nodes else None
        if t == "w" and i in self.ways:
            coords = self.ways[i][2]
            return (
                sum(x for x, _ in coords) / len(coords),
                sum(y for _, y in coords) / len(coords),
            )
        return None

    def name(self, elem):
        return self.tags(elem).get("name")

    def names(self, elem) -> set:
        """Every spelling of the element's names, for matching N02"""
        if elem not in self._names:
            tags = self.tags(elem)
            values = {"name", "name:ja", "alt_name", "old_name", "official_name"}
            self._names[elem] = {
                name_key(v) for k in values for v in tags.get(k, "").split(";") if v
            }
        return self._names[elem]

    def mates(self, elem) -> set:
        """The station elements of elem's station: its stop areas' stations, and itself if a station"""
        out = {elem} if elem in self.stations else set()
        for area in self.areas_of.get(elem, ()):
            out |= self.area_stations[area]
        return out

    def stations_of(self, elem) -> set:
        """The station elements a member (station, stop, platform, stop area) belongs to"""
        if elem[0] == "r" and elem[1] in self.area_stations:
            return set(self.area_stations[elem[1]])
        out = self.mates(elem)
        if out:
            return out
        p = self.position(elem)
        if p is None:
            return set()
        d, i = self.station_tree.query(xyz(p)[0])
        return self.mates(self.station_keys[i]) if d <= STOP_STATION_M else set()

    def groups(self, elems) -> list:
        """Station elements into stations: those sharing a stop area, or a name within 1 km"""
        parent = {e: e for e in elems}

        def find(e):
            while parent[e] != e:
                parent[e] = parent[parent[e]]
                e = parent[e]
            return e

        def union(a, b):
            parent[find(a)] = find(b)

        by_area = defaultdict(list)
        by_name = defaultdict(list)
        for e in sorted(elems, key=elem_sort_key):
            for area in self.areas_of.get(e, ()):
                by_area[area].append(e)
            if self.name(e):
                by_name[name_key(self.name(e))].append(e)
        for es in by_area.values():
            for e in es[1:]:
                union(es[0], e)
        for es in by_name.values():
            for i, a in enumerate(es):
                for b in es[i + 1 :]:
                    if metres(self.stations[a], self.stations[b]) <= SAME_STATION_M:
                        union(a, b)
        out = defaultdict(set)
        for e in sorted(elems, key=elem_sort_key):
            out[find(e)].add(e)
        return list(out.values())

    def main_element(self, elems):
        def rank(e):
            kind = self.tags(e).get("railway")
            return (
                e[0] != "n",
                ["station", "halt", "tram_stop"].index(kind) if kind in STATIONS else 3,
                e[1],
            )

        return min(elems, key=rank)

    def station_name(self, elems):
        ordered = [self.main_element(elems), *sorted(elems, key=elem_sort_key)]
        for key in ("name", "name:zh", "name:ja", "official_name", "name:en"):
            for e in ordered:
                if self.tags(e).get(key):
                    return self.tags(e)[key]
        return None

    # ---- relations
    def member_ways(self, rid, seen=None) -> list:
        """A relation's railway ways in member order, sections of a line included"""
        seen = seen if seen is not None else set()
        seen.add(rid)
        out = []
        for t, i, role in self.relations[rid][1]:
            if (
                t == "w"
                and role not in STOP_ROLES
                and self.ways.get(i, ({},))[0].get("railway") in TRACK
            ):
                out.append(i)
            elif (
                t == "r"
                and i not in seen
                and self.tags(("r", i)).get("route") == "railway"
            ):
                out += self.member_ways(i, seen)
        return list(dict.fromkeys(out))

    def summary(self, rid):
        tags = self.relations[rid][0]
        if tags.get("type") == "route_master":
            kind, kind_type = "master", tags.get("route_master")
        else:
            kind, kind_type = (
                ("line" if tags.get("route") == "railway" else "route"),
                tags.get("route"),
            )
        masters = self.masters_of.get(rid)
        return {
            "id": rid,
            "kind": kind,
            "type": kind_type,
            **{
                k: tags.get(k)
                for k in ("name", "ref", "from", "to", "operator", "network")
            },
            "colour": css_colour(tags.get("colour")),
            "master": min(masters) if masters else None,
            "wikidata": tags.get("wikidata"),
            "wikipedia": tags.get("wikipedia"),
        }

    def shape(self, way_ids) -> dict:
        """bbox, length_m and overview of some ways; the length is along one track
        of several side by side, as the overview draws them"""
        coords = [c for w in way_ids for c in self.ways[w][2]]
        if not coords:
            return {"bbox": None, "length_m": 0, "overview": []}
        xs = [x for x, _ in coords]
        ys = [y for _, y in coords]
        one_track = self.one_track(way_ids)
        return {
            "bbox": [
                round(min(xs), 6),
                round(min(ys), 6),
                round(max(xs), 6),
                round(max(ys), 6),
            ],
            "length_m": round(sum(length_m(self.ways[w][2]) for w in one_track)),
            "overview": [
                encode(simplify(c))
                for c in chains([self.ways[w][1:] for w in one_track])
            ],
        }

    def one_track(self, way_ids) -> list:
        """The ways but those running beside another of them (the other tracks of a
        line), in their order"""
        cell = SAMPLE_M / M_PER_DEG
        # One scale for all, or the same place would fall in different cells
        lats = [c[1] for w in way_ids for c in self.ways[w][2]]
        k = math.cos(math.radians(sum(lats) / len(lats))) if lats else 1
        taken = set()
        kept = set()
        short = []
        for w in sorted(way_ids, key=lambda w: -length_m(self.ways[w][2])):
            coords = self.ways[w][2]
            if len(coords) < 2:
                continue
            points = densify(coords)
            # Away from its ends, which touch the ways it continues
            middle = {
                (math.floor(x * k / cell), math.floor(y / cell))
                for x, y in points
                if min(metres((x, y), coords[0]), metres((x, y), coords[-1]))
                > 2 * SAMPLE_M
            }
            if not middle:
                short.append(w)
                continue
            beside = sum(
                1
                for cx, cy in middle
                if any(
                    (cx + dx, cy + dy) in taken
                    for dx in (-1, 0, 1)
                    for dy in (-1, 0, 1)
                )
            )
            if beside >= PARALLEL_SHARE * len(middle):
                continue
            taken |= {
                (math.floor(x * k / cell), math.floor(y / cell)) for x, y in points
            }
            kept.add(w)
        # Ways too short to tell go with the ways they join
        ends = {self.ways[w][1][i] for w in kept for i in (0, -1)}
        grew = True
        while grew:
            grew = False
            for w in short:
                refs = self.ways[w][1]
                if w not in kept and (refs[0] in ends or refs[-1] in ends):
                    kept.add(w)
                    ends |= {refs[0], refs[-1]}
                    grew = True
        return [w for w in way_ids if w in kept]

    def entry(self, elems, position, km=None) -> dict:
        return {
            "name": self.station_name(elems) if elems else None,
            "position": [round(position[0], 6), round(position[1], 6)],
            "elements": [ref(e) for e in sorted(elems, key=elem_sort_key)],
            "km": km,
        }

    def route_stops(self, rid) -> list:
        """Stop and platform members in order, one entry per station"""
        out = []  # [entry, station elements, from a stop position]
        for t, i, role in self.relations[rid][1]:
            kind = role.split("_")[0]
            if kind not in STOP_ROLES:
                continue
            elem = (t, i)
            p = self.position(elem)
            elems = self.stations_of(elem)
            if p is None and not elems:
                continue  # a member outside the extract
            is_stop = kind == "stop" and t == "n"
            if out:
                last, last_elems, last_is_stop = out[-1]
                last_p = last["position"]
                if (elems and elems & last_elems) or (
                    not elems
                    and not last_elems
                    and p
                    and metres(p, last_p) <= STOP_STATION_M
                ):
                    last_elems |= elems
                    last["elements"] = [
                        ref(e) for e in sorted(last_elems, key=elem_sort_key)
                    ]
                    if is_stop and not last_is_stop:
                        last["position"] = [round(p[0], 6), round(p[1], 6)]
                        last["km"] = railway_km(self.tags(elem))
                        out[-1][2] = True
                    continue
            position = p or self.stations[self.main_element(elems)]
            e = self.entry(
                elems, position, railway_km(self.tags(elem)) if is_stop else None
            )
            if e["name"] is None:
                e["name"] = self.name(elem)
            out.append([e, set(elems), is_stop])
        return [e for e, _, _ in out]

    def line_members(self, rid, seen=None) -> set:
        """The station elements a line lists as members, its sections' included"""
        seen = seen if seen is not None else set()
        seen.add(rid)
        out = set()
        for t, i, _ in self.relations[rid][1]:
            if (
                t == "r"
                and i not in seen
                and self.tags(("r", i)).get("route") == "railway"
            ):
                out |= self.line_members(i, seen)
                continue
            tags = self.tags((t, i))
            if t == "w" and tags.get("railway") in TRACK:
                continue
            if tags.get("railway") in STATIONS | {"stop", "platform"} or tags.get(
                "public_transport"
            ) in (
                "stop_position",
                "platform",
                "station",
                "stop_area",
            ):
                out |= self.stations_of((t, i))
        return out

    def near_track(self, track, way_ids):
        """Stations along a track: station nodes within 100 m, stop positions on it, platforms beside it
        -> {station element: km of its stop position on the track}"""
        found = {}
        if track.tree is None:
            return found
        for hits in self.station_tree.query_ball_point(xyz(track.coords), NEAR_LINE_M):
            for i in hits:
                found.setdefault(self.station_keys[i], None)
        for w in way_ids:
            for node in self.ways[w][1]:
                tags = self.nodes.get(node, (None, {}))[1]
                if (
                    tags.get("public_transport") == "stop_position"
                    or tags.get("railway") == "stop"
                ):
                    for e in self.stations_of(("n", node)):
                        if found.get(e) is None:
                            found[e] = railway_km(tags)
        if self.platform_tree is not None:
            for hits in self.platform_tree.query_ball_point(
                xyz(track.coords), PLATFORM_M
            ):
                for i in hits:
                    for e in self.stations_of(self.platform_of_point[i]):
                        found.setdefault(e, None)
        return found

    def line_stops(self, track, groups, km=None, tags=None) -> list:
        """Entries for station groups, placed on the track and ordered along it"""
        km = km or {}
        entries = []
        # In a fixed order, so equal places along the track keep it from run to run
        for g in sorted(groups, key=lambda g: min(elem_sort_key(e) for e in g)):
            p = self.stations[self.main_element(g)]
            if track.distance(p) <= ON_TRACK_M:
                p = track.nearest(p)
            kms = [km[e] for e in sorted(g, key=elem_sort_key) if km.get(e) is not None]
            entries.append(self.entry(g, p, kms[0] if kms else None))
        entries = [entries[i] for i in track.order([e["position"] for e in entries])]
        if len(entries) < 2:
            return entries
        tags = tags or {}
        names = (entries[0]["name"], entries[-1]["name"])
        if tags.get("from") in names or tags.get("to") in names:
            backwards = tags.get("from") == names[1] or tags.get("to") == names[0]
        else:
            # From west to east, or north to south
            (x1, y1), (x2, y2) = entries[0]["position"], entries[-1]["position"]
            if abs(x2 - x1) * math.cos(math.radians(y1)) >= abs(y2 - y1):
                backwards = x2 < x1
            else:
                backwards = y2 > y1
        return entries[::-1] if backwards else entries

    def relation_body(self, rid):
        tags = self.relations[rid][0]
        if tags.get("type") == "route_master":
            routes = [
                i
                for t, i, _ in self.relations[rid][1]
                if t == "r" and i in self.relations
            ]
            routes = [i for i in routes if self.member_ways(i)]
            if not routes:
                return None
            way_ids = list(
                dict.fromkeys(w for r in routes for w in self.member_ways(r))
            )
            shape = self.shape(way_ids)
            del shape["length_m"]
            return {
                "relation": self.summary(rid),
                "routes": [self.summary(r) for r in routes],
                **shape,
            }
        way_ids = self.member_ways(rid)
        if not way_ids:
            return None
        if tags.get("route") == "railway":
            track = Track(self.ways, way_ids)
            near = self.near_track(track, way_ids)
            listed = self.line_members(rid)
            # The distance rule's stations need a name and to serve this kind of track
            # (no metro stations under a main line); listed ones are kept as they are
            is_urban = self.is_urban(way_ids)
            found = listed | {
                e for e in near if self.name(e) and urban(self.tags(e)) == is_urban
            }
            stops = self.line_stops(track, self.groups(found), near, tags)
        else:
            stops = self.route_stops(rid)
        return {
            "relation": self.summary(rid),
            **self.shape(way_ids),
            "ways": way_ids,
            "stops": stops,
        }

    def relations_rows(self):
        for rid, (tags, _) in sorted(self.relations.items()):
            is_route = tags.get("type") == "route" and tags.get("route") in ROUTES | {
                "railway"
            }
            is_master = (
                tags.get("type") == "route_master"
                and tags.get("route_master") in ROUTES
            )
            if is_route or is_master:
                body = self.relation_body(rid)
                if body:
                    yield str(rid), body

    # ---- Japan's official lines
    def official_lines_rows(self, groups_dir, n02_stations_path):
        groups_dir = Path(groups_dir)
        with open(groups_dir / "line_groups.csv", encoding="utf-8") as f:
            groups = {
                r["group_id"]: r for r in csv.DictReader(f) if r["source"] == "n02"
            }
        ways_of = defaultdict(list)
        rank0 = defaultdict(list)
        with open(groups_dir / "line_group_ways.csv", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r["group_id"] in groups and int(r["way_id"]) in self.ways:
                    ways_of[r["group_id"]].append(int(r["way_id"]))
                    if r["rank"] == "0":
                        rank0[r["group_id"]].append(int(r["way_id"]))
        n02 = defaultdict(list)
        with open(n02_stations_path, encoding="utf-8") as f:
            for feature in json.load(f)["features"]:
                p = feature["properties"]
                coords = feature["geometry"]["coordinates"]
                coords = (
                    coords if feature["geometry"]["type"] == "LineString" else coords[0]
                )
                at = (
                    sum(x for x, _ in coords) / len(coords),
                    sum(y for _, y in coords) / len(coords),
                )
                n02[(p["N02_004"], p["N02_003"])].append((p["N02_005"], at))
        for gid, g in groups.items():
            way_ids = ways_of[gid]
            if not way_ids:
                continue
            track = Track(self.ways, way_ids)
            is_urban = self.is_urban(way_ids)
            found = []
            for name, at in n02[(g["operator"], g["legal_name"])]:
                elems = self.n02_station(name, at, is_urban)
                if (
                    elems
                    and track.distance(self.stations[self.main_element(elems)])
                    <= ON_TRACK_M
                ):
                    found.append(elems)
            # Two N02 stations can be one OSM station (one per line in N02)
            merged = self.groups(set().union(*found)) if found else []
            yield (
                g["line_id"],
                {
                    "relation": {
                        "id": g["line_id"],
                        "kind": "line",
                        "type": "railway",
                        "name": g["name"],
                        "ref": None,
                        "from": None,
                        "to": None,
                        "operator": g["operator"],
                        "network": None,
                        "colour": self.official_colour(rank0[gid]),
                        "master": None,
                        "wikidata": None,
                        "wikipedia": None,
                        "aliases": [a for a in g["aliases"].split("|") if a],
                        "attribution": N02_ATTRIBUTION,
                    },
                    **self.shape(way_ids),
                    "ways": way_ids,
                    "stops": self.line_stops(track, merged),
                },
            )

    def n02_station(self, name, at, is_urban) -> set:
        """The OSM station of an N02 station: those of its name within 500 m, of this
        kind of line if there are, else the nearest within 100 m; with the elements
        of that name in their stop areas (not 大門 in 浜松町's)"""
        want = name_key(name)
        near = [
            self.station_keys[i]
            for i in self.station_tree.query_ball_point(xyz(at)[0], N02_NAME_M)
        ]
        named = [k for k in near if want in self.names(k)]
        named = [k for k in named if urban(self.tags(k)) == is_urban] or named
        if not named:
            d, i = self.station_tree.query(xyz(at)[0])
            if d > N02_NEAREST_M:
                return set()
            named = [self.station_keys[i]]
            want = name_key(self.name(named[0]) or "")
        return {
            e for k in named for e in self.mates(k) if e == k or want in self.names(e)
        }

    def is_urban(self, way_ids) -> bool:
        """Whether most of the track is metro, light rail, monorail or tram"""
        lengths = defaultdict(float)
        for w in way_ids:
            lengths[self.ways[w][0].get("railway") in URBAN_TRACK] += length_m(
                self.ways[w][2]
            )
        return lengths[True] > lengths[False]

    def official_colour(self, way_ids):
        """As the tiles colour an official line: its routes' colours by length-weighted
        majority over the track it follows, each way counting each colour once, if
        that colour's routes run along a quarter of it"""
        weight = defaultdict(float)
        segments = defaultdict(int)
        total = 0.0
        for w in way_ids:
            length = length_m(self.ways[w][2])
            total += length
            colours = {
                (self.relations[r][0].get("colour") or "").strip().lower()
                for r in self.routes_of_way.get(w, ())
            }
            for c in colours - {""}:
                weight[c] += length
                segments[c] += 1
        if not weight:
            return None
        best = min(weight, key=lambda c: (-weight[c], -segments[c], c))
        return css_colour(best) if weight[best] >= total / 4 else None


def main():
    if len(sys.argv) != 6:
        sys.exit(__doc__)
    extract, groups_dir, n02_stations, version, out_path = sys.argv[1:]
    table_suffix(version)
    start = time.time()
    builder = Builder(extract)
    print(
        f"read {len(builder.ways)} ways, {len(builder.relations)} relations in {time.time() - start:.0f} s"
    )

    def rows():
        for count, row in enumerate(builder.relations_rows(), 1):
            if count % 1000 == 0:
                print(f"  {count} relations, {time.time() - start:.0f} s", flush=True)
            yield row
        yield from builder.official_lines_rows(groups_dir, n02_stations)

    with open(out_path, "w", encoding="utf-8") as out:
        stats = write_sql(out, version, rows())
    print(
        f"{out_path}: data {version}, {stats['rows']} relations in {stats['parts']} rows, "
        f"{stats['bytes'] / 1e6:.1f} MB of JSON (largest {stats['largest'][1]}, "
        f"{stats['largest'][0] / 1e3:.0f} KB), {time.time() - start:.0f} s"
    )


if __name__ == "__main__":
    main()
