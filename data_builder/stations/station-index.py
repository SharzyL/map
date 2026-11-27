#!/usr/bin/env python3
"""The stations the API's search finds (/api/v1/search, src/worker/api/station-search.ts),
for search-keys.mjs to add their keys to.

Usage:
    station-index.py --cr-csv <lltskb csv dir> --cr-stations cr-station-trains.csv
                     --coords station-coords.csv --jp-osm japan.json
                     --jp-codes jp-station-codes.csv --jp-readings jp-station-readings.csv
                     --ranks station-ranks.csv --n03 <N03 dir> --out stations.json
                     [--readings jp-readings.csv]

China's stations are China Railway's, from 路路通's timetable (export_csv.py's
CSV): every station with a passenger train, its telecode and pinyin (12306's
station list), its region (路路通's 车站所属地区, else 12306's city) and the
OSM features cr-station-trains.py matched it to, placed by station-coords.py.

Japan's are OpenStreetMap's railway stations (osm-stations.py's japan.json),
those of one name that share a Yahoo! 乗換案内 code (jp-station-codes.py) or
lie within JOIN_M of each other taken as one: 新宿's nodes of JR, Odakyu, Keio
and the subways are one station with all their codes. Its reading is Yahoo's
(jp-station-codes.py --readings), else OSM's name:ja-Hira or name:ja_kana; its
prefecture and municipality come from MLIT's administrative boundaries
(国土数値情報 N03, fetch-n03.sh) at its position.

The search matches names only; the region tells same-named stations apart.
Each station has a weight from 0 to 1000, how busy it is within its country
on a log scale: trains a day stopping in China, routes stopping (the
relations step's ranks, build_relations.py) in Japan.

Writes the stations as a JSON array, a station a line; search-keys.mjs adds
the keys they are found by, with the Worker's own folding, and the version.
With --readings, also each Japanese OSM station element's reading, its
station's (osm_type, osm_id, yomi), which the tile export gives the stations'
labels (data_builder/tiles/tables.py) for their info box.
Needs numpy.
"""

import argparse
import collections
import csv
import json
import math
import re
import struct
import sys
import unicodedata
from pathlib import Path

import numpy as np

# Stations of one name this close are one, without a shared code
JOIN_M = 1000
# N03's lookup grid, degrees
CELL = 0.25

# 路路通's short names of autonomous regions, as they are called
PROVINCES = {
    '内蒙古': '内蒙古自治区',
    '广西': '广西壮族自治区',
    '新疆': '新疆维吾尔自治区',
    '宁夏': '宁夏回族自治区',
    '西藏': '西藏自治区',
    '香港': '香港特别行政区',
    '澳门': '澳门特别行政区',
}
REGION_LEVEL = re.compile(r'.+?(?:特别行政区|自治区|自治州|地区|省|市|州|盟|县|区|旗)')


def read_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def cr_region(text):
    """'江苏省 南京市 雨花台区' -> its levels, the province named in full;
    the levels of one written without spaces split by their suffixes"""
    levels = text.split()
    if len(levels) == 1 and len(REGION_LEVEL.findall(levels[0])) > 1:
        levels = REGION_LEVEL.findall(levels[0])
    if levels:
        levels[0] = PROVINCES.get(levels[0], levels[0])
    return levels


def log_weights(values):
    """{key: count} -> {key: 0..1000}, log-scaled to the largest"""
    top = max(values.values(), default=0)
    if top <= 0:
        return dict.fromkeys(values, 0)
    return {k: round(1000 * math.log1p(max(v, 0)) / math.log1p(top)) for k, v in values.items()}


def mean_position(refs, coords):
    placed = [coords[r] for r in refs if r in coords]
    if not placed:
        return None
    return [round(sum(p[0] for p in placed) / len(placed), 6), round(sum(p[1] for p in placed) / len(placed), 6)]


# ---------------- China ----------------

