#!/usr/bin/env python3
"""Build the SQL that loads one data version into D1 for the Worker's
/api/v1/cr endpoints (src/worker/api/cr.ts).

Usage:
    python3 build_d1.py <an dir> <cr-station-trains.csv> <out.sql>
    python3 build_d1.py --search <an dir> <search.json>
    python3 build_d1.py --list-old      # SQL listing every version's tables
    python3 build_d1.py --drop-old <version> < wrangler-json-of-that-listing

Rows are prefilled answers, so a request is one key lookup: a station's rows
hold every train that stops there (split into parts to stay under D1's
statement limit), a train number's row holds every train running under it
(Z156 is Z156/Z157 until a date, then Z156/Z157B). Each train keeps its running rule
and its dated rolling stock (jlb.dat); the worker picks the date. Its lines come
from routes.dat.

Tables carry the data version (cr_trains_20261114 ...) and the file ends by
pointing the cr_* views at them, so a failed import leaves the previous
version serving. --drop-old turns wrangler's listing of tables into DROPs for
every other version.

--search writes the index of train numbers /api/v1/search finds them by
(src/worker/api/search.ts), which the Worker bundles rather than reads from
D1: {"version": ..., "trains": [[train, origin, terminus, first day, last
day], ...] by number, "keys": [...], "owners": [...]}, the numbers a train is
found by (search_keys) in order, each with its train's index, so a prefix is
a bisection with nothing to compute first.
"""
import csv
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lulutong_parse import date4, i32, key, read_index  # noqa: E402

TABLES = {
    "stations": "name TEXT PRIMARY KEY, telecode TEXT, pinyin TEXT, trains INTEGER",
    "lookup": "key TEXT, station TEXT, PRIMARY KEY (key, station)",
    "osm": "ref TEXT PRIMARY KEY, station TEXT",
    "timetables": "station TEXT, part INTEGER, body TEXT, PRIMARY KEY (station, part)",
    "trains": "code TEXT PRIMARY KEY, body TEXT",
}
# Tables and views of earlier builds dropped with the views (the train search
# moved into the Worker's bundle)
GONE = ["search"]
OLD_TABLES_SQL = ("SELECT name FROM sqlite_master WHERE type = 'table' "
                  "AND name GLOB 'cr_*_[0-9]*'")
MAX_STATEMENT = 90_000  # D1 rejects statements over 100 KB
TIMETABLE_PART = 40_000  # bytes of JSON per timetable row
# A stop this much earlier than the previous departure is on the next day
NEXT_DAY_MIN = 600
# The model in jlb.dat's free text: 'CRH380BG型重联', '25G型,DC600V,集便', 'CR200J3-C'
MODEL = re.compile(r"CR[HJ]?\d{1,3}[A-Z]*\d*(?:-[A-Z0-9]+)*|CJ\d+|NDJ\d+|2[25][A-Z](?![A-Z0-9])",
                   re.I)

# ---- station timetable direction labels (line_labels) ----
# A train's line at a station is the one it is on this far away, so a short
# connector by the station (西长铁路, 31 km to 良乡) does not hide the direction
LABEL_KM = 50
# Conventional lines and the high-speed line beside them, which lltskb mixes
# up: a train and its return disagree on the stretch (D1 leaves 北京西 on
# 京广高铁, D2 is said to arrive on 京广线)
TWINS = {
    "京广线": "京广高铁",
    "胶济线": "胶济客专线",
    "京九线": "昌九城际线",
    "京沪线": "沪宁高速",
    "石太线": "石太客专线",
    "石太获太段": "石太客专线",
    "沈丹线": "沈丹客专线",
}
SLOW = {fast: slow for slow, fast in reversed(TWINS.items())}  # 石太客专线 -> 石太线
# Twins only beside each other on part of the conventional line: elsewhere
# (京沪线 at 北京) the conventional line is just itself
TWIN_STRETCH = {"京沪线": ("南京", "上海"), "京九线": ("九江", "南昌")}
# Classes that never run on high-speed lines; G always does
CONVENTIONAL_CLASS = re.compile(r"[KTZNVYLS]|\d")
# One line under several lltskb names
SAME_LINE = {"沈山线": "京哈线", "津山线": "京哈线", "集包线": "京包线", "唐包线": "京包线",
             "京包张包段": "京包线", "石太获太段": "石太线", "青藏线": "兰青线"}
