#!/usr/bin/env python3
"""Match OSM railway stations in Japan to Yahoo! 乗換案内 station codes, the ids
the map's API (https://map.shz.al/api/v1/doc.md) uses for timetables.

Usage: jp-station-codes.py --osm japan.json --cache search-cache.json
                           --out jp-station-codes.csv
                           [--exceptions jp-station-exceptions.csv] [--api URL]

The OSM stations (railway=station/halt in Japan, in the shape of an Overpass
`out center tags` response) come from the railway extract through
osm-stations.py. OSM has no Yahoo codes and Wikidata has no property for them,
so stations are matched by name through the API's station search
(/api/v1/norikae/stations?q=), then checked against Yahoo's position of each
result (yahoo_lat, yahoo_lon). Yahoo names a station shared by several
prefectures 府中(東京都), 府中(広島県), and one shared within a prefecture by
line or company, 宇治(奈良線), 宇治(京阪線), 新宿(東京メトロ). For each OSM
station (name:ja, else name):

1. A row in the exceptions file decides ("exception"); empty codes leave the
   station unmatched. The file is for what the rules below get wrong.
2. Results whose name, without the parenthesised suffix, equals the OSM name
   (NFKC, ケ/ヶ alike, no trailing 駅) are candidates. The search returns at
   most 10 results, so when none matches and the list was full, the name is
   searched again with 駅 appended. A name with a bracketed subtitle that
   Yahoo leaves out, 押上〈スカイツリー前〉, is searched without it.
3. Candidates farther than NEAR_KM from the OSM station are dropped: they
   are same-named stations elsewhere. If none is left, the station gets no
   row and is reported as far, to be looked at and maybe added as an
   exception.
4. One left: that code ("unique" if the name had one candidate, "position"
   if the distance picked it).
5. Several left: a candidate whose suffix names the OSM operator decides
   ("operator"), e.g. 京阪電気鉄道 for 宇治(京阪線).
6. Still several: all of them are kept ("several"); a station's timetable
   view can offer each candidate's lines.

Search responses are cached (--cache), so a rerun only queries new names and
names cached without Yahoo's positions. Writes one row per OSM feature:
osm_type (N/W/R), osm_id, name, codes (';'-separated), status.
"""

import argparse
import collections
import concurrent.futures
import csv
import json
import math
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://map.shz.al/api/v1/norikae/stations'
USER_AGENT = 'sharzy-map jp-station-codes (https://github.com/SharzyL/map)'
SEARCH_LIMIT = 10
# Yahoo's point for a station vs. one operator's OSM node of it
NEAR_KM = 3
PARALLEL = 3

# Yahoo's short names for operators whose OSM operator tag is the legal name.
OPERATOR_ALIASES = {
    '東京地下鉄': ['東京メトロ'],
    '東京都交通局': ['都営'],
    '横浜市交通局': ['横浜市営'],
    '名古屋市交通局': ['名古屋市営'],
    '京都市交通局': ['京都市営'],
    '大阪市高速電気軌道': ['大阪メトロ', 'Osaka Metro'],
    '神戸市交通局': ['神戸市営'],
    '福岡市交通局': ['福岡市地下鉄', '福岡市営'],
    '札幌市交通局': ['札幌市営'],
    '仙台市交通局': ['仙台市営'],
    '大阪高速鉄道': ['大阪モノレール'],
    '富山地方鉄道': ['富山地鉄'],
    '東日本旅客鉄道': ['JR'],
    '西日本旅客鉄道': ['JR'],
    '東海旅客鉄道': ['JR'],
    '北海道旅客鉄道': ['JR'],
    '九州旅客鉄道': ['JR'],
    '四国旅客鉄道': ['JR'],
}


def norm(name):
    name = unicodedata.normalize('NFKC', name).replace('ヶ', 'ケ').replace('ヵ', 'カ').replace(' ', '')
    return re.sub(r'駅$', '', name)


def without_subtitle(name):
    # '押上〈スカイツリー前〉' -> '押上'; None when there is no subtitle
    base = re.sub(r'\s*[(（〈<].*[)）〉>]$', '', unicodedata.normalize('NFKC', name))
    return base if base and base != unicodedata.normalize('NFKC', name) else None


def split_suffix(name):
    match = re.match(r'^(.*?)\((.+)\)$', unicodedata.normalize('NFKC', name))
    return (match.group(1), match.group(2)) if match else (name, None)


def http_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(request, timeout=120))
        except Exception as error:  # network hiccups: retry with backoff
            last = error
            time.sleep(2 ** attempt)
    raise last


