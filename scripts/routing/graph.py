"""Routing graph for the proof of concept: railway tracks from an OSM extract.

Loads track ways, station and stop elements, stop areas and route/line
relations from a PBF (or .osm) file, then contracts the tracks into a graph
whose vertices are junctions, way ends and the track nodes stations attach to.
Every OSM station element (railway=station/halt, node or outline) gets attach
points: where trains serving it stop on the track.
"""

from __future__ import annotations

import pickle
import sys
from array import array
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import osmium
from geo import EARTH_M, metres
from scipy.spatial import cKDTree

RAIL = {"rail", "narrow_gauge", "light_rail", "subway", "monorail", "funicular", "tram"}
URBAN = {"light_rail", "subway", "monorail", "funicular", "tram"}
ROUTES = {"train", "subway", "light_rail", "tram", "monorail", "funicular"}
STATION = {"station", "halt"}
STOP_ROLES = {"stop", "stop_entry_only", "stop_exit_only"}
PLATFORM_ROLES = {"platform", "platform_entry_only", "platform_exit_only"}

# Attach search radii (m)
PLATFORM_TRACK_M = 40
ROUTE_STOP_M = 300
NEAR_TRACK_M = 150
# HSR station nodes often sit on the station square, away from the viaduct
FAR_TRACK_M = 2000
# Every station also attaches to the main tracks passing this close: stop
# areas often list only station sidings, or the metro's stop positions
MAIN_TRACK_M = 400
MAIN_TRACK_FAR_M = 1000  # when no main track is that close (沧州西: 407 m)
MAIN_TRACKS = 10
LINE_TRACK_M = 1000  # every line relation passing this close
MAINLINE = {"rail", "narrow_gauge"}


def to_xyz(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    # Unit-sphere points scaled to metres: chord distance ~ ground distance at
    # the scales searched here
    la, lo = np.radians(lat), np.radians(lon)
    return (
        np.column_stack((np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)))
        * EARTH_M
    )


@dataclass
class Way:
    nodes: array  # node ids
    lat: array
    lon: array
    kind: str  # railway=*
    highspeed: bool
    service: str  # siding / yard / spur / crossover / ""
    usage: str  # main / branch / industrial / ...


@dataclass
class Relation:
    tags: dict[str, str]
    members: list[tuple[str, int, str]]  # (n/w/r, id, role)


@dataclass
class Edge:
    u: int
    v: int
    way: int
    i: int  # node index in the way where the edge starts (u)
    j: int  # and ends (v); i < j
    length: float


@dataclass
class Graph:
    ways: dict[int, Way]
    relations: dict[int, Relation]
    points: dict[str, tuple[float, float, dict[str, str]]]  # N1 / W1 -> lat, lon, tags
    vertex_pos: dict[int, tuple[float, float]]
    edges: list[Edge]
    adj: dict[int, list[int]]  # vertex -> edge indexes
    attach: dict[str, list[int]]  # station element -> track vertices
    way_lines: dict[int, set[int]] = field(default_factory=dict)  # route=railway
    way_routes: dict[int, set[int]] = field(default_factory=dict)  # passenger routes

    def save(self, path: Path) -> None:
        with open(path, "wb") as f:
            pickle.dump(self, f, protocol=pickle.HIGHEST_PROTOCOL)

    @staticmethod
    def load(path: Path) -> Graph:
        with open(path, "rb") as f:
            return pickle.load(f)


