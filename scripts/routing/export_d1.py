"""SQL that loads route data into the worker's D1 database (cr), for the
train route endpoints (public/api/v1/doc.md).

Usage:
    export_d1.py cr <cr-routes.jsonl.gz> <cr-station-positions.csv>
                    <timetable version> <extract time> <out.sql>
    export_d1.py jp <paths.sqlite> <extract time> <out.sql>
    export_d1.py --list-old
    export_d1.py --drop-old <timetable version> <extract time> < wrangler-json

China routes are per run of a timetable version, from cr_route.py --routes:
route_cr_runs_<version> holds each run's response (zlib-compressed and
base64-encoded, in parts under D1's statement limit), route_cr_stations_<version>
each station's OSM elements and position for the stops of /api/v1/cr/trains.
Japan's are jp_store.py's tables as of an extract, jp_*_<YYYYMMDDHHMMSS>.
Each file ends by pointing the views (route_cr_runs, jp_hops, ...) at its
tables, so a failed import leaves the previous version serving.

The names stay clear of cr_*_<digits>, which importing a new timetable
drops (scripts/lltskb/build_d1.py --drop-old): routes keep serving the runs
of the timetable they were built for until they are rebuilt.
"""

from __future__ import annotations

import base64
import csv
import gzip
import json
import re
import sqlite3
import sys
import zlib
from collections.abc import Iterable

MAX_STATEMENT = 90_000  # D1 rejects statements over 100 KB
PART = 60_000  # characters of encoded route per row
OLD_TABLES_SQL = (
    "SELECT name FROM sqlite_master WHERE type = 'table'"
    " AND (name GLOB 'route_cr_*_[0-9]*' OR name GLOB 'jp_*_[0-9]*')"
)
JP_TABLES = {
    "stations": "code TEXT PRIMARY KEY, lat REAL, lon REAL, elements TEXT",
    "routes": "id INTEGER PRIMARY KEY, name TEXT, shinkansen INTEGER,"
    " loop INTEGER, stops INTEGER, train TEXT",
    "route_stops": "code TEXT, route_id INTEGER, seq INTEGER,"
    " PRIMARY KEY (code, route_id, seq)",
    "hops": "route_id INTEGER, seq INTEGER, from_code TEXT, to_code TEXT,"
    " length_m INTEGER, ways TEXT, partial TEXT, line TEXT, start TEXT, end TEXT,"
    " highspeed REAL, PRIMARY KEY (route_id, seq)",
}


def value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def table_sql(name: str, cols: str, rows: Iterable[tuple]) -> list[str]:
    """DROP, CREATE and INSERTs in batches under MAX_STATEMENT."""
    out = [
        f"DROP TABLE IF EXISTS {name};",
        f"CREATE TABLE {name} ({cols}) WITHOUT ROWID;",
    ]
    head = f"INSERT INTO {name} VALUES "
    batch, size = [], len(head)
    for row in rows:
        v = "(" + ",".join(value(x) for x in row) + ")"
        n = len(v.encode()) + 1
        if len(head) + n > MAX_STATEMENT:
            sys.exit(f"{name} row {row[0]!r} is {n} bytes, over the statement limit")
        if batch and size + n > MAX_STATEMENT:
            out.append(head + ",".join(batch) + ";")
            batch, size = [], len(head)
        batch.append(v)
        size += n
    if batch:
        out.append(head + ",".join(batch) + ";")
    return out


def compact(extract: str) -> str:
    """2026-11-12T16:00:00Z -> 20261112160000"""
    digits = re.sub(r"\D", "", extract)
    if len(digits) != 14:
        sys.exit(f"bad extract time {extract!r}")
    return digits


def cr_sql(routes_gz: str, positions_csv: str, version: str, extract: str) -> str:
    if not version.isdigit():
        sys.exit(f"bad timetable version {version!r}")

    def runs():
        with gzip.open(routes_gz, "rt", encoding="utf-8") as f:
            for line in f:
                row = json.loads(line)
                route = {**row["route"], "data_version": extract}
                text = json.dumps(route, ensure_ascii=False, separators=(",", ":"))
                body = base64.b64encode(zlib.compress(text.encode(), 9)).decode()
                for k in range(0, len(body), PART):
                    yield row["run"], k // PART, body[k : k + PART]

    def stations():
        with open(positions_csv, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                elements = json.dumps(r["elements"].split(";") if r["elements"] else [])
                yield r["station"], elements, float(r["lon"]), float(r["lat"])

    out = table_sql(
        f"route_cr_runs_{version}",
        "run TEXT, part INTEGER, body TEXT, PRIMARY KEY (run, part)",
        runs(),
    )
    out += table_sql(
        f"route_cr_stations_{version}",
        "station TEXT PRIMARY KEY, elements TEXT, lon REAL, lat REAL",
        stations(),
    )
    # Last, so a partial import never switches the views
    for t in ("runs", "stations"):
        out += [
            f"DROP VIEW IF EXISTS route_cr_{t};",
            f"CREATE VIEW route_cr_{t} AS SELECT * FROM route_cr_{t}_{version};",
        ]
    return "\n".join(out) + "\n"


def jp_sql(store: str, extract: str) -> str:
    version = compact(extract)
    db = sqlite3.connect(store)
    out = []
    for t, cols in JP_TABLES.items():
        plain = re.sub(r",\s*PRIMARY KEY \(.*\)$", "", cols)
        names = [c.split()[0] for c in plain.split(",")]
        rows = db.execute(f"SELECT {', '.join(names)} FROM jp_{t}")
        out += table_sql(f"jp_{t}_{version}", cols, rows)
    db.close()
    for t in JP_TABLES:
        out += [
            f"DROP VIEW IF EXISTS jp_{t};",
            f"CREATE VIEW jp_{t} AS SELECT * FROM jp_{t}_{version};",
        ]
    out += [
        "DROP VIEW IF EXISTS jp_version;",
        f"CREATE VIEW jp_version AS SELECT {value(extract)} AS version;",
    ]
    return "\n".join(out) + "\n"


def drop_old(cr_version: str, extract: str, listing) -> str:
    """wrangler `d1 execute --json` output of OLD_TABLES_SQL -> DROP statements
    for the tables of other versions"""
    keep = (f"_{cr_version}", f"_{compact(extract)}")
    names = [r["name"] for r in listing[0]["results"]]
    return "".join(f"DROP TABLE {n};" for n in names if not n.endswith(keep))


def main() -> None:
    args = sys.argv[1:]
    if args == ["--list-old"]:
        print(OLD_TABLES_SQL)
    elif len(args) == 3 and args[0] == "--drop-old":
        print(drop_old(args[1], args[2], json.load(sys.stdin)))
    elif len(args) == 6 and args[0] == "cr":
        with open(args[5], "w", encoding="utf-8") as f:
            f.write(cr_sql(*args[1:5]))
    elif len(args) == 4 and args[0] == "jp":
        with open(args[3], "w", encoding="utf-8") as f:
            f.write(jp_sql(args[1], args[2]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
