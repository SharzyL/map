"""Tests of build_d1.py: a small timetable goes through its SQL into sqlite3,
standing in for D1, and the rules that label lines and numbers.

The same timetable, built as versions 20261114 and 20261120, is what the
Worker's tests load (src/worker/api/fixtures/cr-*.sql): when this output
changes, the fixtures are regenerated here and the Worker's tests show what
that means for the API.

Run: python3 -m unittest discover -s scripts -p "test_*.py"
"""

import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parents[1] / "src" / "worker" / "api" / "fixtures"
sys.path.insert(0, str(HERE))

import build_d1  # noqa: E402

STATIONS = {
    "北京": ("BJP", "beijing", "bj"),
    "北京南": ("VNP", "beijingnan", "bjn"),
    "天津南": ("TIP", "tianjinnan", "tjn"),
    "上海虹桥": ("AOH", "shanghaihongqiao", "shhq"),
}
# (train, start, end, period, mask, [(station, arrival min, dwell, km, platform)],
#  [(start, end, model, coupled, depot, text)], [(line, [(station, km)])],
#  xw.dat's [(km, half of a double number)])
TRAINS = [
    ("G1", 20260101, 20501231, 1, 1,
     [("北京南", 390, 0, 0, "17"), ("天津南", 420, 2, 120, ""), ("上海虹桥", 684, 0, 1318, "")],
     # Re-equipped on Nov 20; the newer assignment wins where both apply
     [(20250101, 20991231, "CR400AF", False, "京局北京动车段", "CR400AF"),
      (20261120, 20991231, "CR400AF-Z", True, "", "CR400AF-Z型重联")],
     [("京沪高速线", [("北京南", 0), ("廊坊", 59), ("天津南", 120), ("上海虹桥", 1318)])], []),
    # Every other day (leaves on Nov 15 and 17), arrives the next morning
    ("Z1/Z2", 20260101, 20501231, 2, 1,
     [("北京", 1320, 0, 0, ""), ("天津南", 1400, 5, 130, "3"), ("上海虹桥", 420, 0, 1460, "")],
     # Leaves 北京 as Z1, goes on from 天津南 as Z2
     [], [("京沪线", [("北京", 0), ("天津南", 130)]), ("京沪线", [("天津南", 130), ("上海虹桥", 1460)])],
     [(0, 0), (130, 1)]),
    # Service ended before NOW
    ("G9", 20260101, 20261031, 1, 1, [("北京南", 600, 0, 0, ""), ("上海虹桥", 900, 0, 1318, "")],
     [(20250101, 20261031, "CRH380A", False, "", "CRH380A")], [], []),
    # Two trains under one number
    ("4651/4654", 20260101, 20501231, 1, 1, [("北京", 480, 0, 0, ""), ("天津南", 600, 0, 130, "")],
     [], [], []),
    ("4651/4654B", 20260101, 20501231, 1, 1, [("北京", 500, 0, 0, ""), ("天津南", 620, 0, 130, "")],
     [], [], []),
]  # fmt: skip
OSM = [("N", "1", "北京南"), ("W", "2", "北京南"), ("N", "3", "天津南")]


def fixture_sql() -> dict[str, str]:
    """The Worker's fixtures: the timetable above, and a later version with
    G1 alone, renumbered G7"""
    return {
        "cr-20261114.sql": build_d1.build_sql("20261114", build_d1.rows(STATIONS, TRAINS, OSM)),
        "cr-20261120.sql": build_d1.build_sql(
            "20261120", build_d1.rows(STATIONS, [("G7", *TRAINS[0][1:])], OSM)
        ),
    }


def make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.executescript(fixture_sql()["cr-20261114.sql"])
    return conn


