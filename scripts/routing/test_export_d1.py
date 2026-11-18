"""Tests of export_d1.py: route data goes through its SQL into sqlite3,
standing in for D1.

The China routes here are what the Worker's tests load
(src/worker/api/fixtures/cr-routes-20261114.sql, with cr-routes-long.txt the
long partial): when this output changes, the fixture is regenerated here and
the Worker's tests show what that means for the API.

Run: python3 -m unittest discover -s scripts -p "test_*.py"
"""

import base64
import contextlib
import gzip
import json
import os
import random
import sqlite3
import string
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parents[1] / "src" / "worker" / "api" / "fixtures"
sys.path.insert(0, str(HERE))

import export_d1  # noqa: E402

EXTRACT = "2026-11-12T16:00:00Z"


def route(ways: list[int], partial: list[str] | None = None) -> dict:
    return {
        "bbox": [116.3, 39.0, 121.3, 39.9],
        "ways": ways,
        "partial": partial or [],
        "overview": [],
        "stops": [],
        "legs": [],
    }


# Routes as cr_route.py --routes writes them. A long one is stored in parts
LONG = ["".join(random.Random(1).choices(string.ascii_letters, k=120_000))]
ROUTES = {"G1": route([1, 2]), "4651/4654": route([3]), "Z1/Z2": route([4], LONG)}
POSITIONS = [("北京南", "N1;W2", 39.865, 116.379), ("天津南", "N3", 39.06, 117.06)]


def cr_sql(version: str = "20261114", extract: str = EXTRACT) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        routes, positions = Path(tmp, "routes.jsonl.gz"), Path(tmp, "positions.csv")
        with gzip.open(routes, "wt", encoding="utf-8") as f:
            for run, body in ROUTES.items():
                f.write(json.dumps({"run": run, "route": body}) + "\n")
        positions.write_text(
            "station,elements,lat,lon\n"
            + "".join(f"{n},{e},{la},{lo}\n" for n, e, la, lo in POSITIONS),
            encoding="utf-8",
        )
        return export_d1.cr_sql(str(routes), str(positions), version, extract)


def load(*scripts: str) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for sql in scripts:
        conn.executescript(sql)
    return conn


def stored(sql: str) -> tuple[dict, list]:
    """What the SQL serves: each run's route, and the stations"""
    with contextlib.closing(load(sql)) as conn:
        bodies: dict[str, str] = {}
        for run, body in conn.execute("SELECT run, body FROM route_cr_runs ORDER BY run, part"):
            bodies[run] = bodies.get(run, "") + body
        runs = {run: json.loads(zlib.decompress(base64.b64decode(b))) for run, b in bodies.items()}
        return runs, conn.execute("SELECT * FROM route_cr_stations ORDER BY station").fetchall()


class ChinaTest(unittest.TestCase):
    def test_routes_come_back_whole(self) -> None:
        sql = cr_sql()
        runs, stations = stored(sql)
        self.assertEqual(runs, {run: {**body, "data_version": EXTRACT} for run, body in ROUTES.items()})
        self.assertEqual(
            stations,
            [("北京南", '["N1", "W2"]', 116.379, 39.865), ("天津南", '["N3"]', 117.06, 39.06)],
        )
        with contextlib.closing(load(sql)) as conn:
            parts = dict(conn.execute("SELECT run, count(*) FROM route_cr_runs GROUP BY run"))
            self.assertEqual(parts["G1"], 1)
            self.assertGreater(parts["Z1/Z2"], 1)
            for (size,) in conn.execute("SELECT length(body) FROM route_cr_runs"):
                self.assertLessEqual(size, export_d1.PART)

    def test_worker_fixture_is_this_output(self) -> None:
        # Compared as what it serves: the compressed bytes depend on the zlib at hand
        name = "cr-routes-20261114.sql"
        if os.environ.get("UPDATE_FIXTURES"):
            (FIXTURES / name).write_text(cr_sql(), encoding="utf-8")
            (FIXTURES / "cr-routes-long.txt").write_text(LONG[0], encoding="utf-8")
        hint = "is stale: rerun with UPDATE_FIXTURES=1, then pnpm test"
        self.assertEqual(stored((FIXTURES / name).read_text(encoding="utf-8")), stored(cr_sql()), f"{name} {hint}")
        self.assertEqual((FIXTURES / "cr-routes-long.txt").read_text(encoding="utf-8"), LONG[0], hint)


class JapanTest(unittest.TestCase):
    def test_store_tables_come_back(self) -> None:
        tables = {
            "stations": [("1", 35.0, 139.0, '["N1"]')],
            "routes": [(10, "JRテスト線 普通", 0, 0, 2, None), (-1, "it's a rule", 0, 0, 2, "特急")],
            "route_stops": [("1", 10, 0), ("2", 10, 1)],
            "hops": [(10, 0, "1", "2", 1000, "[101]", "[]", "_p~iF~ps|U", "[139.0,35.0]", "[139.011,35.0]", 0.0)],
        }
        with tempfile.TemporaryDirectory() as tmp:
            with contextlib.closing(sqlite3.connect(Path(tmp, "paths.sqlite"))) as store:
                for t, cols in export_d1.JP_TABLES.items():
                    store.executescript("\n".join(export_d1.table_sql(f"jp_{t}", cols, tables[t])))
                store.commit()
            sql = export_d1.jp_sql(str(Path(tmp, "paths.sqlite")), EXTRACT)
        with contextlib.closing(load(sql)) as conn:
            self.assertEqual(conn.execute("SELECT version FROM jp_version").fetchone(), (EXTRACT,))
            for t in export_d1.JP_TABLES:
                with self.subTest(t):
                    rows = conn.execute(f"SELECT * FROM jp_{t}").fetchall()
                    self.assertEqual(rows, conn.execute(f"SELECT * FROM jp_{t}_20261112160000").fetchall())
                    self.assertEqual(sorted(rows, key=repr), sorted(tables[t], key=repr))


class VersionsTest(unittest.TestCase):
    def test_drop_old_keeps_the_served_versions(self) -> None:
        conn = load(
            cr_sql("20261114"),
            cr_sql("20261120", "2026-11-17T13:00:00Z"),
            "CREATE TABLE jp_hops_20261112160000 (x); CREATE TABLE jp_hops_20261117130000 (x);",
            # Timetable tables are not its to drop
            "CREATE TABLE cr_trains_20261114 (x);",
        )
        with contextlib.closing(conn):
            runs = conn.execute("SELECT count(DISTINCT run) FROM route_cr_runs").fetchone()
            self.assertEqual(runs, (len(ROUTES),))
            listing = [{"results": [{"name": name} for (name,) in conn.execute(export_d1.OLD_TABLES_SQL)]}]
        drop = export_d1.drop_old("20261120", "2026-11-17T13:00:00Z", listing)
        self.assertEqual(
            sorted(drop.rstrip(";").split(";")),
            [
                "DROP TABLE jp_hops_20261112160000",
                "DROP TABLE route_cr_runs_20261114",
                "DROP TABLE route_cr_stations_20261114",
            ],
        )

    def test_bad_versions_are_refused(self) -> None:
        with self.assertRaises(SystemExit):
            export_d1.compact("2026-11-12")
        with self.assertRaises(SystemExit):
            cr_sql("2026-11-14")


if __name__ == "__main__":
    unittest.main()
