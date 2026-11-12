#!/usr/bin/env python3
"""Count the passenger trains stopping at China Railway stations each day and
match the stations to OSM, for the export's station sizes.

Usage: cr-station-trains.py <timetable dir> [--osm stations.json] [--from YYYY-MM-DD]
                            [--out data/cr-station-trains.csv]

<timetable dir> is a lulutong timetable CSV export (01_车站索引.csv ...); it is
not committed, only the derived output is. Stations come from OSM through
Overpass (railway=station/halt in China, `out center tags`), or from a saved
copy of that response with --osm.

Matching is by name: OSM names without a trailing 站, where a station's own
name beats one that only lists it in alt_name or old_name (renamed
stations keep their old names there). OSM features of one name within 3 km
are one station (a node and an outline). When several stations share a
name, the one whose distances to matched neighbours on CR lines
(11_线路车站明细.csv) best fit the track kilometres wins. A match farther
from every matched neighbour than the track allows is reported; so far these
were errors in the line table, not in the match.

Trains per day are averaged over 14 days from --from (default today), from
each train's date range and running-day cycle (06, 09) and its stops (07).

Writes one row per OSM feature: osm_type (N/W/R), osm_id, cr_name, trains_per_day.
"""

import argparse
import collections
import csv
import datetime as dt
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS = 'https://overpass-api.de/api/interpreter'
OVERPASS_QUERY = (
    '[out:json][timeout:280];area["ISO3166-1"="CN"]->.cn;'
    'nwr["railway"~"^(station|halt)$"](area.cn);out center tags;'
)
URBAN = {'subway', 'light_rail', 'monorail', 'funicular', 'tram'}
SAME_STATION_KM = 3
NEIGHBOUR_FIT_KM = 30
WINDOW_DAYS = 14