class SqlTest(unittest.TestCase):
    conn: sqlite3.Connection

    @classmethod
    def setUpClass(cls) -> None:
        cls.conn = make_db()

    def one(self, sql: str, *params: object):
        return self.conn.execute(sql, params).fetchone()

    def test_worker_fixtures_are_this_output(self) -> None:
        for name, sql in fixture_sql().items():
            with self.subTest(name):
                if os.environ.get("UPDATE_FIXTURES"):
                    (FIXTURES / name).write_text(sql, encoding="utf-8")
                self.assertEqual(
                    (FIXTURES / name).read_text(encoding="utf-8"),
                    sql,
                    f"{name} is stale: rerun with UPDATE_FIXTURES=1, then pnpm test",
                )

    def test_views_serve_the_version(self) -> None:
        self.assertEqual(self.one("SELECT version FROM cr_version"), ("20261114",))
        for table in build_d1.TABLES:
            view = self.one(f"SELECT count(*) FROM cr_{table}")
            self.assertEqual(view, self.one(f"SELECT count(*) FROM cr_{table}_20261114"))
            self.assertGreater(view[0], 0)

    def test_stations_and_lookup(self) -> None:
        self.assertEqual(
            self.one("SELECT telecode, pinyin, trains FROM cr_stations WHERE name = '北京南'"),
            ("VNP", "beijingnan", 2),
        )
        # By name, pinyin, its initials and telegraph code, lower case
        for key in ("北京南", "beijingnan", "bjn", "vnp"):
            with self.subTest(key):
                self.assertEqual(
                    self.one("SELECT station FROM cr_lookup WHERE key = ? AND station = '北京南'", key),
                    ("北京南",),
                )
        self.assertEqual(
            dict(self.conn.execute("SELECT ref, station FROM cr_osm")),
            {"N1": "北京南", "W2": "北京南", "N3": "天津南"},
        )

    def test_a_train_number_holds_every_train_under_it(self) -> None:
        for half in ("Z1", "Z2"):
            (body,) = self.one("SELECT body FROM cr_trains WHERE code = ?", half)
            self.assertIn("Z1/Z2", body)
        (body,) = self.one("SELECT body FROM cr_trains WHERE code = '4651'")
        self.assertIn("4651/4654B", body)
        json.loads(body)
        self.assertIsNone(self.one("SELECT body FROM cr_trains WHERE code = 'G2'"))

    def test_timetable_rows_are_json_in_parts(self) -> None:
        rows = self.conn.execute(
            "SELECT body FROM cr_timetables WHERE station = '天津南' ORDER BY part"
        ).fetchall()
        self.assertGreater(len(rows), 0)
        text = "".join(body for (body,) in rows)
        self.assertEqual(len(rows), 1)
        trains = json.loads(text)
        self.assertEqual(len(trains), 4)  # G1, Z1/Z2 and the two 4651/4654
        self.assertIn("Z2", text)

    def test_new_version_replaces_old(self) -> None:
        conn = make_db()
        conn.executescript(fixture_sql()["cr-20261120.sql"])
        self.assertEqual(conn.execute("SELECT version FROM cr_version").fetchone(), ("20261120",))
        self.assertEqual([c for (c,) in conn.execute("SELECT code FROM cr_trains")], ["G7"])
        cur = conn.execute(build_d1.OLD_TABLES_SQL)
        listing = [{"results": [{"name": name} for (name,) in cur]}]
        drop = build_d1.drop_old("20261120", listing)
        self.assertEqual(
            sorted(drop.rstrip(";").split(";")),
            sorted(f"DROP TABLE cr_{t}_20261114" for t in build_d1.TABLES),
        )
        conn.executescript(drop)
        self.assertEqual(conn.execute("SELECT count(*) FROM cr_stations").fetchone(), (4,))


def train(code: str, stations: list[tuple[str, int]], spans: list, stock: list | None = None):
    """A train tuple as build_d1.load gives it, for line_labels"""
    stops = [(name, 0, 0, km, "") for name, km in stations]
    return (code, 20260101, 20501231, 1, 1, stops, stock or [], spans, [])


# 北京西 → 石家庄 as lltskb has it on the conventional line, and on the high-speed one
SLOW_DOWN = [("西长铁路", [("北京西", 0), ("良乡", 31)]),
             ("京广线", [("良乡", 31), ("石家庄", 281)])]  # fmt: skip
FAST_DOWN = [("京西联络线", [("北京西", 0), ("杜家坎所", 17)]),
             ("京广高铁", [("杜家坎所", 17), ("石家庄", 281)])]  # fmt: skip
