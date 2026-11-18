"""Tests of relations_sql.py: relations go through its SQL into sqlite3,
standing in for D1, and come back as the API reads them
(src/worker/api/relations.ts): a relation's rows joined in order of part.

Run: python3 -m unittest discover -s scripts -p "test_*.py"
"""

import contextlib
import io
import json
import sqlite3
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import relations_sql  # noqa: E402

VERSION = "2026-11-12T18:00:00Z"

YAMANOTE = {
    "relation": {
        "id": 1972920,
        "kind": "route",
        "type": "train",
        "name": "JR山手線",
        "ref": "JY",
        "from": "大崎",
        "to": "大崎",
        "operator": "東日本旅客鉄道",
        "network": "JR",
        "colour": "#B1CB39",
        "master": 1972959,
        "wikidata": "Q842716",
        "wikipedia": "ja:山手線",
    },
    "bbox": [139.6965, 35.6197, 139.7774, 35.7381],
    "length_m": 34500,
    "overview": ["_p~iF~ps|U"],
    "ways": [23816541, 23816542],
    "stops": [
        {
            "name": "大崎",
            "position": [139.7285, 35.6197],
            "elements": ["N241896099"],
            "km": None,
        }
    ],
}
# Long enough to take several rows, with names of several bytes in UTF-8
TOKAIDO = {
    "relation": {"id": 5, "kind": "line", "type": "railway", "name": "東海道本線"},
    "ways": list(range(10_000_000, 10_020_000)),
    "stops": [
        {
            "name": "東海道本線の駅" * 3000,
            "position": [0, 0],
            "elements": [],
            "km": None,
        }
    ],
}
SANIN = {
    "relation": {
        "id": "jp-15e84d7cdd",
        "kind": "line",
        "type": "railway",
        "name": "山陰本線",
        "operator": "西日本旅客鉄道",
        "aliases": [],
    },
    "ways": [1],
    "stops": [],
}


def make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    sql = io.StringIO()
    rows = [("1972920", YAMANOTE), ("5", TOKAIDO), ("jp-15e84d7cdd", SANIN)]
    relations_sql.write_sql(sql, VERSION, rows)
    conn.executescript(sql.getvalue())
    return conn


def relation(conn: sqlite3.Connection, relation_id: str) -> Any:
    """The relation as stored, or None"""
    rows = conn.execute("SELECT body FROM osm_relations WHERE id = ? ORDER BY part", (relation_id,))
    text = "".join(body for (body,) in rows)
    return json.loads(text) if text else None


class RelationsSqlTest(unittest.TestCase):
    conn: sqlite3.Connection

    @classmethod
    def setUpClass(cls) -> None:
        cls.conn = make_db()
        cls.addClassCleanup(cls.conn.close)

    def test_relations_come_back(self) -> None:
        self.assertEqual(relation(self.conn, "1972920"), YAMANOTE)
        self.assertEqual(relation(self.conn, "jp-15e84d7cdd"), SANIN)
        self.assertIsNone(relation(self.conn, "42"))
        self.assertEqual(self.conn.execute("SELECT version FROM osm_version").fetchone(), (VERSION,))

    def test_relation_in_several_rows(self) -> None:
        parts = self.conn.execute("SELECT count(*) FROM osm_relations WHERE id = '5'")
        self.assertGreater(parts.fetchone()[0], 1)
        self.assertEqual(relation(self.conn, "5"), TOKAIDO)
        for (size,) in self.conn.execute("SELECT length(CAST(body AS BLOB)) FROM osm_relations"):
            self.assertLessEqual(size, relations_sql.BODY_PART)

    def test_parts_keep_characters_whole(self) -> None:
        text = "東海道" * 20 + "x"
        parts = relations_sql.parts(text, 10)
        self.assertEqual("".join(parts), text)
        self.assertTrue(all(len(p.encode()) <= 10 for p in parts))

    def test_new_version_replaces_old(self) -> None:
        with contextlib.closing(make_db()) as conn:
            sql = io.StringIO()
            relations_sql.write_sql(sql, "2026-11-19T18:00:00Z", [("5", TOKAIDO)])
            conn.executescript(sql.getvalue())
            self.assertIsNone(relation(conn, "1972920"))
            self.assertEqual(relation(conn, "5"), TOKAIDO)
            self.assertEqual(
                conn.execute("SELECT version FROM osm_version").fetchone(), ("2026-11-19T18:00:00Z",)
            )
            listing = [{"results": [{"name": name} for (name,) in conn.execute(relations_sql.OLD_TABLES_SQL)]}]
        self.assertEqual(
            relations_sql.drop_old("2026-11-19T18:00:00Z", listing),
            "DROP TABLE osm_relations_202611121800;",
        )

    def test_bad_version_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            relations_sql.write_sql(io.StringIO(), "20261112", [])


if __name__ == "__main__":
    unittest.main()
