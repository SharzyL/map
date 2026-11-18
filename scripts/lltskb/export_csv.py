#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Export every table in the Lulutong (路路通) timetable an.db to readable CSV.

Usage:
    python3 export_csv.py                # reads ./an/, writes ./csv/
    python3 export_csv.py <an dir> <out dir>

Output is plain UTF-8 CSV (no BOM) with self-describing Chinese file names.
Row counts for every file are written to 00_导出说明.csv.
"""
import csv
import os
import re
import struct
import sys
from datetime import date

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "an")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "csv")

if len(sys.argv) > 1:
    SRC = sys.argv[1]
if len(sys.argv) > 2:
    OUT = sys.argv[2]

MANIFEST = []
PROBLEMS = []


# ---------------- low-level decoding ----------------
def k(b, o):
    """The app's two-byte integer: hi*255 + lo (not 256)"""
    return (b[o] & 0xFF) * 255 + (b[o + 1] & 0xFF)


def date4(b, o):
    """4-byte base-128 little-endian -> yyyyMMdd integer"""
    return ((b[o] & 0xFF) + (b[o + 1] & 0xFF) * 128
            + (b[o + 2] & 0xFF) * 16384 + (b[o + 3] & 0xFF) * 2097152)


def i32(b, o):
    return struct.unpack(">i", b[o:o + 4])[0]


def u16(b, o):
    return struct.unpack(">H", b[o:o + 2])[0]


def dstr(v):
    """20260127 -> 2026-01-27; 0 / out-of-range values pass through"""
    if 19000101 <= v <= 21001231:
        s = str(v)
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return str(v)


def expect_end(name, o, b):
    """The parse offset must land exactly at EOF, otherwise the format has changed"""
    if o != len(b):
        PROBLEMS.append(f"{name}: 解析停在第 {o} 字节，文件长 {len(b)}")


def hm(h, m):
    return f"{h:02d}:{m:02d}"


def read_index(path):
    """s.i / t.i: u16 count + Java readUTF strings"""
    b = open(path, "rb").read()
    n = u16(b, 0)
    o, out = 2, []
    for _ in range(n):
        L = u16(b, o)
        o += 2
        out.append(b[o:o + L].decode("utf-8", "replace"))
        o += L
    return out


def read_s_dat(path):
    b = open(path, "rb").read()
    o, out = 0, {}
    while o + 4 <= len(b):
        st, n = k(b, o), k(b, o + 2)
        end = o + 4 + 2 * n
        if end > len(b):
            break
        out[st] = [k(b, x) for x in range(o + 4, end, 2)]
        o = end
    expect_end(os.path.basename(path), o, b)
    return out


def read_t_dat(path):
    """-> [(train index, 15-byte header, raw stop bytes)]"""
    b = open(path, "rb").read()
    o, out = 0, []
    while o + 17 <= len(b):
        ti, n = k(b, o), k(b, o + 15)
        end = o + 17 + 7 * n
        if end > len(b):
            break
        out.append((ti, b[o + 2:o + 17], b[o + 17:end]))
        o = end
    expect_end(os.path.basename(path), o, b)
    return out