# Display names where lltskb's is not the one passengers know; others lose a trailing 线
DISPLAY = {"京广高铁": "京广高速", "京哈京沈段": "京哈高速", "宁蓉线": "沪汉蓉",
           "京港赣深段": "京港高速", "京港商合段": "京港高速", "广深港广深": "广深港",
           "沪宁高速": "沪宁城际"}
# Lines that lead nowhere in particular: no label. 海南东环线 and 海南西环线
# are the island's lines, not a city's ring
NOT_A_DIRECTION = re.compile(r"联络|直通|(?<!海南东)(?<!海南西)环线|^(西长铁路|通乔线|滠武线)$")
# Lines inside a railway hub, which trains pass through between the lines they
# run on (G8354 leaves 上海虹桥 by 虹封线 and 黄南线 for 沪苏通线 to 太仓): as
# directions they too lead nowhere. So does a line between two junctions (所)
# with no station of its own (西环成雅线)
HUB_LINES = {"虹封线", "黄南线", "虹安线", "虹七线", "沪春线",  # 上海
             "天津西线", "郑州东北线", "济南线", "向潭线", "杏厦线", "南平北联线",
             "成渝渝贵线", "井西线"}  # fmt: skip


# ---------------- an/ -> plain data ----------------
def read_telecodes(an):
    """station name -> (telecode, pinyin, abbreviation); station_name.js first,
    then sn.dat's name-telecode list, which covers the rest but has no pinyin"""
    out = {}
    raw = open(os.path.join(an, "station_name.js"), encoding="utf-8").read()
    for rec in raw.split("'")[1].split("@"):
        p = rec.split("|")
        if len(p) > 4 and p[1] not in out:
            out[p[1]] = (p[2], p[3], p[4])
    b = open(os.path.join(an, "sn.dat"), "rb").read()
    n, o = struct.unpack(">H", b[:2])[0], 2
    for _ in range(n):  # search aliases
        o += 2 + struct.unpack(">H", b[o:o + 2])[0]
    n, o = struct.unpack(">H", b[o:o + 2])[0], o + 2
    for _ in range(n):  # same-city groups
        o += 3 + 2 * b[o + 2]
    n, o = struct.unpack(">H", b[o:o + 2])[0], o + 2
    for _ in range(n):
        name, _, tel = b[o + 1:o + 1 + b[o]].decode("utf-8", "replace").partition("-")
        out.setdefault(name, (tel, "", ""))
        o += 1 + b[o]
    return out


def read_platforms(an):
    """(train index, station index) -> platform / ticket gate"""
    b = open(os.path.join(an, "plat.dat"), "rb").read()
    out, o = {}, 4
    for _ in range(i32(b, 0)):
        out[(i32(b, o), i32(b, o + 4))] = b[o + 9:o + 9 + b[o + 8]].decode("utf-8", "replace")
        o += 9 + b[o + 8]
    return out


def string(b, o):
    """1-byte length + UTF-8 -> (text, next offset)"""
    return b[o + 1:o + 1 + b[o]].decode("utf-8", "replace"), o + 1 + b[o]


def read_train_ids(an):
    """sp.dat's 12306 train ids (24000000G10L), in t.i order"""
    b = open(os.path.join(an, "sp.dat"), "rb").read()
    o = 4 + 16 * i32(b, 0)  # temporary changes
    n, o = i32(b, o), o + 4
    out = []
    for _ in range(n):
        tid, o = string(b, o)
        out.append(tid)
    return out


