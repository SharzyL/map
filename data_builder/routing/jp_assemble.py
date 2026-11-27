"""A Japanese train's route (public/api/v1/doc.md, …/trains/{id}/route) from
the stored hops of
jp_store.py, without the graph: what a request runs. The Worker runs its
port to TypeScript (src/worker/api/jp-assemble.ts, to be kept the same);
jp_store.py's check runs this.

The functions ask for data by yielding queries, (sql, params), and get rows
back as dicts, read from sqlite3 here (run_sqlite). The tables are
jp_store.py's; D1 serves them as views of the imported version
(export_d1.py).
"""

from __future__ import annotations

import itertools
import json
import re
import unicodedata
from collections.abc import Generator
from typing import Any

from geo import decode_polyline, encode_polyline, metres

Query = tuple[str, list[Any]]
Rows = list[dict[str, Any]]

LEG_DETOUR_RATIO, LEG_DETOUR_SLACK_M = 2.0, 2000
CANDIDATES = 8  # routes tried per leg
# A route made from a rule for the train, before type, name and direction
RULE_SCORE = 8
# A line relation's route (jp_store.py): only where no service route will do
LINE_SCORE = -100
# D1 binds at most 100 parameters per query
MAX_PARAMS = 90


def core(name: str) -> str:
    """Line or service name without operator, kind and direction words."""
    n = unicodedata.normalize("NFKC", name)
    n = re.sub(r"[(（].*?[)）]", "", n)
    n = re.sub(r"^JR|^東京メトロ|^都営地下鉄|^都営", "", n)
    n = re.sub(
        r"特急|急行|快速|各駅停車|普通|外回り|内回り|本線|線|ライン|列車|\d+号|\s",
        "",
        n,
    )
    return n


def is_shinkansen(text: str) -> bool:
    return "新幹線" in text


def _chunks(items: list, size: int):
    for k in range(0, len(items), size):
        yield items[k : k + size]


def _rows_in(sql: str, values: list) -> Generator[Query, Rows, Rows]:
    """Rows of `sql` (with {marks} for an IN list) over all values, in chunks."""
    out: Rows = []
    for chunk in _chunks(values, MAX_PARAMS):
        out += yield (sql.format(marks=",".join("?" * len(chunk))), chunk)
    return out


def _hop_seqs(sa: int, sb: int, n: int, loop: bool) -> list[tuple[int, bool]]:
    """Hops from stop sa to stop sb on a route of n stops: (seq, reversed)."""
    forward = (
        list(range(sa, sb))
        if sa < sb
        else (list(range(sa, n)) + list(range(sb)) if loop else None)
    )
    backward = (
        list(range(sa - 1, sb - 1, -1))
        if sb < sa
        else (
            list(range(sa - 1, -1, -1)) + list(range(n - 1, sb - 1, -1))
            if loop
            else None
        )
    )
    options = [[(s, False) for s in forward]] if forward is not None else []
    options += [[(s, True) for s in backward]] if backward is not None else []
    return min(options, key=len)