def china(csv_dir, matched_csv, coords):
    csv_dir = Path(csv_dir)
    names = [r['车站名'] for r in read_csv(csv_dir / '01_车站索引.csv')]
    regions = {r['车站名']: cr_region(r['地区/城市']) for r in read_csv(csv_dir / '04_车站所属地区.csv')}
    official = {r['车站名']: r for r in read_csv(csv_dir / '17_12306官方站名表.csv')}
    telecodes = {r['车站']: r['电报码'] for r in read_csv(csv_dir / '15_车站电报码.csv')}
    trains = collections.defaultdict(set)
    for r in read_csv(csv_dir / '08_车站车次对照.csv'):
        if r['是否办客'] == '是':
            trains[r['车站']].add(r['车次'])
    osm = collections.defaultdict(list)
    for r in read_csv(matched_csv):
        osm[r['cr_name']].append(r['osm_type'] + r['osm_id'])

    weights = log_weights({n: len(trains[n]) for n in names if trains[n]})
    stations = []
    for name in names:
        if name not in weights:
            continue
        row = official.get(name, {})
        refs = sorted(set(osm[name]))
        region = regions.get(name) or ([row['城市']] if row.get('城市') else [])
        station = {
            'c': 'cn',
            'n': name,
            'r': region,
            'o': refs,
            'p': mean_position(refs, coords),
            't': row.get('电报码') or telecodes.get(name) or None,
            'l': sorted({k for k in (row.get('全拼'), row.get('简拼')) if k}),
            'w': weights[name],
        }
        stations.append(station)
    return stations


# ---------------- Japan's boundaries (N03) ----------------

class Municipalities:
    """N03's municipality polygons, looked up by point: a grid of their
    bounding boxes, then even-odd ray casting over each candidate's rings."""

    def __init__(self, directory):
        directory = Path(directory)
        self.shp = (directory / 'N03.shp').read_bytes()
        shx = (directory / 'N03.shx').read_bytes()
        count = (len(shx) - 100) // 8
        self.offsets = [struct.unpack_from('>i', shx, 100 + 8 * i)[0] * 2 for i in range(count)]
        self.fields = read_dbf(directory / 'N03.dbf')
        if len(self.fields) != count:
            sys.exit(f'N03: {count} shapes but {len(self.fields)} records')
        self.boxes = np.zeros((count, 4))
        self.grid = collections.defaultdict(list)
        for i, offset in enumerate(self.offsets):
            if struct.unpack_from('<i', self.shp, offset + 8)[0] == 0:  # null shape
                self.boxes[i] = (1, 1, -1, -1)
                continue
            box = struct.unpack_from('<4d', self.shp, offset + 12)
            self.boxes[i] = box
            for x in range(math.floor(box[0] / CELL), math.floor(box[2] / CELL) + 1):
                for y in range(math.floor(box[1] / CELL), math.floor(box[3] / CELL) + 1):
                    self.grid[x, y].append(i)

    def rings(self, i):
        offset = self.offsets[i] + 8
        n_parts, n_points = struct.unpack_from('<2i', self.shp, offset + 36)
        parts = list(struct.unpack_from(f'<{n_parts}i', self.shp, offset + 44)) + [n_points]
        points = np.frombuffer(self.shp, '<f8', 2 * n_points, offset + 44 + 4 * n_parts).reshape(-1, 2)
        return [points[a:b] for a, b in zip(parts, parts[1:])]

    def contains(self, i, lon, lat):
        box = self.boxes[i]
        if not (box[0] <= lon <= box[2] and box[1] <= lat <= box[3]):
            return False
        inside = False
        for ring in self.rings(i):
            x, y = ring[:, 0], ring[:, 1]
            x2, y2 = np.roll(x, -1), np.roll(y, -1)
            crosses = (y > lat) != (y2 > lat)
            with np.errstate(divide='ignore', invalid='ignore'):
                at = x + (lat - y) * (x2 - x) / (y2 - y)
            inside ^= bool(np.count_nonzero(crosses & (lon < at)) % 2)
        return inside

    def nearest(self, candidates, lon, lat):
        """The candidate with a boundary point closest, for a station just
        off the coast line (a pier, reclaimed land)"""
        best, best_d = None, math.inf
        scale = math.cos(math.radians(lat))
        for i in candidates:
            for ring in self.rings(i):
                d = np.min(((ring[:, 0] - lon) * scale) ** 2 + (ring[:, 1] - lat) ** 2)
                if d < best_d:
                    best, best_d = i, d
        return best

    def at(self, lat, lon):
        """The record holding the point, else the nearest around it, or None"""
        cell = (math.floor(lon / CELL), math.floor(lat / CELL))
        for i in self.grid.get(cell, ()):
            if self.contains(i, lon, lat):
                return self.fields[i]
        around = {i for dx in (-1, 0, 1) for dy in (-1, 0, 1) for i in self.grid.get((cell[0] + dx, cell[1] + dy), ())}
        i = self.nearest(sorted(around), lon, lat)
        return None if i is None else self.fields[i]

    def region(self, lat, lon):
        """[prefecture, municipality, ward], those it has"""
        record = self.at(lat, lon)
        if record is None:
            return []
        pref, _subpref, _county, municipality, ward = record[:5]
        if municipality == '所属未定地':  # disputed between municipalities
            municipality = ''
        return [level for level in (pref, municipality, ward) if level]