def read_routes(an):
    """routes.dat -> ({line code: (name, [(station, km)])},
                      {12306 id: (terminus, [(station where the train joins a line, line code)])})"""
    b = open(os.path.join(an, "routes.dat"), "rb").read()
    lines, o = {}, 4
    for _ in range(i32(b, 0)):
        code = i32(b, o)
        name, o = string(b, o + 4)
        n, o = i32(b, o), o + 4
        stations = []
        for _ in range(n):
            st, o = string(b, o)
            _, o = string(b, o)  # telecode
            stations.append((st, i32(b, o + 4)))  # after the boundary flag
            o += 8
        lines[code] = (name, stations)
    out = {}
    n, o = i32(b, o), o + 4
    for _ in range(n):
        tid, o = string(b, o)
        end, o = string(b, o)
        segs = []
        m, o = i32(b, o), o + 4
        for _ in range(m):
            st, o = string(b, o)
            segs.append((st, i32(b, o)))
            o += 4
        out[tid] = (end, segs)
    return lines, out


def read_units(an):
    """extra.dat's first section: the railway units (bureaus, depots) named by index"""
    b = open(os.path.join(an, "extra.dat"), "rb").read()
    out, o = [], 2
    for _ in range(key(b, 0)):
        unit, o = string(b, o)
        out.append(unit)
    return out


def numbers(group):
    """jlb.dat's train group -> its train numbers: 'K2153/2#K2154/1' ->
    {K2153, K2152, K2154, K2151}. A short half replaces the end of the
    number; '0'-prefixed numbers (empty stock movements) are left out"""
    out = set()
    for tok in group.upper().split("#"):
        first, *rest = tok.split("/")
        m = re.fullmatch(r"([A-Z]*)(\d+)", first)
        if not m:
            continue
        prefix, n = m.groups()
        out.add(first)
        for half in rest:
            if re.fullmatch(r"[A-Z]+\d+", half):
                out.add(half)
            elif half.isdigit() and len(half) <= len(n):
                out.add(prefix + n[:len(n) - len(half)] + half)
    return out


def read_stock(an):
    """jlb.dat -> [(start, end, model, coupled, depot, text, train numbers)]: the
    rolling stock a group of trains runs with between two dates"""
    units = read_units(an)
    b = open(os.path.join(an, "jlb.dat"), "rb").read()
    out, o = [], 4
    for _ in range(i32(b, 0)):
        start, end, unit = i32(b, o), i32(b, o + 4), key(b, o + 16)
        text, o = string(b, o + 18)
        group, o = string(b, o)
        text = text.strip()
        m = MODEL.search(text)
        out.append((start, end, m.group().upper() if m else "", "重联" in text,
                    units[unit] if 0 < unit < len(units) else "",  # unit 0 is 暂无
                    text, numbers(group)))
    return out


def read_xw(an):
    """xw.dat -> {train index: [(km, half)]}: from the stop at km on, the train
    runs under that half of its double number (Z156/Z157: 0 → Z157, 94 → Z156)"""
    b = open(os.path.join(an, "xw.dat"), "rb").read()
    out, o = {}, 2
    for _ in range(key(b, 0)):
        n = b[o + 4]  # o + 2: two bytes of unknown meaning
        out[key(b, o)] = [(key(b, p), b[p + 2]) for p in range(o + 5, o + 5 + 3 * n, 3)]
        o += 5 + 3 * n
    return out


def stop_numbers(code, stops, records):
    """-> [(arriving number, leaving number)] per stop, read from xw.dat's
    records as lulutong's app reads them: at a stop where the number changes,
    the train arrives under the old one; no record, or a broken one, means the
    first number throughout"""
    halves = re.sub(r"(?<=\d)[A-Z]+$", "", code).split("/")
    if len(halves) == 1 or any(h >= len(halves) for _, h in records):
        records = []

    def at(km, before):
        half = 0
        for start, h in records:
            if start > km or (before and start == km):
                break
            half = h
        return halves[half]

    last = len(stops) - 1
    return [(at(s[3], True) if k else None, at(s[3], False) if k < last else None)
            for k, s in enumerate(stops)]