class _Loader(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.ways: dict[int, Way] = {}
        self.points: dict[str, tuple[float, float, dict[str, str]]] = {}
        self.relations: dict[int, Relation] = {}

    def node(self, n: osmium.osm.Node) -> None:
        t = n.tags
        if (
            t.get("railway") in STATION | {"stop", "tram_stop", "platform"}
            or "public_transport" in t
        ) and n.location.valid():
            keep = {
                k: t[k]
                for k in ("railway", "public_transport", "name", "name:ja", "name:zh")
                if k in t
            }
            self.points[f"N{n.id}"] = (n.location.lat, n.location.lon, keep)

    def way(self, w: osmium.osm.Way) -> None:
        t = w.tags
        kind = t.get("railway")
        located = [
            (n.ref, n.location.lat, n.location.lon)
            for n in w.nodes
            if n.location.valid()
        ]
        if kind in RAIL and len(located) >= 2:
            self.ways[w.id] = Way(
                array("q", (r for r, _, _ in located)),
                array("d", (la for _, la, _ in located)),
                array("d", (lo for _, _, lo in located)),
                kind,
                t.get("highspeed") == "yes",
                t.get("service", ""),
                t.get("usage", ""),
            )
        elif (
            kind in STATION | {"platform"}
            or t.get("public_transport") in ("platform", "station")
        ) and located:
            lat = sum(la for _, la, _ in located) / len(located)
            lon = sum(lo for _, _, lo in located) / len(located)
            keep = {k: t[k] for k in ("railway", "public_transport", "name") if k in t}
            self.points[f"W{w.id}"] = (lat, lon, keep)

    def relation(self, r: osmium.osm.Relation) -> None:
        t = r.tags
        rtype = t.get("type")
        keep = rtype in ("route", "route_master") and (
            t.get("route", t.get("route_master")) in ROUTES | {"railway"}
        )
        if keep or t.get("public_transport") == "stop_area":
            self.relations[r.id] = Relation(
                dict(t), [(m.type, m.ref, m.role) for m in r.members]
            )


def _track_kind(w: Way) -> str:
    if w.kind in URBAN:
        return "urban"
    return "highspeed" if w.highspeed else "mainline"


def build(extract: Path) -> Graph:
    loader = _Loader()
    loader.apply_file(str(extract), locations=True, idx="flex_mem")
    ways, points, relations = loader.ways, loader.points, loader.relations
    print(
        f"{len(ways)} track ways, {len(points)} stop/station elements, {len(relations)} relations",
        file=sys.stderr,
    )

    # Track nodes and where they are
    uses: dict[int, int] = defaultdict(int)
    pos: dict[int, tuple[float, float]] = {}
    node_way: dict[int, int] = {}
    for wid, w in ways.items():
        for k, ref in enumerate(w.nodes):
            uses[ref] += 1
            pos[ref] = (w.lat[k], w.lon[k])
            node_way.setdefault(ref, wid)
        uses[w.nodes[0]] += 1  # way ends are vertices
        uses[w.nodes[-1]] += 1
    node_ids = np.fromiter(pos.keys(), dtype=np.int64, count=len(pos))
    coords = np.array(list(pos.values()))
    tree = cKDTree(to_xyz(coords[:, 0], coords[:, 1]))
    print(f"{len(pos)} track nodes", file=sys.stderr)

    def near_tracks(lat: float, lon: float, radius: float) -> list[tuple[float, int]]:
        found = tree.query_ball_point(
            to_xyz(np.array([lat]), np.array([lon]))[0], radius
        )
        return sorted((metres(lat, lon, *coords[k]), int(node_ids[k])) for k in found)

    # Stop areas and routes by member
    areas_of: dict[str, list[int]] = defaultdict(list)
    for rid, rel in relations.items():
        if rel.tags.get("public_transport") == "stop_area":
            for t, ref, _ in rel.members:
                areas_of[f"{t.upper()}{ref}"].append(rid)
    route_stops: list[
        tuple[float, float, int]
    ] = []  # track stop nodes listed by routes
    for rel in relations.values():
        if rel.tags.get("route") in ROUTES:
            for t, ref, role in rel.members:
                if t == "n" and role in STOP_ROLES and ref in pos:
                    route_stops.append((*pos[ref], ref))
    stop_tree = (
        cKDTree(
            to_xyz(
                np.array([s[0] for s in route_stops]),
                np.array([s[1] for s in route_stops]),
            )
        )
        if route_stops
        else None
    )

    way_lines: dict[int, set[int]] = defaultdict(set)
    way_routes: dict[int, set[int]] = defaultdict(set)
    for rid, rel in relations.items():
        route = rel.tags.get("route")
        if rel.tags.get("type") != "route" or route not in ROUTES | {"railway"}:
            continue
        target = way_lines if route == "railway" else way_routes
        for t, ref, _ in rel.members:
            if t == "w" and ref in ways:
                target[ref].add(rid)

    attach: dict[str, list[int]] = {}
    for elem, (lat, lon, tags) in points.items():
        if (
            tags.get("railway") not in STATION
            and tags.get("public_transport") != "station"
        ):
            continue
        found: set[int] = set()
        if elem[0] == "N" and int(elem[1:]) in pos:
            found.add(int(elem[1:]))
        for area in areas_of.get(elem, []):
            for t, ref, role in relations[area].members:
                member = f"{t.upper()}{ref}"
                if t == "n" and ref in pos:
                    found.add(ref)  # stop position on a track
                elif member in points and (
                    role in PLATFORM_ROLES
                    or points[member][2].get("railway") == "platform"
                ):
                    near = near_tracks(*points[member][:2], PLATFORM_TRACK_M)
                    found.update(ref for _, ref in near[:2])
        if not found and stop_tree is not None:
            hits = stop_tree.query_ball_point(
                to_xyz(np.array([lat]), np.array([lon]))[0], ROUTE_STOP_M
            )
            found.update(route_stops[k][2] for k in hits)
        if not found:
            near = (
                near_tracks(lat, lon, NEAR_TRACK_M)
                or near_tracks(lat, lon, FAR_TRACK_M)[:1]
            )
            found.update(ref for _, ref in near[:8])
        # Each kind of track separately: a metro beside a station (许昌东:
        # the 郑许 line) or a conventional line (广州北: 京广线) must not stop
        # the search for its high-speed line
        for wanted in ("highspeed", "mainline", "urban"):
            main: dict[int, int] = {}  # way -> its nearest node
            radii = (
                (MAIN_TRACK_M,)
                if wanted == "urban"
                else (MAIN_TRACK_M, MAIN_TRACK_FAR_M)
            )
            for radius in radii:
                for _, ref in near_tracks(lat, lon, radius):
                    w = ways[node_way[ref]]
                    if (
                        not w.service
                        and _track_kind(w) == wanted
                        and node_way[ref] not in main
                    ):
                        main[node_way[ref]] = ref
                        if len(main) >= MAIN_TRACKS:
                            break
                if main:
                    break
            found.update(main.values())
        # And to every line passing within LINE_TRACK_M: at interchanges the
        # lines meet hundreds of metres apart (德清: 宁杭 at 70 m, 合杭 at 459 m)
        by_line: dict[int, int] = {}
        for _, ref in near_tracks(lat, lon, LINE_TRACK_M):
            if ways[node_way[ref]].service:
                continue
            for r in way_lines.get(node_way[ref], ()):
                by_line.setdefault(r, ref)
        found.update(by_line.values())
        if found:
            attach[elem] = sorted(found)
    print(f"{len(attach)} station elements attached to track", file=sys.stderr)

    # Contract: vertices are junctions, way ends and attach points
    vertices = {ref for ref, n in uses.items() if n >= 2}
    for refs in attach.values():
        vertices.update(refs)
    edges: list[Edge] = []
    adj: dict[int, list[int]] = defaultdict(list)
    for wid, w in ways.items():
        start, length = 0, 0.0
        for k in range(1, len(w.nodes)):
            length += metres(w.lat[k - 1], w.lon[k - 1], w.lat[k], w.lon[k])
            if w.nodes[k] in vertices:
                e = Edge(w.nodes[start], w.nodes[k], wid, start, k, length)
                adj[e.u].append(len(edges))
                adj[e.v].append(len(edges))
                edges.append(e)
                start, length = k, 0.0
    print(f"{len(vertices)} vertices, {len(edges)} edges", file=sys.stderr)

    return Graph(
        ways,
        relations,
        points,
        {v: pos[v] for v in vertices},
        edges,
        dict(adj),
        attach,
        dict(way_lines),
        dict(way_routes),
    )


if __name__ == "__main__":
    # Through the module, so the pickle refers to graph.Way, not __main__.Way
    import graph as _graph

    _graph.build(Path(sys.argv[1])).save(Path(sys.argv[2]))
