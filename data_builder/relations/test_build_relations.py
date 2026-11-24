"""Tests of build_relations.py on a small made-up network. Needs osmium
(pyosmium), numpy and scipy; skipped without them.

Run: nix-shell data_builder/shell.nix --run 'python3 -m unittest discover -s data_builder/relations -p "test_*.py"'
"""

import csv
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

try:
    import numpy  # noqa: F401
    import osmium  # noqa: F401
    import scipy  # noqa: F401
except ImportError:
    raise unittest.SkipTest("needs osmium, numpy and scipy") from None

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_relations as br  # noqa: E402

LON, LAT = 139.7, 35.6


def at(x: float, y: float) -> tuple[float, float]:
    """Metres east and north of (LON, LAT)"""
    return (
        LON + x / (br.M_PER_DEG * math.cos(math.radians(LAT))),
        LAT + y / br.M_PER_DEG,
    )


def esc(s: str) -> str:
    return "".join(
        c if c.isascii() and (c.isalnum() or c in "-_.:#") else f"%{ord(c):x}%"
        for c in s
    )


def tags(**kv: str) -> str:
    return ",".join(f"{esc(k.replace('__', ':'))}={esc(v)}" for k, v in kv.items())


def decode(polyline: str) -> list[tuple[float, float]]:
    values, shift, result = [], 0, 0
    for ch in polyline:
        b = ord(ch) - 63
        result |= (b & 0x1F) << shift
        shift += 5
        if b < 0x20:
            values.append(~(result >> 1) if result & 1 else result >> 1)
            shift = result = 0
    lat = lon = 0
    out = []
    for dlat, dlon in zip(values[::2], values[1::2]):
        lat += dlat
        lon += dlon
        out.append((lon / 1e6, lat / 1e6))
    return out


class Network:
    """Writes OPL: nodes first, then ways, then relations"""

    def __init__(self) -> None:
        self.nodes: list[str] = []
        self.ways: list[str] = []
        self.relations: list[str] = []
        self.next_node = 1000

    def node(self, x: float, y: float, nid: int | None = None, **kv: str) -> int:
        if nid is None:
            self.next_node += 1
            nid = self.next_node
        lon, lat = at(x, y)
        self.nodes.append(f"n{nid} T{tags(**kv)} x{lon:.7f} y{lat:.7f}")
        return nid

    def way(self, wid: int, nodes: list[int], **kv: str) -> int:
        self.ways.append(f"w{wid} N{','.join(f'n{n}' for n in nodes)} T{tags(**kv)}")
        return wid

    def track(
        self,
        wid: int,
        points: list[tuple[float, float]],
        ends: tuple[int, int] | None = None,
    ) -> int:
        nodes = [self.node(x, y) for x, y in points]
        if ends:
            nodes[0], nodes[-1] = ends
        return self.way(wid, nodes, railway="rail")

    def relation(
        self, rid: int, members: list[tuple[str, int, str]], **kv: str
    ) -> None:
        m = ",".join(f"{t}{i}@{esc(role)}" for t, i, role in members)
        self.relations.append(f"r{rid} M{m} T{tags(**kv)}")

    def write(self, path: Path) -> None:
        path.write_text(
            "\n".join(self.nodes + self.ways + self.relations) + "\n", encoding="utf-8"
        )


