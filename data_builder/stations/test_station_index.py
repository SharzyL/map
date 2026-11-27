"""Tests of station-index.py on small inputs: python3 -m unittest discover -s data_builder/stations"""

import csv
import importlib.util
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
# What search-keys.mjs's test (search-keys.test.mjs) turns into the Worker's
# fixture, fixtures/build-data/search-stations.json
FIXTURE = HERE.parent.parent / 'src/worker/api/fixtures/search-stations.raw.json'
spec = importlib.util.spec_from_file_location('station_index', HERE / 'station-index.py')
si = importlib.util.module_from_spec(spec)
spec.loader.exec_module(si)


def write_csv(path, header, rows):
    with open(path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def write_shapefile(directory, shapes):
    """shapes: [(fields, [ring, ...])], each ring [(lon, lat), ...] closed;
    writes N03.shp, .shx and .dbf as N03 has them (polygons, UTF-8)"""
    records, index = [], []
    offset = 100
    for number, (_, rings) in enumerate(shapes, 1):
        points = [p for ring in rings for p in ring]
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        starts, at = [], 0
        for ring in rings:
            starts.append(at)
            at += len(ring)
        content = struct.pack('<i4d2i', 5, min(xs), min(ys), max(xs), max(ys), len(rings), len(points))
        content += struct.pack(f'<{len(starts)}i', *starts)
        content += b''.join(struct.pack('<2d', *p) for p in points)
        records.append(struct.pack('>2i', number, len(content) // 2) + content)
        index.append(struct.pack('>2i', offset // 2, len(content) // 2))
        offset += 8 + len(content)

    def header(length):
        return struct.pack('>i20xi', 9994, length // 2) + struct.pack('<2i4d32x', 1000, 5, 0, 0, 0, 0)

    body = b''.join(records)
    (directory / 'N03.shp').write_bytes(header(100 + len(body)) + body)
    (directory / 'N03.shx').write_bytes(header(100 + 8 * len(index)) + b''.join(index))
    widths = [20, 40, 40, 40, 40, 5]
    fields = b''.join(struct.pack('<11sc4xB15x', f'N03_00{i}'.encode(), b'C', w) for i, w in enumerate(widths, 1))
    size = 1 + sum(widths)
    dbf = struct.pack('<B3xIHH20x', 3, len(shapes), 32 + len(fields) + 1, size) + fields + b'\r'
    for values, _ in shapes:
        dbf += b' ' + b''.join(v.encode().ljust(w, b' ') for v, w in zip(values, widths))
    (directory / 'N03.dbf').write_bytes(dbf + b'\x1a')


def square(lon, lat, size):
    return [(lon, lat), (lon, lat + size), (lon + size, lat + size), (lon + size, lat), (lon, lat)]


class RegionTest(unittest.TestCase):
    def test_provinces_in_full(self):
        self.assertEqual(si.cr_region('新疆 阿克苏地区 阿克苏市'), ['新疆维吾尔自治区', '阿克苏地区', '阿克苏市'])
        self.assertEqual(si.cr_region('江苏省 南京市 雨花台区'), ['江苏省', '南京市', '雨花台区'])
        self.assertEqual(si.cr_region('上海市 嘉定区'), ['上海市', '嘉定区'])

    def test_levels_without_spaces(self):
        self.assertEqual(si.cr_region('山西省吕梁市石楼县'), ['山西省', '吕梁市', '石楼县'])
        self.assertEqual(si.cr_region(''), [])

    def test_log_weights(self):
        self.assertEqual(si.log_weights({'a': 0, 'b': 9, 'c': 99}), {'a': 0, 'b': 500, 'c': 1000})


class MunicipalitiesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        directory = Path(self.dir.name)
        # A ward with a hole that is another ward, and a town by the sea
        write_shapefile(directory, [
            (['東京都', '', '', '千代田区', '', '13101'], [square(139.0, 35.0, 1.0), square(139.4, 35.4, 0.2)]),
            (['東京都', '', '', '中央区', '', '13102'], [square(139.4, 35.4, 0.2)]),
            (['北海道', '石狩振興局', '', '札幌市', '北区', '01102'], [square(141.0, 43.0, 0.1)]),
            (['長野県', '', '北佐久郡', '軽井沢町', '', '20321'], [square(138.0, 36.0, 0.5)]),
            (['北海道', '', '', '所属未定地', '', ''], [square(145.0, 44.0, 0.1)]),
        ])
        self.m = si.Municipalities(directory)

    def tearDown(self):
        self.dir.cleanup()

    def test_point_in_polygon(self):
        self.assertEqual(self.m.region(35.2, 139.2), ['東京都', '千代田区'])
        self.assertEqual(self.m.region(35.5, 139.5), ['東京都', '中央区'])  # in the hole
        self.assertEqual(self.m.region(43.05, 141.05), ['北海道', '札幌市', '北区'])
        self.assertEqual(self.m.region(36.2, 138.2), ['長野県', '軽井沢町'])

    def test_off_the_coast_takes_the_nearest(self):
        self.assertEqual(self.m.region(43.12, 141.05), ['北海道', '札幌市', '北区'])
        self.assertEqual(self.m.region(10.0, 100.0), [])

    def test_undetermined_land_keeps_its_prefecture(self):
        self.assertEqual(self.m.region(44.05, 145.05), ['北海道'])


class ChinaTest(unittest.TestCase):
    def test_stations(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            write_csv(d / '01_车站索引.csv', ['站序号', '车站名'], [[0, '北京西'], [1, '叆河'], [2, '废站']])
            write_csv(d / '04_车站所属地区.csv', ['站序号', '车站名', '地区/城市'],
                      [[0, '北京西', '北京市 丰台区'], [1, '叆河', '']])
            write_csv(d / '17_12306官方站名表.csv',
                      ['简拼', '车站名', '电报码', '全拼', '拼音简写', '站序号', '地区码', '城市', '备注1', '备注2', '备注3'],
                      [['bjx', '北京西', 'BXP', 'beijingxi', 'bjx', 0, '0357', '北京', '', '', ''],
                       ['ah', '叆河', 'AHP', 'aihe', 'ah', 1, '', '丹东', '', '', '']])
            write_csv(d / '15_车站电报码.csv', ['车站', '电报码'], [])
            write_csv(d / '08_车站车次对照.csv', ['车站', '站序号', '车次', '车次序号', '是否办客', '该车在本站是第几站'],
                      [['北京西', 0, f'G{i}', i, '是', 1] for i in range(99)]
                      + [['叆河', 1, '4318/4319', 1, '是', 3], ['叆河', 1, 'X1', 2, '否', 3],
                         ['废站', 2, 'X1', 2, '否', 4]])
            write_csv(d / 'matched.csv', ['osm_type', 'osm_id', 'cr_name', 'trains_per_day'],
                      [['N', 1, '北京西', 99], ['W', 2, '北京西', 99]])
            coords = {'N1': (39.0, 116.0), 'W2': (39.002, 116.002)}
            stations = si.china(d, d / 'matched.csv', coords)
        self.assertEqual(stations, [
            {'c': 'cn', 'n': '北京西', 'r': ['北京市', '丰台区'], 'o': ['N1', 'W2'], 'p': [39.001, 116.001],
             't': 'BXP', 'l': ['beijingxi', 'bjx'], 'w': 1000},
            # No region of its own: 12306's city; one train of 99
            {'c': 'cn', 'n': '叆河', 'r': ['丹东'], 'o': [], 'p': None, 't': 'AHP', 'l': ['ah', 'aihe'], 'w': 151},
        ])


class JapanTest(unittest.TestCase):
    def test_grouped_by_code_and_distance(self):
        def node(i, lat, lon, **tags):
            return {'type': 'node', 'id': i, 'lat': lat, 'lon': lon, 'tags': {'railway': 'station', **tags}}

        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / 'japan.json').write_text(json.dumps({'elements': [
                # 新宿: JR and Keio share a code; the subway, 600 m off, has its own
                node(1, 35.690, 139.700, name='新宿'),
                node(2, 35.6905, 139.6995, name='新宿', operator='京王電鉄'),
                node(3, 35.6880, 139.6940, **{'name': '新宿駅', 'name:en': 'Shinjuku'}),
                # Two 府中, far apart
                node(4, 35.672, 139.480, name='府中'),
                node(5, 34.568, 133.236, **{'name': '府中', 'name:ja-Hira': 'ふちゅう'}),
                {'type': 'way', 'id': 6, 'center': {'lat': 35.0, 'lon': 135.0}, 'tags': {'railway': 'halt'}},
            ]}), encoding='utf-8')
            write_csv(d / 'codes.csv', ['osm_type', 'osm_id', 'name', 'codes', 'status'],
                      [['N', 1, '新宿', '22741', 'unique'], ['N', 2, '新宿', '22741;29342', 'several'],
                       ['N', 4, '府中', '23400', 'position']])
            write_csv(d / 'readings.csv', ['code', 'yomi'], [['22741', 'シンジュク'], ['23400', 'フチュウ']])
            write_csv(d / 'ranks.csv', ['element', 'rank'], [['N1', 20], ['N3', 5], ['N4', 2]])
            stations = si.japan(d / 'japan.json', d / 'codes.csv', d / 'readings.csv', d / 'ranks.csv', None)
        by_ref = {tuple(s['o']): s for s in stations}
        self.assertEqual(sorted(by_ref), [('N1', 'N2', 'N3'), ('N4',), ('N5',)])
        shinjuku = by_ref['N1', 'N2', 'N3']
        self.assertEqual(shinjuku['n'], '新宿')
        self.assertEqual(shinjuku['k'], ['22741', '29342'])
        self.assertEqual(shinjuku['y'], 'シンジュク')
        self.assertEqual(shinjuku['l'], ['Shinjuku'])
        self.assertEqual(shinjuku['w'], 1000)
        self.assertEqual(by_ref['N4',]['y'], 'フチュウ')
        # OSM's reading where Yahoo has none, as katakana
        self.assertEqual(by_ref['N5',]['y'], 'フチュウ')
        self.assertEqual(by_ref['N5',]['k'], [])
        self.assertEqual(by_ref['N5',]['w'], 0)
        # Every element of a station with a reading has it
        self.assertEqual(si.readings_rows(stations), [
            ('N', 1, 'シンジュク'), ('N', 2, 'シンジュク'), ('N', 3, 'シンジュク'), ('N', 4, 'フチュウ'), ('N', 5, 'フチュウ'),
        ])


# The stations the Worker's search tests find (src/worker/api/search.test.ts),
# once search-keys.mjs has added their keys
FIXTURE_STATIONS = [
    {'c': 'cn', 'n': '北京西', 'r': ['北京市', '丰台区'], 'o': ['N124205138'], 'p': [39.894, 116.322],
     't': 'BXP', 'l': ['beijingxi', 'bjx'], 'w': 1000},
    {'c': 'cn', 'n': '北京', 'r': ['北京市', '东城区'], 'o': ['N1'], 'p': [39.903, 116.427],
     't': 'BJP', 'l': ['beijing', 'bj'], 'w': 950},
    {'c': 'cn', 'n': '上海虹桥', 'r': ['上海市', '闵行区'], 'o': [], 'p': None, 't': 'AOH', 'l': ['shanghaihongqiao', 'shhq'],
     'w': 990},
    {'c': 'cn', 'n': '叆河', 'r': ['辽宁省', '丹东市', '凤城市'], 'o': [], 'p': None, 't': None, 'l': ['aihe', 'ah'], 'w': 151},
    {'c': 'jp', 'n': '渋谷', 'y': 'シブヤ', 'r': ['東京都', '渋谷区'], 'o': ['N241896099', 'N3623713008'],
     'p': [35.658713, 139.701637], 'k': ['22715'], 'l': ['Shibuya'], 'w': 980},
    {'c': 'jp', 'n': '新宿', 'y': 'シンジュク', 'r': ['東京都', '新宿区'], 'o': ['N1', 'N2'], 'p': [35.69, 139.7],
     'k': ['22741', '29342'], 'l': [], 'w': 1000},
    {'c': 'jp', 'n': '東京', 'y': 'トウキョウ', 'r': ['東京都', '千代田区'], 'o': ['N3'], 'p': [35.681, 139.767],
     'k': ['22828'], 'l': ['Tokyo'], 'w': 1000},
    {'c': 'jp', 'n': '新大阪', 'y': 'シンオオサカ', 'r': ['大阪府', '大阪市', '淀川区'], 'o': ['N4'], 'p': [34.733, 135.5],
     'k': ['23308'], 'l': [], 'w': 900},
    {'c': 'jp', 'n': '府中', 'y': 'フチュウ', 'r': ['東京都', '府中市'], 'o': ['N5'], 'p': [35.672, 139.48],
     'k': ['23400'], 'l': [], 'w': 300},
    {'c': 'jp', 'n': '府中', 'y': 'フチュウ', 'r': ['広島県', '府中市'], 'o': ['N6'], 'p': [34.568, 133.236],
     'k': ['23401'], 'l': [], 'w': 100},
    {'c': 'jp', 'n': '代々木', 'y': 'ヨヨギ', 'r': ['東京都', '渋谷区'], 'o': ['N7'], 'p': [35.683, 139.702],
     'k': ['22746'], 'l': [], 'w': 600},
    {'c': 'jp', 'n': '新橋', 'y': 'シンバシ', 'r': ['東京都', '港区'], 'o': ['N8'], 'p': [35.666, 139.758],
     'k': ['22792'], 'l': [], 'w': 700},
    {'c': 'jp', 'n': '名無し', 'y': None, 'r': [], 'o': ['N9'], 'p': [35.0, 135.0], 'k': [], 'l': [], 'w': 0},
]


class OutputTest(unittest.TestCase):
    def test_fixture_is_this_output(self):
        text = si.stations_json(FIXTURE_STATIONS)
        if os.environ.get('UPDATE_FIXTURES'):
            FIXTURE.write_text(text, encoding='utf-8')
        self.assertEqual(FIXTURE.read_text(encoding='utf-8'), text,
                         f'{FIXTURE.name} is stale: rerun with UPDATE_FIXTURES=1, then pnpm test')

    def test_a_station_a_line(self):
        text = si.stations_json(FIXTURE_STATIONS)
        self.assertEqual(json.loads(text), FIXTURE_STATIONS)
        self.assertEqual(len(text.splitlines()), len(FIXTURE_STATIONS) + 2)


if __name__ == '__main__':
    unittest.main()
