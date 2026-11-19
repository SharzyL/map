"""Tests for the routing proof of concept on a small synthetic network.

    A ==(1)== J ==(2)== B ==(3)== C        conventional, route R10 stops A, B, C
          \\                     /
           ==(4) high speed ==(5)          high-speed bypass from J to C

Run: nix-shell data_builder/shell.nix --run 'python3 -m unittest discover -s data_builder/routing'
"""

import math
import tempfile
import unittest
from pathlib import Path

from cr_route import retrace
from graph import build
from route import Prefs, encode_polyline, path_response, route_leg

OSM = """<?xml version='1.0' encoding='UTF-8'?>
<osm version="0.6">
  <node id="1" lat="35.000" lon="139.000"><tag k="railway" v="station"/><tag k="name" v="A"/></node>
  <node id="2" lat="35.000" lon="139.010"/>
  <node id="3" lat="35.000" lon="139.020"/>
  <node id="4" lat="35.000" lon="139.030"/>
  <node id="5" lat="35.000" lon="139.040"/>
  <node id="6" lat="35.000" lon="139.060"/>
  <node id="7" lat="35.010" lon="139.030"/>
  <node id="8" lat="35.0002" lon="139.040"><tag k="railway" v="station"/><tag k="name" v="B"/></node>
  <node id="9" lat="35.000" lon="139.060"/>
  <node id="10" lat="35.0003" lon="139.0601"><tag k="railway" v="station"/><tag k="name" v="C"/></node>
  <way id="101"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="railway" v="rail"/></way>
  <way id="102"><nd ref="3"/><nd ref="4"/><nd ref="5"/><tag k="railway" v="rail"/></way>
  <way id="103"><nd ref="5"/><nd ref="6"/><tag k="railway" v="rail"/></way>
  <way id="104"><nd ref="3"/><nd ref="7"/><tag k="railway" v="rail"/><tag k="highspeed" v="yes"/></way>
  <way id="105"><nd ref="7"/><nd ref="6"/><tag k="railway" v="rail"/><tag k="highspeed" v="yes"/></way>
  <relation id="10">
    <member type="node" ref="1" role="stop"/><member type="node" ref="5" role="stop"/><member type="node" ref="6" role="stop"/>
    <member type="way" ref="101" role=""/><member type="way" ref="102" role=""/><member type="way" ref="103" role=""/>
    <tag k="type" v="route"/><tag k="route" v="train"/><tag k="name" v="R10"/>
  </relation>
  <relation id="20">
    <member type="node" ref="8" role=""/><member type="node" ref="5" role="stop"/>
    <tag k="public_transport" v="stop_area"/>
  </relation>
</osm>
"""


class RoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "net.osm"
            path.write_text(OSM)
            cls.g = build(path)

    def test_attach(self) -> None:
        # A is on the track; B through its stop area; C near the track
        self.assertEqual(self.g.attach["N1"], [1])
        self.assertEqual(self.g.attach["N8"], [5])
        self.assertIn(6, self.g.attach["N10"])

    def test_highspeed_preference(self) -> None:
        a, c = self.g.attach["N1"], self.g.attach["N10"]
        _, conv, conv_len, _ = route_leg(self.g, a, c, Prefs(highspeed="avoid"))
        _, fast, _, _ = route_leg(self.g, a, c, Prefs(highspeed="prefer"))
        ways = lambda edges: {self.g.edges[e].way for e, _ in edges}
        self.assertEqual(ways(conv), {101, 102, 103})
        self.assertEqual(ways(fast), {101, 104, 105})
        self.assertAlmostEqual(conv_len, 5470, delta=60)

    def test_hint_keeps_to_route(self) -> None:
        a, c = self.g.attach["N1"], self.g.attach["N10"]
        method, edges, _, _ = route_leg(
            self.g, a, c, Prefs(highspeed="prefer", ways=frozenset({101, 102, 103}))
        )
        self.assertEqual(method, "line")
        self.assertEqual({self.g.edges[e].way for e, _ in edges}, {101, 102, 103})

    def test_response_splits_whole_and_partial_ways(self) -> None:
        from route import Leg

        a, b = self.g.attach["N1"], self.g.attach["N8"]
        method, edges, length, _ = route_leg(self.g, a, b, Prefs(highspeed="avoid"))
        leg = Leg(0, 1, method, edges, length)
        resp = path_response(
            self.g,
            [{"position": (35.0, 139.0)}, {"position": (35.0002, 139.04)}],
            [leg],
            "t",
        )
        self.assertEqual(resp["ways"], [101, 102])
        self.assertEqual(resp["partial"], [])
        self.assertEqual(resp["stops"][0]["position"], [139.0, 35.0])
        self.assertEqual(resp["legs"][0]["method"], "graph")

    def test_no_reversing_between_stops(self) -> None:
        from route import search

        # 7 lies on the high-speed branch leaving J (3) eastwards. From B (5)
        # it needs a reversal at J or at C, so there is no path; from A there is
        self.assertIsNone(search(self.g, [5], [7], Prefs()))
        found = search(self.g, [1], [7], Prefs())
        assert found is not None
        self.assertEqual([self.g.edges[e].way for e, _ in found[1]], [101, 104])

    def test_reversal_at_a_stop_costs_extra(self) -> None:
        from route import search

        # Arriving at B from the west, carrying on east is free, going back
        # west costs the reversal
        _, to_b = search(self.g, [1], [5], Prefs())
        last = to_b[-1]
        self.assertIsNone(search(self.g, [5], [1], Prefs(), arriving=last))
        cost, _ = search(self.g, [5], [1], Prefs(), arriving=last, reverse_cost=1000)
        self.assertAlmostEqual(cost, 1000 + 3650, delta=60)

    def test_turns_back(self) -> None:
        from types import SimpleNamespace

        from cr_route import Builder
        from route import search

        # Arriving at B from the west: on east is through, back west turns
        # back, and so does the high-speed branch back at J
        b = SimpleNamespace(g=self.g)
        _, to_b = search(self.g, [1], [5], Prefs())
        _, east = search(self.g, [5], [6], Prefs(), arriving=to_b[-1])
        _, west = search(self.g, [5], [1], Prefs(), arriving=to_b[-1], reverse_cost=1000)
        self.assertFalse(Builder.turns_back(b, to_b[-1], east[0]))
        self.assertTrue(Builder.turns_back(b, to_b[-1], west[0]))

    def test_polyline_round_trip(self) -> None:
        from geo import decode_polyline

        pts = [
            (35.681236, 139.767125),
            (35.658034, 139.701636),
            (34.733504, 135.500202),
        ]
        self.assertEqual(decode_polyline(encode_polyline(pts)), pts)

    def test_polyline(self) -> None:
        # Google's example, at precision 5
        pts = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
        self.assertEqual(encode_polyline(pts, 5), "_p~iF~ps|U_ulLnnqC_mqNvxq`@")


class RetraceTest(unittest.TestCase):
    """cr_route.retrace: routes running back over their own track"""

    @staticmethod
    def east(km: float) -> tuple[float, float]:
        return 31.0, 121.0 + km / 95.4  # about 1 km a step at this latitude

    def test_out_and_back(self) -> None:
        out = [self.east(k) for k in range(21)]
        back = list(reversed(out))[1:]
        km, turn, stop = retrace(out + back, [])
        self.assertGreater(km, 8)
        self.assertAlmostEqual(turn[1], self.east(20)[1], places=3)
        self.assertEqual(stop, "")
        # Turning where the train stops: named, as the reversal may be real
        stops = [{"name": "X", "position": [self.east(20)[1], 31.0]}]
        self.assertEqual(retrace(out + back, stops)[2], "X")

    def test_loop_and_through_route(self) -> None:
        # Round a 20 km circle back to the start: a loop, not a retrace
        loop = [
            (31.0 + 0.03 * math.sin(a * math.pi / 20), 121.0 + 0.035 * math.cos(a * math.pi / 20))
            for a in range(41)
        ]
        self.assertIsNone(retrace(loop, []))
        self.assertIsNone(retrace([self.east(k) for k in range(30)], []))


if __name__ == "__main__":
    unittest.main()