def assemble(train: dict) -> Generator[Query, Rows, tuple[list[dict], dict, dict]]:
    """Legs of one train: [{from, to, method, length_m, ways, partial, route,
    line, start, end}], with the stations ({code: row}) and the routes used
    ({id: name}). The train is the API's: stops (code, name), name, and the
    line of the timetable it was opened from."""
    codes = [s["code"] for s in train["stops"]]
    unique = sorted({c for c in codes if c})
    line_name = train.get("timetable_line") or train.get("line") or ""
    at: dict[str, dict[int, int]] = {}
    rows = yield from _rows_in(
        "SELECT code, route_id, seq FROM jp_route_stops WHERE code IN ({marks})",
        unique,
    )
    for r in rows:
        at.setdefault(r["code"], {})[r["route_id"]] = r["seq"]
    rows = yield from _rows_in(
        "SELECT code, lat, lon, elements FROM jp_stations WHERE code IN ({marks})",
        unique,
    )
    stations = {r["code"]: r for r in rows}
    commons = [
        set(at.get(a, {})) & set(at.get(b, {})) for a, b in itertools.pairwise(codes)
    ]
    rows = yield from _rows_in(
        # Every column: `line` is new, and a store imported before it has none
        "SELECT * FROM jp_routes WHERE id IN ({marks})",
        sorted(set().union(*commons)),
    )
    routes = {r["id"]: r for r in rows}
    shinkansen = is_shinkansen(f"{train['name']} {line_name}")
    wanted = {core(line_name), core(train["name"])} - {""}
    text = f"{train.get('kind', '')} {train['name']}"

    def named(r: int) -> bool:
        c = core(routes[r]["name"])
        return bool(c) and any(w in c or c in w for w in wanted)

    def ruled(r: int) -> bool:
        """A route made from a rule for this train"""
        pattern = routes[r]["train"]
        return bool(pattern) and re.search(pattern, text) is not None

    def line(r: int) -> bool:
        """A line relation's route, for legs no service route covers"""
        return bool(routes[r].get("line"))

    def seqs_of(r: int, a: str, b: str) -> list[tuple[int, bool]]:
        return _hop_seqs(
            at[a][r], at[b][r], routes[r]["stops"], bool(routes[r]["loop"])
        )

    # Candidate routes per leg, best first (previous-leg continuity is applied
    # when picking, below)
    cands = []
    for (a, b), common in zip(itertools.pairwise(codes), commons, strict=True):
        ranked = sorted(
            (r for r in common if r in routes),
            key=lambda r, a=a, b=b: (
                -(
                    RULE_SCORE * ruled(r)
                    + LINE_SCORE * line(r)
                    + 4 * (bool(routes[r]["shinkansen"]) == shinkansen)
                    + 2 * named(r)
                    + (at[a][r] < at[b][r])
                )
            ),
        )
        cands.append(ranked[:CANDIDATES])

    need = sorted(
        {
            (r, s)
            for (a, b), rs in zip(itertools.pairwise(codes), cands, strict=True)
            for r in rs
            for s, _ in seqs_of(r, a, b)
        }
    )
    hop_data = {}
    for chunk in _chunks(need, MAX_PARAMS // 2):
        clause = " OR ".join("(route_id = ? AND seq = ?)" for _ in chunk)
        sql = (
            "SELECT route_id, seq, length_m, ways, partial, line, start, end,"
            f" highspeed FROM jp_hops WHERE {clause}"
        )
        rows = yield (sql, [x for pair in chunk for x in pair])
        for r in rows:
            hop_data[(r["route_id"], r["seq"])] = (
                r["length_m"],
                json.loads(r["ways"]),
                json.loads(r["partial"]),
                r["line"],
                json.loads(r["start"]),
                json.loads(r["end"]),
                r["highspeed"],
            )

    legs, prev = [], None
    for k, ((a, b), rs) in enumerate(
        zip(itertools.pairwise(codes), cands, strict=True)
    ):
        leg = {
            "from": k,
            "to": k + 1,
            "method": "straight",
            "length_m": 0,
            "ways": [],
            "partial": [],
            "route": None,
            "line": [],  # overview points, (lat, lon)
            "start": None,  # [lon, lat] on the track
            "end": None,
        }
        sa, sb = stations.get(a), stations.get(b)
        straight = (
            metres(sa["lat"], sa["lon"], sb["lat"], sb["lon"]) if sa and sb else None
        )
        # Score each candidate on the hops it would use: a route mapped over
        # both conventional and 新幹線 track (かもめ: リレー and 西九州新幹線)
        # is 新幹線 only where its hops are
        options = []
        for r in rs:
            seqs = seqs_of(r, a, b)
            parts = [hop_data.get((r, s)) for s, _ in seqs]
            if not all(parts):
                continue
            length = sum(p[0] for p in parts)
            # Tighter than for a whole path: a leg between consecutive stops
            # that runs twice the straight distance overshoots a stop listed
            # out of order and comes back
            if (
                straight is not None
                and length > straight * LEG_DETOUR_RATIO + LEG_DETOUR_SLACK_M
            ):
                continue
            hs_share = sum(p[0] * p[6] for p in parts) / length if length else 0.0
            # Only 新幹線 trains run on 新幹線 track (they also run on
            # conventional lines: こまち, つばさ); a conventional train is better
            # drawn straight than on the 山陽新幹線 because only こだま stops at
            # both 姫路 and 岡山. A few metres of it at a station are no sign
            if not shinkansen and hs_share >= 0.5 and hs_share * length >= 1000:
                continue
            score = (
                RULE_SCORE * ruled(r)
                + LINE_SCORE * line(r)
                + 4 * ((hs_share >= 0.5) == shinkansen)
                + 2 * named(r)
                + (at[a][r] < at[b][r])
                + (r == prev)
            )
            options.append((-score, length, r, seqs, parts))
        if options:
            _, length, r, seqs, parts = min(options, key=lambda o: (o[0], o[1]))
            leg.update(method="line", length_m=length, route=r)
            for p, (_, back) in zip(parts, seqs, strict=True):
                leg["ways"].extend(p[1][::-1] if back else p[1])
                leg["partial"].extend(p[2])
                pts = decode_polyline(p[3]) if p[3] else []
                leg["line"].extend(pts[::-1] if back else pts)
            first, last = (parts[0], parts[-1])
            leg["start"] = first[5] if seqs[0][1] else first[4]
            leg["end"] = last[4] if seqs[-1][1] else last[5]
            prev = r
        legs.append(leg)
    return legs, stations, {r: row["name"] for r, row in routes.items()}


def route(train: dict, version: str | None = None) -> Generator[Query, Rows, dict]:
    """The API's route of one train; the data version is read from
    jp_version unless given."""
    if version is None:
        rows = yield ("SELECT version FROM jp_version", [])
        version = rows[0]["version"] if rows else None
    legs, stations, route_names = yield from assemble(train)
    names = [s["name"] for s in train["stops"]]
    codes = [s["code"] for s in train["stops"]]
    ways, seen, partial, pieces = [], set(), [], []
    for x in legs:
        for w in x["ways"]:
            if w not in seen:
                seen.add(w)
                ways.append(w)
        partial.extend(x["partial"])
        if x["method"] == "straight" or not x["line"]:
            pieces.append([])
        elif pieces and pieces[-1]:
            pieces[-1].extend(
                x["line"][1:] if pieces[-1][-1] == x["line"][0] else x["line"]
            )
        else:
            pieces.append(list(x["line"]))
    pieces = [p for p in pieces if len(p) >= 2]
    pts = [p for piece in pieces for p in piece]
    stops = []
    for k, (n, c) in enumerate(zip(names, codes, strict=True)):
        # Where the route meets the stop: the start of its leg out, else the
        # end of its leg in, else the station
        on_track = (legs[k]["start"] if k < len(legs) else None) or (
            legs[k - 1]["end"] if k else None
        )
        st = stations.get(c)
        stops.append(
            {
                "name": n,
                "position": on_track or ([st["lon"], st["lat"]] if st else None),
                "elements": json.loads(st["elements"]) if st else [],
            }
        )
    out_legs = []
    for x in legs:
        leg = {
            "from": names[x["from"]],
            "to": names[x["to"]],
            "line": route_names.get(x["route"]),
            "method": x["method"],
        }
        if x["method"] == "straight":
            ends = [stations.get(codes[x["from"]]), stations.get(codes[x["to"]])]
            if all(ends):
                leg["straight"] = encode_polyline([(e["lat"], e["lon"]) for e in ends])
        out_legs.append(leg)
    return {
        "data_version": version,
        "bbox": [
            min(p[1] for p in pts),
            min(p[0] for p in pts),
            max(p[1] for p in pts),
            max(p[0] for p in pts),
        ]
        if pts
        else None,
        "ways": ways,
        "partial": partial,
        "overview": [encode_polyline(p) for p in pieces],
        "stops": stops,
        "legs": out_legs,
    }


def run_sqlite(gen: Generator[Query, Rows, Any], conn) -> Any:
    """Step a query generator against a sqlite3 connection."""
    try:
        query = gen.send(None)
        while True:
            cur = conn.execute(*query)
            cols = [d[0] for d in cur.description]
            query = gen.send([dict(zip(cols, row, strict=True)) for row in cur])
    except StopIteration as stop:
        return stop.value
