#!/usr/bin/env python3
"""Match OSM railway stations in Japan to Yahoo! 乗換案内 station codes, the ids
the map's API (https://map.shz.al/api/v1/doc.md) uses for timetables.

Usage: jp-station-codes.py --osm japan.json --cache search-cache.json
                           --out jp-station-codes.csv [--readings readings.csv]
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
5. Several left: those that are not railway stations are dropped. Yahoo's
   search lists airports, ports and water-bus piers as stations too, beside
   the railway station they share a name with, and has no timetable for them
   (the API answers 404, which the map would show as an error). The name
   settles most (rail_by_name): 成田空港(空路), 門司港(港), 豊洲(水上バス) are
   not railway stations, 那覇空港(鉄道), 花巻空港(東北本線), 関西空港駅(鉄道)
   are, and beside one of those, the airport of the same name is not,
   whether bare (宮崎空港) or after its region (那覇空港(沖縄)). The API is
   asked about the others' timetables only while they leave several: a bare
   name is the railway station at 豊洲 but the airport at 宮崎空港, and a
   region tells two railway stations apart at 平井(東京都). If one is left,
   that code ("name" if the names settled it, else "timetable").
6. Still several: a candidate whose suffix names the OSM operator decides
   ("operator"), e.g. 京阪電気鉄道 for 宇治(京阪線).
7. Still several: all of them are kept ("several"); a station's timetable
   view can offer each candidate's lines.

Search responses are cached (--cache), so a rerun only queries new names and
names cached without Yahoo's positions, or without its readings once the API
gives them; so is whether a code has a timetable, under the key
TIMETABLES_KEY. Writes one row per OSM feature:
osm_type (N/W/R), osm_id, name, codes (';'-separated), status;
and with --readings, one per code written: code, yomi (the station's reading
in katakana, from the same search results), for the station search
(station-index.py).
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
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = 'https://map.shz.al/api/v1/norikae/stations'
USER_AGENT = 'sharzy-map jp-station-codes (https://github.com/SharzyL/map)'
SEARCH_LIMIT = 10
# Yahoo's point for a station vs. one operator's OSM node of it
NEAR_KM = 3
PARALLEL = 3
# The cache's entry for which codes have a timetable; searched names hold no
# spaces (norm), so it cannot be mistaken for one.
TIMETABLES_KEY = ' timetables'

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


def has_timetable(url):
    # The API answers 404 for a code Yahoo has no timetable for (an airport,
    # a port); anything else that fails is retried, then raised.
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    for attempt in range(4):
        try:
            urllib.request.urlopen(request, timeout=120).read()
            return True
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return False
            last = error
        except Exception as error:
            last = error
        time.sleep(2 ** attempt)
    raise last


# Suffix words of Yahoo's names for what is not a railway station: an airport
# (成田空港(空路)), a ferry (中部国際空港(船)), a port (門司港(港)), a water bus
# (浅草(二天門・水上バス))
NOT_RAIL = {'空路', '船', '港', '水上バス'}


def rail_by_name(found):
    # Whether each candidate (by code) is a railway station by its name: True,
    # False, or None when its name does not say
    def says(r):
        base, suffix = split_suffix(r['name'])
        words = re.split(r'[・/]', suffix) if suffix else []
        if any(w in NOT_RAIL for w in words):
            return False
        if unicodedata.normalize('NFKC', base).endswith('駅') or any(w.endswith(('線', '鉄道')) for w in words):
            return True
        return None

    rail = {r['code']: says(r) for r in found}
    if any(rail.values()):
        # 宮崎空港 beside 宮崎空港(鉄道), 那覇空港(沖縄) beside 那覇空港(鉄道)
        for r in found:
            if rail[r['code']] is None and norm(split_suffix(r['name'])[0]).endswith('空港'):
                rail[r['code']] = False
    return rail


def left_open(found):
    # The codes whose timetable decides: those the names leave open, while
    # they leave several candidates
    rail = rail_by_name(found)
    left = [r for r in found if rail[r['code']] is not False]
    return {r['code'] for r in left if rail[r['code']] is None} if len(left) > 1 else set()


def railway(found, with_timetable):
    # The candidates that are railway stations, by name, then by timetable for
    # those the names leave open; and what decided ('name', 'timetable', or
    # None while several are left)
    rail = rail_by_name(found)
    left = [r for r in found if rail[r['code']] is not False]
    if len(left) < 2:
        return left, 'name'
    left = [r for r in left if rail[r['code']] or r['code'] in with_timetable]
    return left, ('timetable' if len(left) < 2 else None)


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
        self.readings = None

    def lacks(self, query, key):
        return any(key not in r for r in self.cache.get(query, [{}]))

    def gives_readings(self, query):
        # Whether the API answers with readings: searches one name cached
        # without them, and keeps its answer
        if self.readings is None:
            results = http_json(f'{self.api}?{urllib.parse.urlencode({"q": query})}').get('results', [])
            self.readings = bool(results) and all('yomi' in r for r in results)
            if self.readings:
                self.cache[query] = results
        return self.readings

    def fetch(self, queries):
        # Results cached before the API returned positions are searched again,
        # and those without readings once it gives them
        queries = set(queries)
        missing = {q for q in queries if self.lacks(q, 'yahoo_lat')}
        stale = sorted(q for q in queries - missing if self.lacks(q, 'yomi'))
        if stale and self.gives_readings(stale[0]):
            missing.update(q for q in stale if self.lacks(q, 'yomi'))
        missing = sorted(missing)
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

    def timetables(self, codes):
        # Which of the codes have a timetable, asking the API about the ones
        # not cached yet
        known = self.cache.setdefault(TIMETABLES_KEY, {})
        missing = sorted(set(codes) - known.keys())
        if missing:
            print(f'checking {len(missing)} codes for a timetable ({len(known)} cached)', file=sys.stderr)

        def one(code):
            return code, has_timetable(f'{self.api}/{urllib.parse.quote(code)}/timetables')

        with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
            known.update(pool.map(one, missing))
        if missing:
            self.save()
        return {code for code in codes if known[code]}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        json.dump(self.cache, open(self.path, 'w', encoding='utf-8'), ensure_ascii=False)

    def yomi(self):
        # Each station code's reading, from every cached search result
        found = {}
        for query, results in self.cache.items():
            if query == TIMETABLES_KEY:
                continue
            for r in results:
                if r.get('type') == 'station' and r.get('yomi'):
                    found.setdefault(r['code'], r['yomi'])
        return found

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
    parser.add_argument('--readings', help="where to write the codes' readings")
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

    def near(s):
        # A result Yahoo gives no position for cannot be ruled out
        return [r for r in search.candidates(s['name']) if (yahoo_km(s, r) or 0) <= NEAR_KM]

    # Whether the codes the names leave open have a timetable
    with_timetable = search.timetables({
        code for s in stations if (s['type'], s['id']) not in exceptions and len(near(s)) > 1
        for code in left_open(near(s))
    })

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
        found = near(s)
        if not found:
            status['far'] += 1
            far.append((s, min(candidates, key=lambda r: yahoo_km(s, r))))
            continue
        kind = 'unique' if len(candidates) == 1 else 'position'
        if len(found) > 1:
            found, decided = railway(found, with_timetable)
            kind = decided or kind
            if not found:
                status['not a railway station'] += 1
                continue
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
    if args.readings:
        yomi = search.yomi()
        codes = sorted({code for row in rows for code in row[3].split(';')}, key=lambda c: (len(c), c))
        with open(args.readings, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(['code', 'yomi'])
            writer.writerows((code, yomi[code]) for code in codes if code in yomi)
        print(f'{sum(code in yomi for code in codes)} of {len(codes)} codes with a reading, written to {args.readings}')
    for s, nearest in sorted(far, key=lambda f: yahoo_km(*f)):
        print(f"  far: {s['type']},{s['id']} {s['name']} ({s['operator'] or 'no operator'}): "
              f"nearest {nearest['name']} {nearest['code']} at {yahoo_km(s, nearest):.1f} km")


if __name__ == '__main__':
    sys.exit(main())