def walk(route, lines, stops):
    """A train's routes.dat segments walked along their lines -> [(line, [(station, km)])],
    every station it passes, a junction ending one line and starting the next.
    km is on the timetable's scale: each stop keeps its own km and the stations
    between two stops are spread by their distances on the lines. The line
    tables leave out minor stations, so stops missing from them go in by km.
    [] when the route does not run from the train's origin to its terminus."""
    if not route or not route[1]:
        return []
    end, segs = route
    pts = [[segs[0][0], 0, None]]  # station, km walked, line onward
    for (st, code), to in zip(segs, [s for s, _ in segs[1:]] + [end]):
        name, table = lines.get(code, ("", []))
        names = [n for n, _ in table]
        if st not in names or to not in names:
            return []
        a, b = names.index(st), names.index(to)
        part = table[a:b + 1] if a <= b else table[b:a + 1][::-1]
        walked = pts[-1][1]
        pts[-1][2] = name
        for n, k in part[1:]:
            if n != pts[-1][0]:  # a station listed twice in a row
                pts.append([n, walked + abs(k - part[0][1]), name])
        pts[-1][2] = None
    # Each stop's point on the walk, or None when the line tables lack it
    at, j = [], 0
    for st, *_ in stops:
        i = next((i for i in range(j, len(pts)) if pts[i][0] == st), None)
        at.append(i)
        j = j if i is None else i + 1
    if at[0] != 0 or at[-1] != len(pts) - 1:
        return []
    anchors = [(i, s[3]) for s, i in zip(stops, at) if i is not None]
    kms = [0] * len(pts)
    for (i0, k0), (i1, k1) in zip(anchors, anchors[1:]):
        w0, w1 = pts[i0][1], pts[i1][1]
        for i in range(i0, i1 + 1):
            kms[i] = k0 + round((pts[i][1] - w0) * (k1 - k0) / (w1 - w0)) if w1 > w0 else k0
    out, p = [], 0  # (station, km, line onward)
    for k, ((st, _, _, km, _), i) in enumerate(zip(stops, at)):
        if i is None:
            nxt = next(i for i in at[k:] if i is not None)
            while p < nxt and kms[p] <= km:
                out.append((pts[p][0], kms[p], pts[p][2]))
                p += 1
            out.append((st, km, out[-1][2]))
        else:
            out += [(pts[q][0], kms[q], pts[q][2]) for q in range(p, i + 1)]
            p = i + 1
    spans = []
    for st, km, line in out:
        if spans:
            spans[-1][1].append((st, km))
        if line is not None and (not spans or spans[-1][0] != line):
            spans.append((line, [(st, km)]))
    return spans


def in_hub(span):
    line, pts = span
    return (line in HUB_LINES or bool(NOT_A_DIRECTION.search(line))
            or all(st.endswith("所") for st, _ in pts))


def span_at(spans, km):
    """-> index of the span a walked route is on at route km; at a junction,
    the earlier one"""
    found = None
    for i, (_, pts) in enumerate(spans):
        if pts[0][1] <= km <= pts[-1][1]:
            if pts[0][1] < km:
                return i
            found = i if found is None else found
    if found is None:
        found = 0 if km < spans[0][1][0][1] else len(spans) - 1
    return found


def line_at(spans, km, stop):
    """-> (line, its station nearest) where a walked route is at route km, seen
    from a stop at route km `stop`. A line inside a hub (in_hub()) gives way to
    the one before it on the way from the stop, or for a stop inside the hub,
    to the one after it"""
    step = 1 if km < stop else -1  # toward the stop
    # The stop's span on this side, which at a junction is not the other side's
    i, j = span_at(spans, km), span_at(spans, stop - step / 2)
    toward = range(i, j + step, step)
    beyond = range(i - 1, -1, -1) if step > 0 else range(i + 1, len(spans))
    order = [*toward, *beyond]
    k = next((k for k in order if not in_hub(spans[k])), i)
    return spans[k][0], min(spans[k][1], key=lambda p: abs(p[1] - km))[0]


def raw_sides(stops, spans):
    """-> [((line, station) arriving, (line, station) leaving)] per stop,
    LABEL_KM out, as lltskb has them"""
    last = stops[-1][3]
    none = (None, None)
    return [(line_at(spans, max(s[3] - LABEL_KM, 0), s[3]) if k else none,
             line_at(spans, min(s[3] + LABEL_KM, last), s[3]) if k < len(stops) - 1 else none)
            for k, s in enumerate(stops)] if spans else [(none, none)] * len(stops)


