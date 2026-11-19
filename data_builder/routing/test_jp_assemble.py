"""Tests of jp_assemble.py: a Yahoo train's route from a tiny store of hops,
in the tables export_d1.py creates, in sqlite3.

The Worker runs a port of jp_assemble.py (src/worker/api/jp-assemble.ts) with
the same cases (train-route.test.ts).

Run: python3 -m unittest discover -s data_builder/routing -p "test_*.py"
"""

import json
import sqlite3
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_d1  # noqa: E402
import jp_assemble  # noqa: E402
from geo import encode_polyline  # noqa: E402

EXTRACT = "2026-11-12T16:00:00Z"
# Three stations 1 km apart along a line, and 4 only the 新幹線 serves
STATIONS = {
    "1": (35.0, 139.0),
    "2": (35.0, 139.011),
    "3": (35.0, 139.022),
    "4": (35.001, 139.022),
}


def hop(route_id, seq, a, b, ways, highspeed=0.0):
    (la, lo), (lb, lob) = STATIONS[a], STATIONS[b]
    return (
        route_id,
        seq,
        a,
        b,
        1000 * len(ways),
        json.dumps(ways),
        "[]",
        encode_polyline([(la, lo), (lb, lob)]),
        json.dumps([lo, la]),
        json.dumps([lob, lb]),
        highspeed,
    )


TABLES = {
    "stations": [
        (c, la, lo, json.dumps([f"N{c}"])) for c, (la, lo) in STATIONS.items()
    ],
    # id, name, shinkansen, loop, stops, train pattern
    "routes": [
        (10, "JRテスト線 普通", 0, 0, 3, None),
        (20, "テスト新幹線", 1, 0, 2, None),
        (-1, "特急 鎌倉 (1 => 3)", 0, 0, 2, "特急 鎌倉"),
    ],
    "route_stops": [
        ("1", 10, 0),
        ("2", 10, 1),
        ("3", 10, 2),
        ("1", 20, 0),
        ("4", 20, 1),
        ("1", -1, 0),
        ("3", -1, 1),
    ],
    "hops": [
        hop(10, 0, "1", "2", [101]),
        hop(10, 1, "2", "3", [102]),
        hop(20, 0, "1", "4", [201, 202], highspeed=1.0),
        hop(-1, 0, "1", "3", [301, 302]),
    ],
}


def make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for t, cols in export_d1.JP_TABLES.items():
        conn.executescript("\n".join(export_d1.table_sql(f"jp_{t}", cols, TABLES[t])))
    conn.execute(f"CREATE VIEW jp_version AS SELECT '{EXTRACT}' AS version")
    return conn


def route(train: dict, conn: sqlite3.Connection) -> tuple[int, Any]:
    """200 and the route, as the API answers"""
    return 200, jp_assemble.run_sqlite(jp_assemble.route(train), conn)


def train(name: str, *codes: str, line: str = "ＪＲテスト線") -> dict:
    return {
        "name": name,
        "line": line,
        "stops": [{"code": c, "name": f"駅{c}"} for c in codes],
    }


class TrainRouteTest(unittest.TestCase):
    conn: sqlite3.Connection

    @classmethod
    def setUpClass(cls) -> None:
        cls.conn = make_db()
        cls.addClassCleanup(cls.conn.close)

    def test_local_train_on_its_route(self) -> None:
        status, body = route(train("普通", "1", "2", "3"), self.conn)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["data_version"], EXTRACT)
        self.assertEqual(body["ways"], [101, 102])
        self.assertEqual(
            [(x["from"], x["to"], x["line"], x["method"]) for x in body["legs"]],
            [
                ("駅1", "駅2", "JRテスト線 普通", "line"),
                ("駅2", "駅3", "JRテスト線 普通", "line"),
            ],
        )
        self.assertEqual(
            body["stops"][1],
            {"name": "駅2", "position": [139.011, 35.0], "elements": ["N2"]},
        )

    def test_conventional_train_keeps_off_shinkansen(self) -> None:
        # Only the 新幹線 route stops at both 1 and 4: better straight
        status, body = route(train("快速", "1", "4"), self.conn)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["legs"][0]["method"], "straight")
        self.assertTrue(body["legs"][0]["straight"])

    def test_shinkansen_train_on_shinkansen(self) -> None:
        status, body = route(
            train("新幹線 テスト1号", "1", "4", line="テスト新幹線"), self.conn
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(body["ways"], [201, 202])

    def test_rule_route_first(self) -> None:
        status, body = route(train("特急 鎌倉", "1", "3"), self.conn)
        self.assertEqual(status, 200, body)
        self.assertEqual(
            (body["ways"], body["legs"][0]["line"]), ([301, 302], "特急 鎌倉 (1 => 3)")
        )

    def test_stop_not_in_the_data(self) -> None:
        status, body = route(train("普通", "1", "9"), self.conn)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["legs"][0]["method"], "straight")
        self.assertEqual(
            body["stops"][1], {"name": "駅9", "position": None, "elements": []}
        )


if __name__ == "__main__":
    unittest.main()