SLOW_UP = [("京广线", [("石家庄", 0), ("良乡", 250)]),
           ("西长铁路", [("良乡", 250), ("北京西", 281)])]  # fmt: skip
DOWN, UP = [("北京西", 0), ("石家庄", 281)], [("石家庄", 0), ("北京西", 281)]
CR200J = [(20250101, 20991231, "CR200J", False, "", "CR200J")]


class LabelTest(unittest.TestCase):
    def labels(self, *trains, at: str = "北京西", scopes: dict | None = None) -> list:
        """(arriving, leaving) labels at a station per train"""
        out = build_d1.line_labels(list(trains), scopes or {})
        return [
            next(lab for s, lab in zip(t[5], o) if s[0] == at) for t, o in zip(trains, out)
        ]

    def test_twin_only_on_its_stretch(self) -> None:
        # 京沪线 is 沪宁高速's twin only between 南京 and 上海
        scopes = {"京沪线": {"南京", "镇江", "常州", "无锡", "苏州", "上海"}}
        g28 = train("G28", [("北京南", 0), ("北京", 8)], [("京沪线", [("北京南", 0), ("北京", 8)])])
        self.assertEqual(self.labels(g28, at="北京", scopes=scopes), [("京沪", None)])
        g7001 = train("G7001", [("上海", 0), ("苏州", 84), ("南京", 301)],
                      [("京沪线", [("上海", 0), ("苏州", 84), ("南京", 301)])])  # fmt: skip
        self.assertEqual(
            self.labels(g7001, at="苏州", scopes=scopes), [("沪宁城际", "沪宁城际")]
        )

    def test_class_picks_the_twin(self) -> None:
        # A G train is never on 京广线, a K train never on 京广高铁
        self.assertEqual(
            self.labels(train("G71", DOWN, SLOW_DOWN), train("K599", DOWN, FAST_DOWN)),
            [(None, "京广高速"), (None, "京广")],
        )

    def test_d_train_follows_its_return_by_stock(self) -> None:
        d1, d2 = train("D1", DOWN, FAST_DOWN), train("D2", UP, SLOW_UP)
        # D2 arrives where D1 leaves: on the high-speed line, unless it is CR200J
        self.assertEqual(self.labels(d1, d2), [(None, "京广高速"), ("京广高速", None)])
        d2 = train("D2", UP, SLOW_UP, CR200J)
        self.assertEqual(self.labels(d1, d2)[1], ("京广", None))
        # Agreeing pairs, and D trains without a return, keep lltskb's line
        c19, c20 = train("C19", DOWN, SLOW_DOWN), train("C20", UP, SLOW_UP)
        self.assertEqual(self.labels(c19, c20), [(None, "京广"), ("京广", None)])
        self.assertEqual(self.labels(train("D3", UP, SLOW_UP)), [("京广", None)])

    def test_hub_lines_lead_nowhere(self) -> None:
        # 50 km back from 太仓 is on 虹封线, inside the 上海 hub: G8354 comes in
        # by 沪苏通线, the line before it
        g8354 = train(
            "G8354",
            [("上海松江", 0), ("上海虹桥", 31), ("太仓", 89), ("南通西", 189)],
            [("沪苏湖高铁", [("上海松江", 0), ("上海虹桥", 31)]),
             ("虹封线", [("上海虹桥", 31), ("封浜", 45)]),
             ("黄南线", [("封浜", 45), ("黄渡", 52)]),
             ("沪苏通线", [("黄渡", 52), ("太仓", 89), ("南通西", 189)])],
        )  # fmt: skip
        self.assertEqual(self.labels(g8354, at="太仓"), [("沪苏通", "沪苏通")])
        self.assertEqual(self.labels(g8354, at="上海松江"), [(None, "沪苏湖高铁")])
        # From a stop where the hub begins, the line after it, not the line
        # the train came in by
        with mock.patch.object(build_d1, "LABEL_KM", 20):
            self.assertEqual(self.labels(g8354, at="上海虹桥"), [("沪苏湖高铁", "沪苏通")])

    def test_names(self) -> None:
        self.assertEqual(build_d1.display("沈山线"), "京哈")
        self.assertEqual(build_d1.display("京沪高速线"), "京沪高速")
        self.assertEqual(build_d1.display("宁蓉线"), "沪汉蓉")
        for connector in ["北京直通线", "余花联络线", "西北环线", "西长铁路", None]:
            self.assertIsNone(build_d1.display(connector))

    def test_stop_numbers(self) -> None:
        stops = [(n, 0, 0, km, "") for n, km in [("泰州", 0), ("东台", 94), ("徐州", 500),
                                                 ("山海关", 1629), ("哈尔滨西", 2556)]]  # fmt: skip
        self.assertEqual(
            build_d1.stop_numbers("Z156/Z157B", stops, [(0, 1), (94, 0), (1629, 1)]),
            [(None, "Z157"), ("Z157", "Z156"), ("Z156", "Z156"), ("Z156", "Z157"),
             ("Z157", None)],
        )  # fmt: skip
        # No record, or one naming a half the train lacks: the first number, as the app
        for records in [[], [(0, 0), (82, 51)]]:
            numbers = build_d1.stop_numbers("Y425/Y428", stops, records)
            self.assertEqual({n for pair in numbers for n in pair} - {None}, {"Y425"})