def parse_stops(blob):
    """7 bytes per stop -> [dict]"""
    out = []
    for i in range(len(blob) // 7):
        p = i * 7
        ah, am, dwell = blob[p + 2], blob[p + 3], blob[p + 4]
        dep = ah * 60 + am + dwell
        out.append(dict(
            st=k(blob, p), arr=hm(ah, am),
            dep=hm((dep // 60) % 24, dep % 60),
            dwell=dwell, km=k(blob, p + 5),
            arr_min=ah * 60 + am,
        ))
    return out


def type_label(code, name):
    t = {"G": "高速动车", "D": "动车组", "C": "城际高速", "S": "市域",
         "Y": "旅游", "X": "新高速", "V": "普速", "N": "快速"}
    return t.get(name[:1], t.get(code[:1], "普速"))


def open_csv(fname, header, note, src=""):
    path = os.path.join(OUT, fname)
    f = open(path, "w", newline="", encoding="utf-8")
    w = csv.writer(f)
    w.writerow(header)
    MANIFEST.append([fname, note, src, 0])
    return f, w, MANIFEST[-1]


# ---------------- load ----------------
os.makedirs(OUT, exist_ok=True)
stations = read_index(os.path.join(SRC, "s.i"))
trains = read_index(os.path.join(SRC, "t.i"))
SNAME = stations
TNAME = trains
SN = lambda i: stations[i] if 0 <= i < len(stations) else f"#{i}"
TN = lambda i: trains[i] if 0 <= i < len(trains) else f"#{i}"

# station -> train indices (only S0.dat..S9.dat; sp.dat / sn.dat are not shards)
sta_trains = {}
for f in sorted(x for x in os.listdir(SRC) if re.fullmatch(r"S\d\.dat", x, re.I)):
    for st, lst in read_s_dat(os.path.join(SRC, f)).items():
        sta_trains.setdefault(st, []).extend(lst)

# train -> header + stops
tinfo = {}
for i in range(20):
    p = os.path.join(SRC, f"T{i}.dat")
    if os.path.exists(p):
        for ti, head, stops in read_t_dat(p):
            tinfo[ti] = (head, stops)
if len(sta_trains) != len(stations):
    PROBLEMS.append(f"S*.dat 有 {len(sta_trains)} 个站，s.i 有 {len(stations)} 个")
if len(tinfo) != len(trains):
    PROBLEMS.append(f"T*.dat 有 {len(tinfo)} 个车次，t.i 有 {len(trains)} 个")

# train index -> {station index: [stop seq...]}
t_stop_idx = {}
for ti, (head, blob) in tinfo.items():
    d = {}
    for n, s in enumerate(parse_stops(blob)):
        d.setdefault(s["st"], []).append(n + 1)
    t_stop_idx[ti] = d

# ---------------- 01 / 02 ----------------
f, w, m = open_csv("01_车站索引.csv", ["站序号", "车站名"],
                   f"共 {len(stations)} 站，按拼音排序；序号是 S*.dat / T*.dat 里的编码值", "s.i")
for i, n in enumerate(stations):
    w.writerow([i, n])
    m[3] += 1
f.close()

f, w, m = open_csv("02_车次索引.csv", ["车次序号", "车次名"],
                   f"共 {len(trains)} 个车次号；'G1/G2' 表示同一列车上下行双号", "t.i")
for i, n in enumerate(trains):
    w.writerow([i, n])
    m[3] += 1
f.close()

# ---------------- sp.dat ----------------
sp = open(os.path.join(SRC, "sp.dat"), "rb").read()
o = 0
n_tsdd = i32(sp, 0)
o = 4
tsdd = []
for _ in range(n_tsdd):
    tsdd.append(dict(id=i32(sp, o), start=i32(sp, o + 4), end=i32(sp, o + 8),
                     a=k(sp, o + 12), b=k(sp, o + 14)))
    o += 16
n_tno = i32(sp, o)
o += 4
train_no = []
for _ in range(n_tno):
    L = sp[o]
    o += 1
    train_no.append(sp[o:o + L].decode("utf-8", "replace"))
    o += L
n_city = k(sp, o)
o += 2
cities = {}
for _ in range(n_city):
    cid = k(sp, o)
    L = sp[o + 2]
    cities[cid] = sp[o + 3:o + 3 + L].decode("utf-8", "replace")
    o += 3 + L
n_prov = i32(sp, o)
o += 4
provs = []
for _ in range(n_prov):
    provs.append(dict(station=i32(sp, o), p1=k(sp, o + 4), p2=k(sp, o + 6)))
    o += 8
n_loc = i32(sp, o)
o += 4
locs = []
for _ in range(n_loc):
    sid = k(sp, o)
    L = sp[o + 2]
    locs.append((sid, sp[o + 3:o + 3 + L].decode("utf-8", "replace")))
    o += 3 + L
n_extra = i32(sp, o)
o += 4
extra_loc = []
for _ in range(n_extra):
    L = sp[o]
    txt = sp[o + 1:o + 1 + L].decode("utf-8", "replace")
    o += 1 + L
    extra_loc.append(txt)
expect_end("sp.dat", o, sp)

f, w, m = open_csv("03_12306车次内部号.csv", ["车次序号", "车次名", "12306内部车次号"],
                   "查余票/正晚点用的内部编号，如 24000000G10L", "sp.dat")
for i, v in enumerate(train_no):
    w.writerow([i, TN(i), v])
    m[3] += 1
f.close()

f, w, m = open_csv("04_车站所属地区.csv", ["站序号", "车站名", "地区/城市"],
                   "sp.dat 里的车站地理位置段", "sp.dat")
loc_map = dict(locs)
for sid, name in locs:
    w.writerow([sid, SN(sid), name])
    m[3] += 1
f.close()

f, w, m = open_csv("05_临时调整车次.csv", ["编号", "起", "止", "值1", "值2"],
                   f"sp.dat 开头的 {len(tsdd)} 条临时/特殊开行条目", "sp.dat")
for t in tsdd:
    w.writerow([t["id"], dstr(t["start"]), dstr(t["end"]), t["a"], t["b"]])
    m[3] += 1
f.close()

# ---------------- trains + stops ----------------
f1, w1, m1 = open_csv(
    "06_车次信息.csv",
    ["车次", "车次序号", "类别", "类型号", "票价号", "开行起", "开行止",
     "周期号", "停站数", "始发站", "终到站", "全程里程", "12306内部号"],
    "每个车次一行的汇总；开行起止+周期号决定哪一天开行", "T*.dat")
f2, w2, m2 = open_csv(
    "07_车次停站时刻表.csv",
    ["车次", "站序", "车站", "到达", "发车", "停站分钟", "累计里程", "区间里程", "推算运行天数"],
    "核心表：每车每站一行。发车=到达+停站分钟；运行天数为推算值（原始数据不存天数）", "T*.dat")
f3, w3, m3 = open_csv(
    "08_车站车次对照.csv",
    ["车站", "站序号", "车次", "车次序号", "是否办客", "该车在本站是第几站"],
    "S*.dat 是候选集：经由此站的全部车次（含不停车通过的）；'否' 表示通过不停，查票时会被剔除", "S*.dat")

for ti in sorted(tinfo):
    head, blob = tinfo[ti]
    stops = parse_stops(blob)
    name = TN(ti)
    typ = head[0]
    price_no = k(head, 1)
    sd, ed = date4(head, 3), date4(head, 7)
    rule = k(head, 11)
    w1.writerow([name, ti, type_label(name, name), typ, price_no, dstr(sd), dstr(ed),
                 rule, len(stops), stops[0]["st"] and SN(stops[0]["st"]),
                 SN(stops[-1]["st"]), stops[-1]["km"],
                 train_no[ti] if ti < len(train_no) else ""])
    m1[3] += 1
    day = 0
    prev = stops[0]["arr_min"]
    for n, s in enumerate(stops, 1):
        if s["arr_min"] < prev - 600:      # time jumping back > 10h means the next day
            day += 1
        prev = s["arr_min"]
        prev_km = stops[n - 2]["km"] if n > 1 else 0
        w2.writerow([name, n, SN(s["st"]), s["arr"], s["dep"], s["dwell"],
                     s["km"], s["km"] - prev_km, day + 1])
        m2[3] += 1

for f in (f1, f2):
    f.close()

# 08: driven by S*.dat (includes pass-through trains); T stop lists mark whether the train stops
for st in sorted(sta_trains):
    for ti in sta_trains[st]:
        pos = t_stop_idx.get(ti, {}).get(st)
        w3.writerow([SN(st), st, TN(ti), ti, "是" if pos else "否",
                     "/".join(str(p) for p in pos) if pos else ""])
        m3[3] += 1
f3.close()

# ---------------- t.rule ----------------
rules = open(os.path.join(SRC, "t.rule"), encoding="utf-8").read().split()
pairs = [(int(rules[i]), int(rules[i + 1])) for i in range(0, len(rules) - 1, 2)]
f, w, m = open_csv("09_开行周期规则.csv", ["周期号", "周期天数", "位掩码", "掩码二进制"],
                   "车次头里的周期号指向本表；(距开行止的天数 % 周期) 对应位为 1 才开行", "t.rule")
for i, (period, mask) in enumerate(pairs):
    w.writerow([i, period, mask, format(mask, "b")])
    m[3] += 1
f.close()

# ---------------- routes.dat ----------------
rb = open(os.path.join(SRC, "routes.dat"), "rb").read()
o = 0


def rstr(off):
    L = rb[off]
    return rb[off + 1:off + 1 + L].decode("utf-8", "replace"), off + 1 + L


n_line = i32(rb, 0)
o = 4
lines = {}
for _ in range(n_line):
    code = i32(rb, o)
    o += 4
    nm, o = rstr(o)
    n_st = i32(rb, o)
    o += 4
    sts = []
    for _ in range(n_st):
        sn, o = rstr(o)
        tel, o = rstr(o)
        flag = i32(rb, o)
        o += 4
        dist = i32(rb, o)
        o += 4
        sts.append((sn, tel, flag, dist))
    lines[code] = (nm, sts)
n_tr = i32(rb, o)
o += 4
troutes = {}
for _ in range(n_tr):
    code, o = rstr(o)
    end, o = rstr(o)
    n_r = i32(rb, o)
    o += 4
    segs = []
    for _ in range(n_r):
        sn, o = rstr(o)
        lc = i32(rb, o)
        o += 4
        segs.append((sn, lc))
    troutes[code] = (end, segs)
expect_end("routes.dat", o, rb)

f, w, m = open_csv("10_线路表.csv", ["线路代码", "线路名", "车站数", "首站", "末站"],
                   "routes.dat 第一段：路网线路", "routes.dat")
for code, (nm, sts) in lines.items():
    w.writerow([code, nm, len(sts), sts[0][0] if sts else "", sts[-1][0] if sts else ""])
    m[3] += 1
f.close()

f, w, m = open_csv("11_线路车站明细.csv", ["线路代码", "线路名", "顺序", "车站", "电报码", "分界标志", "里程"],
                   "每条线路上车站的顺序与里程（画运行图/算路径用）", "routes.dat")
for code, (nm, sts) in lines.items():
    for i, (sn, tel, flag, dist) in enumerate(sts, 1):
        w.writerow([code, nm, i, sn, tel, flag, dist])
        m[3] += 1
f.close()

tno2idx = {}
for i, v in enumerate(train_no):
    tno2idx.setdefault(v, i)
f, w, m = open_csv("12_车次路径.csv", ["车次", "终到站", "段序", "经由车站", "线路代码", "线路名", "12306内部号"],
                   "一次运行走哪几条线路、在哪换线", "routes.dat")
for code, (end, segs) in troutes.items():
    ti = tno2idx.get(code)
    for i, (sn, lc) in enumerate(segs, 1):
        w.writerow([TN(ti) if ti is not None else "", end, i, sn, lc,
                    lines[lc][0] if lc in lines else "", code])
        m[3] += 1
f.close()

# ---------------- plat.dat ----------------
b = open(os.path.join(SRC, "plat.dat"), "rb").read()
n = i32(b, 0)
o = 4
f, w, m = open_csv("13_站台检票口.csv", ["车次", "车站", "站台/检票口"],
                   "按 (车次, 车站) 给出站台或检票口编号", "plat.dat")
for _ in range(n):
    a, c = i32(b, o), i32(b, o + 4)
    L = b[o + 8]
    txt = b[o + 9:o + 9 + L].decode("utf-8", "replace")
    o += 9 + L
    w.writerow([TN(a), SN(c), txt])
    m[3] += 1
f.close()
expect_end("plat.dat", o, b)

# ---------------- sn.dat ----------------
b = open(os.path.join(SRC, "sn.dat"), "rb").read()
o = 0
n1 = u16(b, o)
o = 2
fuzzy = []
for _ in range(n1):
    L = u16(b, o)
    o += 2
    fuzzy.append(b[o:o + L].decode("utf-8", "replace"))
    o += L
n2 = u16(b, o)
o += 2
groups = []
for _ in range(n2):
    gid = u16(b, o)
    c = b[o + 2]
    o += 3
    ids = [struct.unpack(">h", b[o + 2 * i:o + 2 * i + 2])[0] for i in range(c)]
    o += 2 * c
    groups.append((gid, ids))
n3 = u16(b, o)
o += 2
tels = []
for _ in range(n3):
    L = b[o]
    o += 1
    txt = b[o:o + L].decode("utf-8", "replace")
    o += L
    tels.append(txt)
expect_end("sn.dat", o, b)

f, w, m = open_csv("14_同城车站分组.csv", ["组号", "组内车站序号", "组内车站"],
                   "输入'北京'时一起匹配的车站集合（同城多站）", "sn.dat")
for gid, ids in groups:
    w.writerow([gid, " ".join(str(i) for i in ids), " ".join(SN(i) for i in ids)])
    m[3] += 1
f.close()

f, w, m = open_csv("15_车站电报码.csv", ["车站", "电报码"],
                   "站名-三字码，用于 12306 接口参数", "sn.dat")
for t in tels:
    a = t.split("-", 1)
    w.writerow([a[0], a[1] if len(a) > 1 else ""])
    m[3] += 1
f.close()

f, w, m = open_csv("16_模糊搜索词.csv", ["搜索词"],
                   "可被模糊匹配的简称集合（如'北京南'的多种写法）", "sn.dat")
for t in fuzzy:
    w.writerow([t])
    m[3] += 1
f.close()

# ---------------- station_name.js (official 12306 station list) ----------------
p = os.path.join(SRC, "station_name.js")
if os.path.exists(p):
    raw = open(p, encoding="utf-8", errors="replace").read()
    body = raw.split("'")[1] if "'" in raw else raw
    f, w, m = open_csv(
        "17_12306官方站名表.csv",
        ["简拼", "车站名", "电报码", "全拼", "拼音简写", "站序号", "地区码", "城市", "备注1", "备注2", "备注3"],
        "12306 官网 station_name.js 原样拆解，可用于对照电报码", "station_name.js")
    for rec in body.split("@"):
        if not rec.strip():
            continue
        parts = rec.split("|")
        w.writerow((parts + [""] * 11)[:11])
        m[3] += 1
    f.close()

# ---------------- extra.dat ----------------
b = open(os.path.join(SRC, "extra.dat"), "rb").read()
o = 0
n = k(b, o)
o += 2
qiye = []
for _ in range(n):
    L = b[o]
    o += 1
    qiye.append(b[o:o + L].decode("utf-8", "replace"))
    o += L
n = k(b, o)
o += 2
jpk = []
for _ in range(n):
    ti, qi, ns = k(b, o), k(b, o + 2), b[o + 4]
    o += 5
    sts = []
    for _ in range(ns):
        si, nu = k(b, o), b[o + 2]
        o += 3
        units = []
        for _ in range(nu):
            s0, e0 = date4(b, o), date4(b, o + 4)
            L = b[o + 8]
            units.append((s0, e0, b[o + 9:o + 9 + L].decode("utf-8", "replace")))
            o += 9 + L
        sts.append((si, units))
    jpk.append((ti, qi, sts))
fx = {}
for lvl in (1, 2, 3):
    cnt = k(b, o)
    o += 2
    for _ in range(cnt):
        fx[k(b, o)] = lvl
        o += 2
n = k(b, o)
o += 2
turns = {}
for _ in range(n):
    ti, c = k(b, o), b[o + 2]
    o += 3
    turns[ti] = [k(b, o + 2 * i) for i in range(c)]
    o += 2 * c
n = k(b, o)
o += 2
strains = [k(b, o + 2 * i) for i in range(n)]
expect_end("extra.dat", o + 2 * n, b)
n_detail = sum(1 for _, _, sts in jpk if sts)

f, w, m = open_csv("18_车次所属单位.csv", ["车次", "所属单位", "站级检票口条数"],
                   f"车次->铁路局/公司归属；{len(jpk)} 条记录中 {n_detail} 条带站级检票口明细（本表只给条数），检票口请看 13_站台检票口.csv",
                   "extra.dat")
for ti, qi, sts in jpk:
    n_units = sum(len(u) for _, u in sts)
    w.writerow([TN(ti), qiye[qi] if qi < len(qiye) else "", n_units])
    m[3] += 1
f.close()

f, w, m = open_csv("19_复兴号车次.csv", ["车次", "复兴号类型"],
                   "1/2/3 为数据里的分类号", "extra.dat")
for ti, lvl in sorted(fx.items()):
    w.writerow([TN(ti), lvl])
    m[3] += 1
f.close()

f, w, m = open_csv("20_折返套跑站序.csv", ["车次", "折返/套跑站序"],
                   "车底折返或套跑时的关键站序列表", "extra.dat")
for ti, arr in sorted(turns.items()):
    w.writerow([TN(ti), " ".join(str(i) for i in arr)])
    m[3] += 1
f.close()

f, w, m = open_csv("21_市域线车次.csv", ["车次"], "标记为市域线的车次", "extra.dat")
for ti in strains:
    w.writerow([TN(ti)])
    m[3] += 1
f.close()

f, w, m = open_csv("22_企业单位表.csv", ["序号", "单位名"], "检票口/席位所属铁路局或企业", "extra.dat")
for i, q in enumerate(qiye):
    w.writerow([i, q])
    m[3] += 1
f.close()

# ---------------- jlb.dat ----------------
b = open(os.path.join(SRC, "jlb.dat"), "rb").read()
n = i32(b, 0)
o = 4
jl = []
for _ in range(n):
    s0, e0 = i32(b, o), i32(b, o + 4)
    f1, f2 = i32(b, o + 8), i32(b, o + 12)
    g = k(b, o + 16)
    L = b[o + 18]
    cars = b[o + 19:o + 19 + L].decode("utf-8", "replace")
    o += 19 + L
    L2 = b[o]
    grp = b[o + 1:o + 1 + L2].decode("utf-8", "replace")
    o += 1 + L2
    jl.append((s0, e0, f1, f2, g, cars, grp))
nf = i32(b, o)
o += 4
food = []
for _ in range(nf):
    a = i32(b, o)
    s0, e0 = i32(b, o + 4), i32(b, o + 8)
    L = b[o + 12]
    txt = b[o + 13:o + 13 + L].decode("utf-8", "replace")
    o += 13 + L
    food.append((a, s0, e0, txt))
expect_end("jlb.dat", o, b)

f, w, m = open_csv("23_车底编组.csv", ["套跑车次组", "车型/供电/编组", "起始日", "结束日", "标志1", "标志2", "担当单位"],
                   "按车次组（用 # 分隔）给出车底型号、供电方式、集便器、调向等；担当单位见 22_企业单位表.csv", "jlb.dat")
for s0, e0, f1, f2, g, cars, grp in jl:
    w.writerow([grp, cars, dstr(s0), dstr(e0), f1, f2, qiye[g] if g < len(qiye) else g])
    m[3] += 1
f.close()

f, w, m = open_csv("24_餐车位置.csv", ["车次", "餐车位置", "起始日", "结束日"],
                   "餐车在第几车，如 '9车[餐]'、'10车有餐座'", "jlb.dat")
for a, s0, e0, txt in food:
    w.writerow([TN(a), txt, dstr(s0), dstr(e0)])
    m[3] += 1
f.close()

# ---------------- p / pk fare override tables ----------------
f, w, m = open_csv("25_票价单元表_p.csv", ["键1", "键2", "单元序号", "原始字节HEX"],
                   "票价覆盖表（极少车次有），字段语义未完全确认；多数票价按里程实时计算", "p*.dat")
for i in range(5):
    p = os.path.join(SRC, f"p{i}.dat")
    if not os.path.exists(p):
        continue
    b = open(p, "rb").read()
    o = 0
    while o + 5 <= len(b):
        a = (b[o] & 0xFF) * 128 + (b[o + 1] & 0xFF)
        c = (b[o + 2] & 0xFF) * 128 + (b[o + 3] & 0xFF)
        cnt = b[o + 4]
        end = o + 5 + 6 * cnt
        if end > len(b):
            break
        for j in range(cnt):
            chunk = b[o + 5 + 6 * j:o + 11 + 6 * j]
            w.writerow([a, c, j + 1, chunk.hex().upper()])
            m[3] += 1
        o = end
    # No expect_end: the current decoding never reaches EOF on p*.dat (see README section 7)
f.close()


def bitcount(flag):
    return ((flag & 1) > 0) + ((flag & 2) > 0) + 3 * ((flag & 4) > 0) \
        + 2 * ((flag & 8) > 0) + ((flag & 16) > 0) + ((flag & 32) > 0)


f, w, m = open_csv("26_票价明细表_pk.csv", ["键1", "键2", "条目序号", "席别键", "标志位", "价格字节HEX"],
                   "票价覆盖明细；空值/0 表示按里程阶梯计算", "pk*.dat")
for i in range(10):
    p = os.path.join(SRC, f"pk{i}.dat")
    if not os.path.exists(p):
        continue
    b = open(p, "rb").read()
    o = 0
    while o + 5 <= len(b):
        a, c, cnt = k(b, o), k(b, o + 2), b[o + 4]
        p2 = o + 5
        for j in range(cnt):
            if p2 + 2 >= len(b):
                break
            flag = b[p2 + 2]
            ln = bitcount(flag) * 2
            w.writerow([a, c, j + 1, k(b, p2), flag, b[p2 + 3:p2 + 3 + ln].hex().upper()])
            m[3] += 1
            p2 += 3 + ln
        o = p2
    expect_end(f"pk{i}.dat", o, b)
f.close()

# ---------------- ime.dat ----------------
p = os.path.join(SRC, "ime.dat")
if os.path.exists(p):
    b = open(p, "rb").read()
    f, w, m = open_csv("27_输入法词条.csv", ["内容(UTF-8)"],
                       "结构未确证：本文件未被 Java 层引用（可能是旧版输入法词库），此处按可读文本强解，仅供翻阅", "ime.dat")
    txt = b.decode("utf-8", "replace")
    for chunk in txt.split("\x00"):
        chunk = "".join(ch for ch in chunk if ch >= " " or ch in "\t")
        if chunk.strip():
            w.writerow([chunk.strip()])
            m[3] += 1
    f.close()

# ---------------- manifest ----------------
MANIFEST.append(["00_导出说明.csv", "本文件：文件清单与行数", "", len(MANIFEST) + 1])
with open(os.path.join(OUT, "00_导出说明.csv"), "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["文件名", "说明", "来源数据文件", "行数(不含表头)"])
    for row in sorted(MANIFEST):
        w.writerow(row)

total = sum(r[3] for r in MANIFEST)
print(f"输出目录: {OUT}")
for row in sorted(MANIFEST):
    print(f"  {row[0]:<28} {row[3]:>8} 行   {row[1]}")
print(f"合计 {total} 行")

# The cancellation / temporary-change overlay isn't implemented; with data present
# some trains will be off, but the export is still usable
for fn in ("sch.dat", "ts.dat"):
    p = os.path.join(SRC, fn)
    if os.path.exists(p) and os.path.getsize(p):
        print(f"警告: {fn} 非空（{os.path.getsize(p)} 字节），停运/临调覆盖层未实现")

if PROBLEMS:
    print("自检失败，数据格式可能变了：", file=sys.stderr)
    for msg in PROBLEMS:
        print(f"  {msg}", file=sys.stderr)
    sys.exit(1)
