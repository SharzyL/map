"""The SQL that loads one data version of railway relations into D1 (build_relations.py),
kept apart so tests can load rows without the builder's dependencies.

Usage, once a version is imported (standard library only):
    python3 relations_sql.py --list-old      # SQL listing every version's tables
    python3 relations_sql.py --drop-old <version> < wrangler-json-of-that-listing

Each relation's JSON is split into parts under D1's statement limit, in a table named by the
data version (osm_relations_202611121800 ...); the file ends by pointing the osm_relations and
osm_version views at it, so a failed import leaves the previous version serving.
"""

import json
import re
import sys

TABLE_COLUMNS = "id TEXT, part INTEGER, body TEXT, PRIMARY KEY (id, part)"
OLD_TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'osm_relations_[0-9]*'"
MAX_STATEMENT = 90_000  # D1 rejects statements over 100 KB
BODY_PART = 40_000  # bytes of JSON per row


def value(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def table_suffix(version):
    """2026-11-12T18:00:00Z -> 202611121800"""
    digits = re.sub(r"\D", "", version)
    if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", version):
        sys.exit(f"bad data version {version!r}")
    return digits[:12]


def parts(text, size=BODY_PART):
    """text in pieces of at most `size` bytes of UTF-8, not splitting a character"""
    data = text.encode()
    out = []
    start = 0
    while start < len(data):
        end = min(start + size, len(data))
        while end < len(data) and data[end] & 0xC0 == 0x80:  # inside a character
            end -= 1
        out.append(data[start:end].decode())
        start = end
    return out


def write_sql(out, version, rows):
    """rows: (id, body) -> one data version's table, then the views switched to it"""
    table = f"osm_relations_{table_suffix(version)}"
    out.write(
        f"DROP TABLE IF EXISTS {table};\nCREATE TABLE {table} ({TABLE_COLUMNS}) WITHOUT ROWID;\n"
    )
    head = f"INSERT INTO {table} VALUES "
    batch, size = [], len(head)
    stats = {"rows": 0, "parts": 0, "bytes": 0, "largest": (0, None)}
    for rid, body in rows:
        text = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        stats["rows"] += 1
        stats["bytes"] += len(text.encode())
        stats["largest"] = max(stats["largest"], (len(text.encode()), rid))
        for i, part in enumerate(parts(text)):
            v = "(" + ",".join(value(x) for x in (rid, i, part)) + ")"
            n = len(v.encode()) + 1
            if len(head) + n > MAX_STATEMENT:
                sys.exit(
                    f"relation {rid} part {i} is {n} bytes, over the statement limit"
                )
            if batch and size + n > MAX_STATEMENT:
                out.write(head + ",".join(batch) + ";\n")
                batch, size = [], len(head)
            batch.append(v)
            size += n
            stats["parts"] += 1
    if batch:
        out.write(head + ",".join(batch) + ";\n")
    # Last, so a partial import never switches the views
    out.write(
        f"DROP VIEW IF EXISTS osm_relations;\nCREATE VIEW osm_relations AS SELECT * FROM {table};\n"
        f"DROP VIEW IF EXISTS osm_version;\nCREATE VIEW osm_version AS SELECT {value(version)} AS version;\n"
    )
    return stats


def drop_old(version, listing):
    """wrangler `d1 execute --json` output of OLD_TABLES_SQL -> DROP statements"""
    names = [r["name"] for r in listing[0]["results"]]
    return "".join(
        f"DROP TABLE {n};" for n in names if not n.endswith(f"_{table_suffix(version)}")
    )


def main():
    if sys.argv[1:] == ["--list-old"]:
        print(OLD_TABLES_SQL)
    elif len(sys.argv) == 3 and sys.argv[1] == "--drop-old":
        print(drop_old(sys.argv[2], json.load(sys.stdin)))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