def twin_scopes(lines):
    """{conventional line: its stations on TWIN_STRETCH} from routes.dat's line tables"""
    out = {}
    for name, table in lines.values():
        if name in TWIN_STRETCH:
            names = [n for n, _ in table]
            a, b = (names.index(s) for s in TWIN_STRETCH[name])
            out[name] = set(names[min(a, b):max(a, b) + 1])
    return out


def numbers_of(code):
    return [int(n) for n in re.findall(r"\d+", re.sub(r"(?<=\d)[A-Z]+$", "", code))]


def is_return(a, b):
    """b runs a's way back: each number one off (D1 / D2, Z156/Z157 / Z155/Z158)"""
    na, nb = numbers_of(a), numbers_of(b)
    return bool(na) and len(na) == len(nb) and all(any(abs(x - y) == 1 for y in nb) for x in na)


def corrected(line, near, code, model, return_line, scopes):
    """A twin line as the train class allows (TWINS); D and C trains, which run
    on either, are moved only when their return train has the other twin, to
    the conventional one for CR200J stock (160 km/h), else the high-speed one.
    `near` is the line's station nearest the label point, for TWIN_STRETCH"""
    if line in TWIN_STRETCH and near not in scopes.get(line, ()):
        return line
    if line in SLOW and CONVENTIONAL_CLASS.match(code):
        return SLOW[line]
    if line in TWINS and code.startswith("G"):
        return TWINS[line]
    fast = TWINS.get(line, line)
    if (code[:1] in ("D", "C") and fast in SLOW and return_line not in (None, line)
            and TWINS.get(return_line, return_line) == fast):
        return SLOW[fast] if model.startswith("CR200J") else fast
    return line


def display(line):
    if line is None or NOT_A_DIRECTION.search(line):
        return None
    line = SAME_LINE.get(line, line)
    return DISPLAY.get(line) or re.sub(r"线$", "", line)


def line_labels(trains, scopes):
    """-> per train, [(line arriving, line leaving)] per stop as display names:
    the line LABEL_KM out, with lltskb's twin mix-ups corrected (corrected());
    scopes is twin_scopes()"""
    sides = [raw_sides(t[5], t[7]) for t in trains]
    by_ends = {}
    for i, t in enumerate(trains):
        by_ends.setdefault((t[5][0][0], t[5][-1][0]), []).append(i)
    out = []
    for i, (code, start, end, period, mask, stops, stock, spans, *_) in enumerate(trains):
        model = max(stock)[2] if stock else ""
        back = next((j for j in by_ends.get((stops[-1][0], stops[0][0]), ())
                     if j != i and is_return(code, trains[j][0])), None)
        # At each station, the return arrives by the line this train leaves by
        mirror = {}
        if back is not None:
            for s, (b_in, b_out) in zip(trains[back][5], sides[back]):
                mirror.setdefault(s[0], (b_out[0], b_in[0]))
        labels = []
        for s, (a, b) in zip(stops, sides[i]):
            ret_a, ret_b = mirror.get(s[0], (None, None))
            labels.append((display(corrected(*a, code, model, ret_a, scopes)),
                           display(corrected(*b, code, model, ret_b, scopes))))
        out.append(labels)
    return out