def read_dbf(path):
    """A dBase file's records as lists of strings (UTF-8, as N03 writes them)"""
    data = Path(path).read_bytes()
    count, header, size = struct.unpack_from('<IHH', data, 4)
    widths = [data[i + 16] for i in range(32, header - 1, 32)]
    records = []
    for k in range(count):
        offset = header + k * size + 1  # past the deletion flag
        values = []
        for width in widths:
            values.append(data[offset:offset + width].decode('utf-8').strip(' \0'))
            offset += width
        records.append(values)
    return records


# ---------------- Japan ----------------

def katakana(text):
    return ''.join(chr(ord(c) + 0x60) if 'ぁ' <= c <= 'ゖ' or c in 'ゝゞ' else c for c in text)


def name_key(name):
    name = unicodedata.normalize('NFKC', name).replace('ヶ', 'ケ').replace('ヵ', 'カ').replace(' ', '')
    return re.sub(r'駅$', '', name)


def metres(a, b):
    la, lb = math.radians(a[0]), math.radians(b[0])
    cos = math.sin(la) * math.sin(lb) + math.cos(la) * math.cos(lb) * math.cos(math.radians(a[1] - b[1]))
    return 6371000 * math.acos(max(-1, min(1, cos)))


def japan(osm_json, codes_csv, readings_csv, ranks_csv, municipalities):
    with open(osm_json, encoding='utf-8') as f:
        elements = json.load(f)['elements']
    codes = {r['osm_type'] + r['osm_id']: [c for c in r['codes'].split(';') if c] for r in read_csv(codes_csv)}
    readings = {r['code']: r['yomi'] for r in read_csv(readings_csv)}
    ranks = {r['element']: int(r['rank']) for r in read_csv(ranks_csv)}

    by_name = collections.defaultdict(list)
    for e in elements:
        tags = e.get('tags', {})
        name = tags.get('name:ja') or tags.get('name')
        if not name:
            continue
        at = e.get('center') or e
        ref = e['type'][0].upper() + str(e['id'])
        by_name[name_key(name)].append({
            'ref': ref, 'name': name, 'tags': tags, 'pos': (at['lat'], at['lon']), 'codes': codes.get(ref, []),
        })

    groups = []
    for same in by_name.values():
        # Union-find over the stations of one name
        parent = list(range(len(same)))

        def root(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for i in range(len(same)):
            for j in range(i + 1, len(same)):
                a, b = same[i], same[j]
                if set(a['codes']) & set(b['codes']) or metres(a['pos'], b['pos']) <= JOIN_M:
                    parent[root(i)] = root(j)
        joined = collections.defaultdict(list)
        for i, s in enumerate(same):
            joined[root(i)].append(s)
        groups += joined.values()

    raw = {}
    stations = []
    for members in groups:
        members.sort(key=lambda s: s['ref'])
        # The name most of them carry
        names = collections.Counter(s['name'] for s in members)
        name = max(names, key=lambda n: (names[n], -len(n), n))
        code_count = collections.Counter(c for s in members for c in s['codes'])
        group_codes = sorted(code_count, key=lambda c: (-code_count[c], len(c), c))
        yomi = next((readings[c] for c in group_codes if c in readings), None)
        if not yomi:
            tag = next((s['tags'].get(k) for s in members for k in ('name:ja-Hira', 'name:ja_kana', 'name:ja-Kana')
                        if s['tags'].get(k)), None)
            yomi = katakana(tag.replace(' ', '')) if tag else None
        latin = sorted({s['tags'][k] for s in members for k in ('name:ja-Latn', 'name:en') if s['tags'].get(k)})
        lat = round(sum(s['pos'][0] for s in members) / len(members), 6)
        lon = round(sum(s['pos'][1] for s in members) / len(members), 6)
        refs = [s['ref'] for s in members]
        key = len(stations)
        raw[key] = max((ranks.get(r, 0) for r in refs), default=0)
        stations.append({
            'c': 'jp',
            'n': name,
            'y': yomi,
            'r': municipalities.region(lat, lon) if municipalities else [],
            'o': refs,
            'p': [lat, lon],
            'k': group_codes,
            'l': latin,
        })
    weights = log_weights(raw)
    for key, station in enumerate(stations):
        station['w'] = weights[key]
    return stations


# ---------------- Output ----------------

def readings_rows(stations):
    """(osm_type, osm_id, yomi) of every element of a Japanese station with
    a reading, by element"""
    rows = {(ref[0], int(ref[1:])): s['y'] for s in stations if s['c'] == 'jp' and s.get('y') for ref in s['o']}
    return [(t, i, y) for (t, i), y in sorted(rows.items())]


def stations_json(stations):
    """The stations as a JSON array, one a line"""
    lines = [json.dumps(station, ensure_ascii=False, separators=(',', ':')) for station in stations]
    return '[\n' + ',\n'.join(lines) + '\n]\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cr-csv', required=True, help="export_csv.py's directory")
    parser.add_argument('--cr-stations', required=True, help='cr-station-trains.csv')
    parser.add_argument('--coords', required=True, help='station-coords.csv')
    parser.add_argument('--jp-osm', required=True, help="osm-stations.py's japan.json")
    parser.add_argument('--jp-codes', required=True, help='jp-station-codes.csv')
    parser.add_argument('--jp-readings', required=True, help='jp-station-codes.py --readings')
    parser.add_argument('--ranks', required=True, help="the relations step's station-ranks.csv")
    parser.add_argument('--n03', help="fetch-n03.sh's directory (without it, no regions in Japan)")
    parser.add_argument('--out', required=True)
    parser.add_argument('--readings', help="where to write the Japanese elements' readings")
    args = parser.parse_args()

    coords = {r['osm_type'] + r['osm_id']: (float(r['lat']), float(r['lon'])) for r in read_csv(args.coords)}
    stations = china(args.cr_csv, args.cr_stations, coords)
    municipalities = Municipalities(args.n03) if args.n03 else None
    stations += japan(args.jp_osm, args.jp_codes, args.jp_readings, args.ranks, municipalities)
    text = stations_json(stations)
    Path(args.out).write_text(text, encoding='utf-8')
    if args.readings:
        with open(args.readings, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['osm_type', 'osm_id', 'yomi'])
            writer.writerows(readings_rows(stations))
    count = collections.Counter(s['c'] for s in stations)
    print(f"{args.out}: {count['cn']} stations in China, {count['jp']} in Japan "
          f"({sum(1 for s in stations if s['c'] == 'jp' and s['y'])} with a reading, "
          f"{sum(1 for s in stations if s['c'] == 'jp' and s['r'])} with a region), "
          f"{len(text.encode()) / 1e6:.1f} MB")


if __name__ == '__main__':
    main()