def network() -> Network:
    n = Network()
    # A double-track line west to east, 10 km: three ways and a second track beside them
    j = [n.node(x, 0) for x in (0, 4000, 7000, 10000, 7020)]
    stop_6000 = n.node(
        6000, 0, 2, public_transport="stop_position", railway__position="12.3"
    )
    stop_5000 = n.node(5000, 0, 3, public_transport="stop_position", railway="stop")
    stop_0 = n.node(0, 0, 4, public_transport="stop_position", railway="stop")
    stop_end = n.node(9990, 0, 5, public_transport="stop_position", railway="stop")
    n.track(1, [(0, 0), (2000, 0), (4000, 0)], (stop_0, j[1]))
    n.way(2, [j[1], stop_5000, stop_6000, j[2]], railway="rail")
    # A short way between long ones, as at a switch
    n.way(5, [j[2], j[4]], railway="rail")
    n.way(3, [j[4], n.node(8500, 0), stop_end, j[3]], railway="rail")
    n.track(4, [(0, 10), (5000, 10), (10000, 10)])
    # Stations: listed (甲 on the track, 丙 200 m off it), near the track (飛驒古川),
    # through a stop area only (丁, 300 m off), and some that are not stations of the line
    n.node(0, 30, 11, railway="station", name="甲")
    n.node(5000, 50, 12, railway="station", name="飛驒古川")
    n.node(10000, -200, 13, railway="station", name="丙")
    n.node(6000, 300, 14, railway="station", name="丁")
    n.node(7000, 20, 15, public_transport="station", name="バスターミナル")
    n.node(8000, 10, 16, railway="station")
    n.node(3000, 40, 18, railway="station", station="subway", name="地铁站")
    n.node(10000, -220, 19, railway="station", name="丙站")
    # A subway station of the same name, and another station in 甲's stop area
    n.node(100, 30, 20, railway="station", station="subway", name="甲")
    n.node(0, 60, 21, railway="station", name="乙町")
    platform = n.way(20, [n.node(-50, -8), n.node(50, -8)], railway="platform")
    n.relation(
        30,
        [("n", 14, ""), ("n", stop_6000, "stop")],
        public_transport="stop_area",
        type="public_transport",
    )
    n.relation(
        31,
        [
            ("n", 11, ""),
            ("n", 21, ""),
            ("n", stop_0, "stop"),
            ("w", platform, "platform"),
        ],
        public_transport="stop_area",
    )
    n.relation(
        100,
        [("w", 1, ""), ("w", 2, ""), ("w", 5, ""), ("w", 3, ""), ("w", 4, ""), ("n", 11, "stop"),
         ("n", 13, "")],
        type="route", route="railway", name="試験線", **{"from": "丙"},
    )  # fmt: skip
    n.relation(
        200,
        [("n", stop_0, "stop_entry_only"), ("w", platform, "platform"), ("n", stop_5000, "stop"),
         ("n", stop_end, "stop_exit_only"), ("w", 1, ""), ("w", 2, ""), ("w", 5, ""), ("w", 3, "")],
        type="route", route="train", name="普通", colour="#FF0000", ref="A", wikidata="Q1",
    )  # fmt: skip
    n.relation(
        300, [("r", 200, "")], type="route_master", route_master="train", name="試験線"
    )
    # A 2 km square loop with a station on each side
    corners = [
        n.node(x, y) for x, y in ((0, 5000), (2000, 5000), (2000, 7000), (0, 7000))
    ]
    for i in range(4):
        n.way(40 + i, [corners[i], corners[(i + 1) % 4]], railway="subway")
    for nid, (x, y), name in zip(
        (51, 52, 53, 54),
        ((1000, 4990), (2010, 6000), (1000, 7010), (-10, 6000)),
        "東南西北",
        strict=True,
    ):
        n.node(x, y, nid, railway="station", station="subway", name=name)
    n.relation(
        400,
        [("w", 40 + i, "") for i in range(4)],
        type="route",
        route="railway",
        name="環状線",
    )
    # Closed long ago, 10 km past the end of the track
    n.node(20000, 0, 17, railway="station", name="廃止駅")
    return n


def n02_station(name: str, x: float, y: float) -> dict:
    a, b = at(x - 50, y), at(x + 50, y)
    return {
        "type": "Feature",
        "properties": {"N02_003": "試験線", "N02_004": "試験鉄道", "N02_005": name},
        "geometry": {"type": "LineString", "coordinates": [list(a), list(b)]},
    }