def osm_stations(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    stations = []
    for e in data['elements']:
        t = e.get('tags', {})
        name = t.get('name:ja') or t.get('name')
        if not name:
            continue
        c = e.get('center') or e
        stations.append({
            'type': e['type'][0].upper(), 'id': e['id'], 'lat': c['lat'], 'lon': c['lon'],
            'name': name, 'operator': t.get('operator', ''),
        })
    return stations


class Search:
    def __init__(self, cache_path, api):
        self.path = Path(cache_path)
        self.api = api
        self.cache = json.load(open(self.path, encoding='utf-8')) if self.path.exists() else {}

    def fetch(self, queries):
        # Results cached before the API returned positions are searched again
        missing = sorted({q for q in queries if any('yahoo_lat' not in r for r in self.cache.get(q, [{}]))})
        if missing:
            print(f'searching {len(missing)} names ({len(self.cache)} cached)', file=sys.stderr)

        def one(q):
            return q, http_json(f'{self.api}?{urllib.parse.urlencode({"q": q})}').get('results', [])

        with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
            for done, (q, results) in enumerate(pool.map(one, missing), 1):
                self.cache[q] = results
                if done % 500 == 0:
                    print(f'  {done} of {len(missing)}', file=sys.stderr)
                    self.save()
        self.save()

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        json.dump(self.cache, open(self.path, 'w', encoding='utf-8'), ensure_ascii=False)

    def candidates(self, name):
        def matching(results):
            return [r for r in results if r['type'] == 'station' and norm(split_suffix(r['name'])[0]) == norm(name)]

        results = self.cache.get(norm(name), [])
        found = matching(results)
        if not found and len(results) >= SEARCH_LIMIT:
            found = matching(self.cache.get(norm(name) + '駅', []))
        if not found and without_subtitle(name):
            found = self.candidates(without_subtitle(name))
        return found


def km(a, b):
    la, lb = math.radians(a['lat']), math.radians(b['lat'])
    cos = math.sin(la) * math.sin(lb) + math.cos(la) * math.cos(lb) * math.cos(math.radians(a['lon'] - b['lon']))
    return 6371 * math.acos(max(-1, min(1, cos)))


def yahoo_km(station, result):
    if result.get('yahoo_lat') is None:
        return None
    return km(station, {'lat': result['yahoo_lat'], 'lon': result['yahoo_lon']})


def read_exceptions(path):
    if not Path(path).exists():
        return {}
    with open(path, encoding='utf-8') as f:
        return {(r['osm_type'], int(r['osm_id'])): r['codes'] for r in csv.DictReader(f)}


def names_operator(suffix, operator):
    if not suffix or not operator:
        return False
    core = re.sub(r'(線|電鉄|鉄道)$', '', suffix.split('・')[-1])
    for legal, aliases in OPERATOR_ALIASES.items():
        if legal in operator and any(alias in suffix for alias in aliases):
            return True
    return len(core) >= 2 and core[:2] in operator


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--osm', required=True, help="osm-stations.py's japan.json")
    parser.add_argument('--cache', required=True, help='station searches kept between runs')
    parser.add_argument('--exceptions', default=Path(__file__).with_name('jp-station-exceptions.csv'))
    parser.add_argument('--api', default=API, help=f'station search endpoint (default: {API})')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    stations = osm_stations(args.osm)
    exceptions = read_exceptions(args.exceptions)
    search = Search(args.cache, args.api)
    search.fetch(norm(s['name']) for s in stations)
    # Second round: names whose exact match fell off a full result list.
    search.fetch(norm(s['name']) + '駅' for s in stations
                 if not search.candidates(s['name']) and len(search.cache.get(norm(s['name']), [])) >= SEARCH_LIMIT)
    # Third: names without their bracketed subtitle (then with 駅, as above).
    bases = [without_subtitle(s['name']) for s in stations if not search.candidates(s['name'])]
    search.fetch(norm(b) for b in bases if b)
    search.fetch(norm(b) + '駅' for b in bases
                 if b and not search.candidates(b) and len(search.cache.get(norm(b), [])) >= SEARCH_LIMIT)

    rows, status, far = [], collections.Counter(), []
    for s in stations:
        if (s['type'], s['id']) in exceptions:
            status['exception'] += 1
            if exceptions[s['type'], s['id']]:
                rows.append((s['type'], s['id'], s['name'], exceptions[s['type'], s['id']], 'exception'))
            continue
        candidates = search.candidates(s['name'])
        if not candidates:
            status['no match'] += 1
            continue
        # A result Yahoo gives no position for cannot be ruled out
        found = [r for r in candidates if (yahoo_km(s, r) or 0) <= NEAR_KM]
        if not found:
            status['far'] += 1
            far.append((s, min(candidates, key=lambda r: yahoo_km(s, r))))
            continue
        kind = 'unique' if len(candidates) == 1 else 'position'
        if len(found) > 1:
            kind = 'operator'
            by_operator = [r for r in found if names_operator(split_suffix(r['name'])[1], s['operator'])]
            if len(by_operator) == 1:
                found = by_operator
            else:
                kind = 'several'
        status[kind] += 1
        rows.append((s['type'], s['id'], s['name'], ';'.join(r['code'] for r in found), kind))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['osm_type', 'osm_id', 'name', 'codes', 'status'])
        writer.writerows(sorted(rows, key=lambda r: (r[0], r[1])))
    print(f'{len(stations)} OSM stations with a name: ' + ', '.join(f'{k} {v}' for k, v in status.most_common()))
    print(f'{len(rows)} rows written to {out}')
    for s, nearest in sorted(far, key=lambda f: yahoo_km(*f)):
        print(f"  far: {s['type']},{s['id']} {s['name']} ({s['operator'] or 'no operator'}): "
              f"nearest {nearest['name']} {nearest['code']} at {yahoo_km(s, nearest):.1f} km")


if __name__ == '__main__':
    sys.exit(main())