def read(directory, name):
    with open(Path(directory) / name, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def norm(name):
    return re.sub(r'(火车站|铁路站|站)$', '', name.strip())


def km(a, b):
    la, lb = math.radians(a['lat']), math.radians(b['lat'])
    cos = math.sin(la) * math.sin(lb) + math.cos(la) * math.cos(lb) * math.cos(math.radians(a['lon'] - b['lon']))
    return 6371 * math.acos(max(-1, min(1, cos)))


def osm_stations(path):
    if path:
        data = json.load(open(path, encoding='utf-8'))
    else:
        request = urllib.request.Request(
            OVERPASS,
            data=urllib.parse.urlencode({'data': OVERPASS_QUERY}).encode(),
            headers={'User-Agent': 'sharzy-map cr-station-trains (https://github.com/SharzyL/map)'},
        )
        data = json.load(urllib.request.urlopen(request, timeout=300))
    stations = []
    for e in data['elements']:
        t = e.get('tags', {})
        if t.get('station') in URBAN or t.get('subway') == 'yes' or t.get('light_rail') == 'yes':
            continue
        c = e.get('center') or e
        primary = {norm(t[k]) for k in ('name', 'name:zh', 'name:zh-Hans') if t.get(k)}
        other = {norm(t[k]) for k in ('official_name', 'old_name') if t.get(k)}
        other |= {norm(n) for n in t.get('alt_name', '').split(';') if n}
        stations.append({
            'type': e['type'][0].upper(), 'id': e['id'], 'lat': c['lat'], 'lon': c['lon'],
            'primary': primary, 'other': other - primary,
        })
    return stations


def candidate_groups(name, by_primary, by_other):
    found = by_primary.get(name) or by_other.get(name, [])
    groups = []
    for station in found:
        for group in groups:
            if km(group[0], station) < SAME_STATION_KM:
                group.append(station)
                break
        else:
            groups.append([station])
    return groups


def match_stations(timetable, stations):
    by_primary, by_other = collections.defaultdict(list), collections.defaultdict(list)
    for s in stations:
        for n in s['primary']:
            by_primary[n].append(s)
        for n in s['other']:
            by_other[n].append(s)

    neighbours = collections.defaultdict(list)
    lines = collections.defaultdict(list)
    for row in read(timetable, '11_线路车站明细.csv'):
        if row['线路代码'] != '0':
            lines[row['线路代码']].append(row)
    for line in lines.values():
        line.sort(key=lambda r: int(r['顺序']))
        for a, b in zip(line, line[1:]):
            distance = abs(float(b['里程']) - float(a['里程']))
            neighbours[a['车站']].append((b['车站'], distance))
            neighbours[b['车站']].append((a['车站'], distance))

    names = {r['车站名'] for r in read(timetable, '01_车站索引.csv')} | set(neighbours)
    match, status = {}, {}
    for name in names:
        groups = candidate_groups(name, by_primary, by_other)
        if len(groups) == 1:
            match[name], status[name] = groups[0], 'unique'
        elif not groups:
            status[name] = 'missing'
    # Shared names: the candidate whose distances to matched neighbours best fit the track.
    for _ in range(2):
        for name in names:
            if status.get(name) in ('unique', 'missing'):
                continue
            best = None
            for group in candidate_groups(name, by_primary, by_other):
                errors = [
                    abs(km(group[0], match[other][0]) - distance)
                    for other, distance in neighbours[name]
                    if status.get(other) in ('unique', 'resolved')
                ]
                if errors and (best is None or sum(errors) / len(errors) < best[0]):
                    best = (sum(errors) / len(errors), group)
            if best and best[0] < NEIGHBOUR_FIT_KM:
                match[name], status[name] = best[1], 'resolved'
            else:
                match.pop(name, None)
                status[name] = 'ambiguous'
    return match, status, neighbours


def trains_per_day(timetable, start):
    window = [start + dt.timedelta(days=i) for i in range(WINDOW_DAYS)]
    cycles = {r['周期号']: (int(r['周期天数']), int(r['位掩码'])) for r in read(timetable, '09_开行周期规则.csv')}
    weight = {}
    for r in read(timetable, '06_车次信息.csv'):
        first, last = dt.date.fromisoformat(r['开行起']), dt.date.fromisoformat(r['开行止'])
        period, mask = cycles.get(r['周期号'], (1, 1))
        days = sum(first <= d <= last for d in window) / len(window)
        weight[r['车次']] = days * bin(mask).count('1') / period
    counts = collections.Counter()
    for r in read(timetable, '07_车次停站时刻表.csv'):
        counts[r['车站']] += weight.get(r['车次'], 0)
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('timetable')
    parser.add_argument('--osm', help='saved Overpass response (default: query Overpass)')
    parser.add_argument('--from', dest='start', type=dt.date.fromisoformat, default=dt.date.today())
    parser.add_argument('--out', default=Path(__file__).resolve().parents[2] / 'data' / 'cr-station-trains.csv')
    args = parser.parse_args()

    match, status, neighbours = match_stations(args.timetable, osm_stations(args.osm))
    counts = trains_per_day(args.timetable, args.start)
    timetable_names = set(counts)

    rows = []
    for name in sorted(timetable_names & set(match)):
        for s in match[name]:
            rows.append((s['type'], s['id'], name, round(counts[name], 1)))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['osm_type', 'osm_id', 'cr_name', 'trains_per_day'])
        writer.writerows(sorted(rows, key=lambda r: (r[0], r[1])))

    by_status = collections.Counter(status.get(n, 'missing') for n in timetable_names)
    suspects = []
    for name in sorted(timetable_names & set(match)):
        checks = [(o, d, km(match[name][0], match[o][0])) for o, d in neighbours[name] if o in match and o in timetable_names]
        if checks and all(x > d * 1.1 + 5 for _, d, x in checks):
            suspects.append(f"{name} ({', '.join(f'{o} {d:.0f} km by track, {x:.0f} km apart' for o, d, x in checks)})")
    print(f'{len(timetable_names)} timetable stations: {by_status["unique"]} matched by name, '
          f'{by_status["resolved"]} by neighbours, {by_status["ambiguous"]} ambiguous, {by_status["missing"]} not in OSM')
    print(f'{len(rows)} OSM features written to {out}')
    for line in suspects:
        print('  farther from every neighbour than the track allows:', line)
    missing = sorted(n for n in timetable_names if status.get(n) in ('ambiguous', 'missing'))
    if missing:
        print('  unmatched:', ', '.join(missing))


if __name__ == '__main__':
    sys.exit(main())