def load(an):
    """-> (version, {station: (telecode, pinyin, abbr)},
           [(train, start, end, period, mask, [(station, arr_min, dwell, km, platform)],
             [(start, end, model, coupled, depot, text)], [(line, [(station, km)])],
             [(km, half)])], twin_scopes())"""
    version = open(os.path.join(an, "ver.txt")).read().strip()
    names = read_index(os.path.join(an, "s.i"))
    codes = read_index(os.path.join(an, "t.i"))
    tels = read_telecodes(an)
    plats = read_platforms(an)
    ids = read_train_ids(an)
    lines, routes = read_routes(an)
    stock = read_stock(an)
    xw = read_xw(an)
    by_number = {}
    for i, s in enumerate(stock):
        for n in s[-1]:
            by_number.setdefault(n, set()).add(i)
    rules = open(os.path.join(an, "t.rule")).read().split()
    rules = [(int(rules[i]), int(rules[i + 1])) for i in range(0, len(rules) - 1, 2)]
    trains = []
    for i in range(20):
        b = open(os.path.join(an, f"T{i}.dat"), "rb").read()
        o = 0
        while o + 17 <= len(b):
            ti, n = key(b, o), key(b, o + 15)
            rule = key(b, o + 13)
            period, mask = rules[rule] if rule < len(rules) else (1, 1)
            stops = []
            for p in range(o + 17, o + 17 + 7 * n, 7):
                st = key(b, p)
                stops.append((names[st], b[p + 2] * 60 + b[p + 3], b[p + 4], key(b, p + 5),
                              plats.get((ti, st), "")))
            start, end = date4(b, o + 5), date4(b, o + 9)
            # A trailing letter marks a service period ('Z156/Z157B'); jlb.dat
            # names the train without it
            halves = re.sub(r"(?<=\d)[A-Z]+$", "", codes[ti]).split("/")
            found = {i for h in halves for i in by_number.get(h, ())}
            used = sorted(stock[i][:-1] for i in found
                          if stock[i][0] <= end and stock[i][1] >= start)
            trains.append((codes[ti], start, end, period, mask, stops, used,
                           walk(routes.get(ids[ti]), lines, stops), xw.get(ti, [])))
            o += 17 + 7 * n
    return (version, {n: tels.get(n, ("", "", "")) for n in names}, sorted(trains),
            twin_scopes(lines))


# ---------------- plain data -> rows ----------------
def hm(m):
    return f"{m // 60 % 24:02d}:{m % 60:02d}"


def timeline(stops):
    """-> [(arrival, departure)] in minutes from 00:00 on the day the train
    leaves its origin; the data has clock times only"""
    out, prev = [], None
    for _, arr, dwell, _, _ in stops:
        while prev is not None and arr < prev - NEXT_DAY_MIN:
            arr += 1440
        out.append((arr, arr + dwell))
        prev = arr + dwell
    return out