class BuildTest(unittest.TestCase):
    def test_numbers_in_a_stock_group(self) -> None:
        self.assertEqual(
            build_d1.numbers("K2153/2#K2154/1#0K1062#G1240/37#4172/3/4#D7915/D7918"),
            {"K2153", "K2152", "K2154", "K2151", "G1240", "G1237",
             "4172", "4173", "4174", "D7915", "D7918"},
        )  # fmt: skip

    def test_model(self) -> None:
        for text, model in [
            ("CRH380BG型重联", "CRH380BG"),
            ("25G型,DC600V,双管供风,集便", "25G"),
            ("DC600V,25G双管供风,集便", "25G"),
            ("CR200J3-C", "CR200J3-C"),
            ("庞巴迪BSP,25T型,AC380V,集便", "25T"),
            ("高峰线", None),
        ]:
            with self.subTest(text):
                m = build_d1.MODEL.search(text)
                self.assertEqual(m and m.group().upper(), model)

    def test_walk(self) -> None:
        lines = {
            # Listed against the direction of travel
            1: ("滨北线", [("哈尔滨", 0), ("呼兰", 30), ("绥化", 125)]),
            2: ("京哈线", [("北京", 0), ("沈阳北", 700), ("长春", 1000), ("长春", 1000),
                           ("哈尔滨", 1240)]),
            3: ("京哈线", [("沈阳北", 0), ("沈阳", 10)]),  # split under another code
        }  # fmt: skip
        # (station, arrival, dwell, km, platform); the line tables lack 兰西, and
        # the timetable's km for 沈阳北 is 10 short of the lines' 665
        stops = [("绥化", 0, 0, 0, ""), ("兰西", 0, 0, 50, ""), ("长春", 0, 0, 365, ""),
                 ("沈阳北", 0, 0, 655, ""), ("沈阳", 0, 0, 665, "")]  # fmt: skip
        route = ("沈阳", [("绥化", 1), ("哈尔滨", 2), ("沈阳北", 3)])
        self.assertEqual(
            build_d1.walk(route, lines, stops),
            [("滨北线", [("绥化", 0), ("兰西", 50), ("呼兰", 95), ("哈尔滨", 125)]),
             ("京哈线", [("哈尔滨", 125), ("长春", 365), ("沈阳北", 655), ("沈阳", 665)])],
        )  # fmt: skip
        # Stale routes: one that stops short of the terminus, one from elsewhere
        self.assertEqual(build_d1.walk(("沈阳北", route[1][:2]), lines, stops), [])
        self.assertEqual(build_d1.walk(route, lines, [("呼兰", 0, 0, 0, "")] + stops), [])
        self.assertEqual(build_d1.walk(None, lines, stops), [])


if __name__ == "__main__":
    unittest.main()
