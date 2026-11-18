#!/usr/bin/env python3
"""Parser for the Lulutong (路路通) timetable an.db data files (stdlib only).

Source: http://down.lltskb.com/an.db (a ZIP of 64 .dat files); run fetch.py to unpack it into ./an/
Usage:
    python3 lulutong_parse.py query 北京南 上海虹桥 [20261114]   # date defaults to today
    python3 lulutong_parse.py train G1
    python3 lulutong_parse.py station 北京南
"""
import os
import struct
import sys
import time
import zipfile

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "an")


# ---------- primitives ----------
def key(b, o):
    """The app's two-byte encoding: high byte * 255 + low byte (not 256!)"""
    return (b[o] & 0xFF) * 255 + (b[o + 1] & 0xFF)


def date4(b, o):
    """4-byte base-128 little-endian: b0 + b1*128 + b2*16384 + b3*2097152 -> yyyymmdd"""
    return ((b[o] & 0xFF) + (b[o + 1] & 0xFF) * 128
            + (b[o + 2] & 0xFF) * 16384 + (b[o + 3] & 0xFF) * 2097152)


def i32(b, o):
    return struct.unpack(">i", b[o:o + 4])[0]


def read_index(path):
    """s.i / t.i: u16 count + Java readUTF (u16 length prefix)"""
    b = open(path, "rb").read()
    n = struct.unpack(">H", b[:2])[0]
    o, out = 2, []
    for _ in range(n):
        L = struct.unpack(">H", b[o:o + 2])[0]
        o += 2
        out.append(b[o:o + L].decode("utf-8", "replace"))
        o += L
    return out


def read_s_dat(path):
    """S*.dat: station -> train indices. Record = station(2) + count(2) + count*2"""
    b = open(path, "rb").read()
    o, out = 0, {}
    while o + 4 <= len(b):
        st, n = key(b, o), key(b, o + 2)
        end = o + 4 + 2 * n
        if end > len(b):
            break
        out[st] = [key(b, k) for k in range(o + 4, end, 2)]
        o = end
    return out


def read_t_rec(path, want):
    """T*.dat: train records. Record = train(2) + header(15) + stops*7"""
    b = open(path, "rb").read()
    o = 0
    while o + 17 <= len(b):
        t, n = key(b, o), key(b, o + 15)
        end = o + 17 + 7 * n
        if end > len(b):
            return None
        if t == want:
            return b[o + 2:end]
        o = end
    return None


def parse_train(rec, names):
    """Decode a T record into a dict"""
    typ = rec[0]
    price_no = key(rec, 1)
    start, end = date4(rec, 3), date4(rec, 7)
    rule = key(rec, 11)
    n = key(rec, 13)
    stops = []
    for k in range(n):
        p = 15 + 7 * k
        st = key(rec, p)
        ah, am = rec[p + 2], rec[p + 3]
        dwell = rec[p + 4]
        dist = key(rec, p + 5)
        dep = ah * 60 + am + dwell
        stops.append(dict(station=names[st], idx=st, arrH=ah, arrM=am,
                          depH=(dep // 60) % 24, depM=dep % 60,
                          dwell=dwell, km=dist))
    return dict(type=typ, priceNo=price_no, start=start, end=end,
                rule=rule, stops=stops)


# ---------- loading ----------
class DB:
    def __init__(self, folder=D):
        self.dir = folder
        self.stations = read_index(os.path.join(folder, "s.i"))
        self.trains = read_index(os.path.join(folder, "t.i"))
        self.by_station = {}
        for i in range(10):
            self.by_station.update(read_s_dat(os.path.join(folder, f"S{i}.dat")))
        self._cache = {}

    def train(self, code):
        idx = self.trains.index(code)
        if idx in self._cache:
            return self._cache[idx]
        rec = read_t_rec(os.path.join(self.dir, f"T{(idx + 1) % 20}.dat"), idx)
        info = parse_train(rec, self.stations) if rec else None
        self._cache[idx] = info
        return info

    def trains_at(self, station):
        return self.by_station.get(self.stations.index(station), [])

    def validity(self, info, date):
        """Service date range + t.rule running-cycle check"""
        s, e = str(info["start"]), str(info["end"])
        if not (s <= date <= e):
            return False
        rules = open(os.path.join(self.dir, "t.rule")).read().split()
        pairs = [(int(rules[i]), int(rules[i + 1])) for i in range(0, len(rules) - 1, 2)]
        i = info["rule"]
        if i >= len(pairs):
            return True
        period, mask = pairs[i]
        if period <= 1:
            return True
        # runs only if (days until endDate) % period hits a set bit in mask
        from datetime import datetime
        d0 = datetime.strptime(str(info["end"]), "%Y%m%d")
        d1 = datetime.strptime(date, "%Y%m%d")
        diff = (d0 - d1).days
        return bool(mask & (1 << (diff % period)))

    def query(self, frm, to, date=None):
        date = date or time.strftime("%Y%m%d")
        a, b = self.stations.index(frm), self.stations.index(to)
        out = []
        for ti in self.trains_at(frm):
            info = self.train(self.trains[ti])
            if not info or not self.validity(info, date):
                continue
            seq = [s["idx"] for s in info["stops"]]
            if b not in seq:
                continue
            i, j = seq.index(a), seq.index(b)
            if j <= i:
                continue
            d = dict(code=self.trains[ti])
            d["from"] = info["stops"][i]
            d["to"] = info["stops"][j]
            dep = d["from"]["depH"] * 60 + d["from"]["depM"]
            arr = d["to"]["arrH"] * 60 + d["to"]["arrM"]
            days = j - i and 0
            # crossing midnight: borrow 24h until non-negative
            dur = arr - dep
            while dur < 0:
                dur += 1440
            d["dur"] = dur
            d["km"] = d["to"]["km"] - d["from"]["km"]
            out.append(d)
        out.sort(key=lambda x: x["from"]["depH"] * 60 + x["from"]["depM"])
        return out


def fmt(m):
    return f"{m // 60:02d}:{m % 60:02d}"


if __name__ == "__main__":
    db = DB()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "query"
    if cmd == "train":
        info = db.train(sys.argv[2].upper())
        if not info:
            print("未找到车次")
            sys.exit(1)
        print(f"{sys.argv[2].upper()}  {info['start']}-{info['end']}  rule={info['rule']}  {len(info['stops'])} 站")
        for s in info["stops"]:
            print(f"  {s['station']:<8} 到 {s['arrH']:02d}:{s['arrM']:02d}"
                  f"  发 {s['depH']:02d}:{s['depM']:02d}  停{s['dwell']:>3}分  {s['km']:>5} km")
    elif cmd == "station":
        t = db.trains_at(sys.argv[2])
        print(f"{sys.argv[2]} 共 {len(t)} 趟")
        print("  " + " ".join(db.trains[i] for i in t[:40]) + " ...")
    else:
        date = sys.argv[4] if len(sys.argv) > 4 else time.strftime("%Y%m%d")
        res = db.query(sys.argv[2], sys.argv[3], date)
        print(f"{sys.argv[2]} → {sys.argv[3]}  {date}  共 {len(res)} 趟")
        for d in res:
            print(f"  {d['code']:<7} {d['from']['station']} {fmt(d['from']['depH'] * 60 + d['from']['depM'])}"
                  f" → {d['to']['station']} {fmt(d['to']['arrH'] * 60 + d['to']['arrM'])}"
                  f"  历时 {d['dur'] // 60}:{d['dur'] % 60:02d}  {d['km']} km")