def compact(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def parts(entries):
    """Split a timetable into JSON arrays of at most about TIMETABLE_PART bytes"""
    out, cur, size = [], [], 0
    for e in entries:
        n = len(compact(e).encode()) + 1
        if cur and size + n > TIMETABLE_PART:
            out.append(cur)
            cur, size = [], 0
        cur.append(e)
        size += n
    return [compact(p) for p in out + [cur]]


def rows(stations, trains, osm, scopes=None):
    """-> {table: [row]}; osm is [(osm_type, osm_id, cr_name)], scopes twin_scopes()
    (without them, the twins of TWIN_STRETCH are left as lltskb has them)"""
    timetables = {n: [] for n in stations}
    train_rows = {}
    labels = line_labels(trains, scopes or {})
    for (code, start, end, period, mask, stops, stock, lines, xw), sides in zip(trains, labels):
        times = timeline(stops)
        numbers = stop_numbers(code, stops, xw)
        last = len(stops) - 1
        origin, dest = stops[0][0], stops[-1][0]
        body = []
        for k, ((st, _, _, km, plat), (arr, dep), (n_in, n_out), (l_in, l_out)) in enumerate(
                zip(stops, times, numbers, sides)):
            a = hm(arr) if k else None
            d = hm(dep) if k < last else None
            # A timetable lists a stop under the day of its departure (arrival at the terminus)
            shown = dep if k < last else arr
            timetables[st].append([code, a, d, shown // 1440, origin, dest, plat,
                                   start, end, period, mask, n_in, n_out, l_in, l_out])
            body.append([st, stations[st][0], a, d, arr // 1440, km, plat, n_in, n_out])
        b = compact({"train": code, "start": start, "end": end, "period": period,
                     "mask": mask, "stops": body,
                     "stock": [[s, e, model, int(coupled), depot, text]
                               for s, e, model, coupled, depot, text in stock],
                     "lines": [[line, [list(p) for p in pts]] for line, pts in lines]})
        # 'C481/C484' is one train under two numbers; either one finds it. A
        # trailing letter marks another service period of the same train
        # ('Z156/Z157B' follows 'Z156/Z157'), so Z157 finds both
        for c in search_keys(code):
            train_rows.setdefault(c, []).append(b)
    lookup = set()
    for name, (tel, pinyin, abbr) in stations.items():
        lookup.update((k.lower(), name) for k in (name, tel, pinyin, abbr) if k)
    for entries in timetables.values():
        entries.sort(key=lambda e: (e[2] or e[1], e[0]))
    return {
        "stations": [(n, tel, pinyin, len(timetables[n])) for n, (tel, pinyin, _) in stations.items()],
        "lookup": sorted(lookup),
        "osm": sorted({(t + i, n) for t, i, n in osm if n in stations}),
        "timetables": [(n, i, b) for n, e in timetables.items() for i, b in enumerate(parts(e))],
        "trains": [(c, "[" + ",".join(b) + "]") for c, b in sorted(train_rows.items())],
    }


def search_keys(code):
    """The numbers a train is found by: its own and each half without the
    period letter (Z156/Z157B is found by Z156/Z157B, Z156 and Z157), as
    rows() files cr_trains"""
    return {code, *re.sub(r"(?<=\d)[A-Z]+$", "", code).split("/")}


def search_json(version, trains):
    """The train search's index: [train, origin, terminus, first day, last
    day] per train, by number, and its keys sorted, with their trains"""
    entries = sorted([code, stops[0][0], stops[-1][0], start, end]
                     for code, start, end, period, mask, stops, *_ in trains)
    # Numbers are ASCII, so Python's order is JavaScript's
    keys = sorted((k, i) for i, e in enumerate(entries) for k in search_keys(e[0]))
    return ('{"version":' + json.dumps(version) + ',"trains":[\n' + ",\n".join(compact(e) for e in entries)
            + '\n],\n"keys":' + compact([k for k, _ in keys]) + ',\n"owners":' + compact([i for _, i in keys]) + "}\n")


# ---------------- rows -> SQL ----------------
def value(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def build_sql(version, tables):
    if not version.isdigit():
        sys.exit(f"bad data version {version!r}")
    out = []
    for t, cols in TABLES.items():
        name = f"cr_{t}_{version}"
        out += [f"DROP TABLE IF EXISTS {name};", f"CREATE TABLE {name} ({cols}) WITHOUT ROWID;"]
        head = f"INSERT INTO {name} VALUES "
        batch, size = [], len(head)
        for row in tables[t]:
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
    # Last, so a partial import never switches the views
    for t in TABLES:
        out += [f"DROP VIEW IF EXISTS cr_{t};",
                f"CREATE VIEW cr_{t} AS SELECT * FROM cr_{t}_{version};"]
    out += [f"DROP VIEW IF EXISTS cr_{t};" for t in GONE]
    out += ["DROP VIEW IF EXISTS cr_version;",
            f"CREATE VIEW cr_version AS SELECT '{version}' AS version;"]
    return "\n".join(out) + "\n"


def drop_old(version, listing):
    """wrangler `d1 execute --json` output of OLD_TABLES_SQL -> DROP statements"""
    names = [r["name"] for r in listing[0]["results"]]
    gone = tuple(f"cr_{t}_" for t in GONE)
    return "".join(f"DROP TABLE {n};" for n in names if not n.endswith(f"_{version}") or n.startswith(gone))


def main():
    if sys.argv[1:] == ["--list-old"]:
        print(OLD_TABLES_SQL)
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--drop-old":
        print(drop_old(sys.argv[2], json.load(sys.stdin)))
        return
    if len(sys.argv) == 4 and sys.argv[1] == "--search":
        version, _, trains, _ = load(sys.argv[2])
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            f.write(search_json(version, trains))
        print(f"{sys.argv[3]}: data {version}, {len(trains)} trains")
        return
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    an, osm_csv, out = sys.argv[1:]
    version, stations, trains, scopes = load(an)
    with open(osm_csv, encoding="utf-8") as f:
        osm = [(r["osm_type"], r["osm_id"], r["cr_name"]) for r in csv.DictReader(f)]
    tables = rows(stations, trains, osm, scopes)
    with open(out, "w", encoding="utf-8") as f:
        f.write(build_sql(version, tables))
    print(f"{out}: data {version}, " + ", ".join(f"{len(v)} {t}" for t, v in tables.items())
          + f", {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