def write_inputs(tmp: Path) -> None:
    network().write(tmp / "net.opl")
    with open(tmp / "line_groups.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "group_id",
                "line_id",
                "source",
                "operator",
                "legal_name",
                "name",
                "aliases",
            ]
        )
        w.writerow(
            [
                0,
                "jp-0123456789",
                "n02",
                "試験鉄道",
                "試験線",
                "試験本線",
                "快速線|緩行線",
            ]
        )
    with open(tmp / "line_group_ways.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["group_id", "way_id", "rank"])
        for way, rank in ((1, 0), (2, 0), (3, 0), (4, 1), (5, 0)):
            w.writerow([0, way, rank])
    stations = [
        n02_station("甲", 0, 20),
        n02_station("飛騨古川", 5000, 20),
        n02_station("丙", 10000, -150),
        n02_station("バスターミナル", 7000, 20),
        n02_station("廃止駅", 20000, 0),
    ]
    (tmp / "Station.geojson").write_text(
        json.dumps({"features": stations}), encoding="utf-8"
    )


def build(tmp: Path) -> dict:
    builder = br.Builder(tmp / "net.opl")
    bodies = dict(builder.relations_rows())
    bodies.update(builder.official_lines_rows(tmp, tmp / "Station.geojson"))
    return bodies


class BuildTest(unittest.TestCase):
    bodies: dict
    tmp: Path

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        write_inputs(cls.tmp)
        cls.bodies = build(cls.tmp)

    def test_same_output_every_run(self) -> None:
        # Python orders sets of strings differently in each process
        code = (
            f"import json, sys; sys.path.insert(0, {str(HERE)!r}); "
            "from pathlib import Path; import test_build_relations as t; "
            f"print(json.dumps(t.build(Path({str(self.tmp)!r})), sort_keys=True))"
        )
        outputs = {
            subprocess.run(
                [sys.executable, "-c", code],
                env={**os.environ, "PYTHONHASHSEED": seed},
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            for seed in ("1", "2", "3")
        }
        self.assertEqual(len(outputs), 1)

    def test_line_stations_ordered_along_the_track(self) -> None:
        stops = self.bodies["100"]["stops"]
        # Its from= is 丙, so the order runs from there; the metro station 40 m off
        # the track is not this main line's
        self.assertEqual([s["name"] for s in stops], ["丙", "丁", "飛驒古川", "甲"])
        by_name = {s["name"]: s for s in stops}
        self.assertEqual(by_name["甲"]["elements"], ["N11", "N21"])
        self.assertEqual(by_name["丁"]["km"], 12.3)
        # Placed on the track, not at the station node 50 m off it
        self.assertLess(
            abs(by_name["飛驒古川"]["position"][1] - LAT) * br.M_PER_DEG, 15
        )

    def test_line_keeps_relation_fields(self) -> None:
        body = self.bodies["100"]
        self.assertEqual(body["relation"]["kind"], "line")
        self.assertEqual(body["relation"]["from"], "丙")
        self.assertEqual(body["ways"], [1, 2, 5, 3, 4])
        # The second track lies beside the first: counted once, drawn as one piece
        # simplified to its ends
        self.assertAlmostEqual(body["length_m"], 10000, delta=20)
        self.assertEqual(len(body["overview"]), 1)
        self.assertEqual(len(decode(body["overview"][0])), 2)

    def test_route_stops_merge_stop_and_platform(self) -> None:
        body = self.bodies["200"]
        self.assertEqual(
            [(s["name"], s["elements"]) for s in body["stops"]],
            [("甲", ["N11", "N21"]), ("飛驒古川", ["N12"]), ("丙", ["N13"])],
        )
        first = body["stops"][0]["position"]
        self.assertEqual(first, [round(c, 6) for c in at(0, 0)])
        self.assertEqual(body["ways"], [1, 2, 5, 3])
        # Short ways between long ones stay, so the route is one piece
        self.assertEqual(len(body["overview"]), 1)
        self.assertEqual(
            body["relation"],
            {
                "id": 200, "kind": "route", "type": "train", "name": "普通", "ref": "A",
                "from": None, "to": None, "operator": None, "network": None, "colour": "#FF0000",
                "master": 300, "wikidata": "Q1", "wikipedia": None,
            },
        )  # fmt: skip

    def test_stops_ranked_by_the_routes_stopping_there(self) -> None:
        # Only route 200 carries passengers: its stations rank 1, 乙町 too by
        # sharing 甲's stop area, and the line's other stations 0
        self.assertEqual([s["rank"] for s in self.bodies["200"]["stops"]], [1, 1, 1])
        line = {s["name"]: s["rank"] for s in self.bodies["100"]["stops"]}
        self.assertEqual(line["甲"], 1)
        builder = br.Builder(self.tmp / "net.opl")
        self.assertEqual(
            {br.ref(e): n for e, n in builder.station_ranks().items()},
            {"N11": 1, "N21": 1, "N12": 1, "N13": 1},
        )

    def test_route_master(self) -> None:
        body = self.bodies["300"]
        self.assertEqual(body["relation"]["kind"], "master")
        self.assertEqual([r["id"] for r in body["routes"]], [200])
        self.assertEqual(set(body), {"relation", "routes", "bbox", "overview"})

    def test_loop_goes_round(self) -> None:
        names = "".join(s["name"] for s in self.bodies["400"]["stops"])
        self.assertIn(names, ("東南西北" * 2 + "".join(reversed("東南西北")) * 2))

    def test_official_line(self) -> None:
        body = self.bodies["jp-0123456789"]
        # N02's spelling differs (飛騨); the bus terminal is no railway station, and
        # the closed station lies far from the track
        # No from= to go by: west to east
        self.assertEqual([s["name"] for s in body["stops"]], ["甲", "飛驒古川", "丙"])
        relation = body["relation"]
        self.assertEqual(
            (relation["name"], relation["operator"]), ("試験本線", "試験鉄道")
        )
        self.assertEqual(relation["aliases"], ["快速線", "緩行線"])
        self.assertEqual(relation["colour"], "#ff0000")
        self.assertEqual(relation["attribution"], br.N02_ATTRIBUTION)
        self.assertEqual(body["ways"], [1, 2, 3, 4, 5])
        # 丙站 is 丙 by another name; the subway's 甲 and 乙町, in 甲's stop area,
        # are other stations
        stops = {stop["name"]: stop for stop in body["stops"]}
        self.assertEqual(stops["丙"]["elements"], ["N13", "N19"])
        self.assertEqual(stops["甲"]["elements"], ["N11"])


class TrackTest(unittest.TestCase):
    def test_pieces_far_apart_are_one_line(self) -> None:
        # Two pieces 10 km apart, as where another company runs the line in between
        ways = {
            1: ({}, [1, 2], [at(0, 0), at(3000, 0)]),
            2: ({}, [3, 4], [at(13000, 0), at(16000, 0)]),
        }
        track = br.Track(ways, [1, 2])
        self.assertEqual(br.connected_components(track.graph(), directed=False)[0], 1)
        points = [at(15000, 0), at(1000, 0), at(14000, 0), at(2000, 0)]
        self.assertIn(track.order(points), ([1, 3, 2, 0], [0, 2, 3, 1]))

    def test_tracks_side_by_side_are_one_line(self) -> None:
        # Joined only at one end: stations on either track still go in order
        ways = {
            1: ({}, [1, 2], [at(0, 0), at(10000, 0)]),
            2: ({}, [1, 3], [at(0, 0), at(10000, 8)]),
        }
        track = br.Track(ways, [1, 2])
        points = [at(9000, 9), at(3000, -1), at(6000, 9), at(1000, 0)]
        self.assertIn(track.order(points), ([3, 1, 2, 0], [0, 2, 1, 3]))


class OneTrackTest(unittest.TestCase):
    def test_tracks_side_by_side_count_once(self) -> None:
        # Drawn in opposite directions, so they start 10 km apart: a north-south
        # double track, and a way far east of it
        ways = SimpleNamespace(
            ways={
                1: ({}, [1, 2], [at(0, 0), at(0, 10000)]),
                2: ({}, [3, 4], [at(5, 10000), at(5, 0)]),
                3: ({}, [5, 6], [at(30000, 2000), at(30000, 8000)]),
            }
        )
        self.assertEqual(br.Builder.one_track(ways, [1, 2, 3]), [1, 3])


class HelperTest(unittest.TestCase):
    def test_name_key(self) -> None:
        for a, b in (
            ("飛驒古川", "飛騨古川"),
            ("皆実町2丁目", "皆実町二丁目"),
            ("押上〈スカイツリー前〉", "押上"),
            ("虹の駅", "虹"),
        ):
            self.assertEqual(br.name_key(a), br.name_key(b))

    def test_encode_round_trip(self) -> None:
        points = [(139.766441, 35.680611), (139.739081, 35.628459), (-0.000001, 0.0)]
        self.assertEqual(decode(br.encode(points)), points)

    def test_css_colour(self) -> None:
        self.assertEqual(br.css_colour(" #B1CB39 "), "#B1CB39")
        self.assertEqual(br.css_colour("Red"), "Red")
        self.assertIsNone(br.css_colour("#12345"))
        self.assertIsNone(br.css_colour("JR green"))


if __name__ == "__main__":
    unittest.main()
