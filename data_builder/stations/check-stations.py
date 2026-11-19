#!/usr/bin/env python3
"""Checks the station files the build makes before anything reads them, so a
broken match stops the build instead of reaching the tiles and the Worker.

Usage: check-stations.py cr <cr-station-trains.csv>
       check-stations.py jp <jp-station-codes.csv> <station-coords.csv>

cr: enough stations matched, each with a train count.
jp: enough stations matched; nearly every Yahoo code has a position; and the
OSM features of one code are one place (jp-station-codes.py keeps features
within 3 km of Yahoo's point of the code, so no two are more than 6 km apart).

Exits with 1 and says what is wrong.
"""

import collections
import csv
import math
import re
import sys

MIN_CR_ROWS = 3000
MIN_JP_ROWS = 8500
MAX_SPREAD_KM = 6
MAX_UNPLACED = 0.01


def rows(path):
    with open(path, encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def km(a, b):
    la, lb = math.radians(a[0]), math.radians(b[0])
    cos = math.sin(la) * math.sin(lb) + math.cos(la) * math.cos(lb) * math.cos(math.radians(a[1] - b[1]))
    return 6371 * math.acos(max(-1, min(1, cos)))


def check_ids(found, problems):
    bad = [r for r in found if r['osm_type'] not in ('N', 'W', 'R') or not r['osm_id'].isdigit()]
    if bad:
        problems.append(f'{len(bad)} rows without an OSM type and id, e.g. {bad[0]}')


def check_cr(path):
    found, problems = rows(path), []
    if len(found) < MIN_CR_ROWS:
        problems.append(f'{len(found)} rows, fewer than {MIN_CR_ROWS}')
    check_ids(found, problems)
    bad = [r for r in found if not re.fullmatch(r'\d+(\.\d)?', r['trains_per_day']) or not r['cr_name']]
    if bad:
        problems.append(f'{len(bad)} rows without a station name or train count, e.g. {bad[0]}')
    return problems


def check_jp(codes_path, coords_path):
    found, problems = rows(codes_path), []
    if len(found) < MIN_JP_ROWS:
        problems.append(f'{len(found)} rows, fewer than {MIN_JP_ROWS}')
    check_ids(found, problems)
    coords = {(r['osm_type'], r['osm_id']): (float(r['lat']), float(r['lon'])) for r in rows(coords_path)}
    features = collections.defaultdict(list)
    for r in found:
        if not r['codes']:
            problems.append(f'no codes for {r}')
        for code in r['codes'].split(';'):
            features[code].append((r['osm_type'], r['osm_id']))
    unplaced = [code for code, refs in features.items() if not any(ref in coords for ref in refs)]
    if len(unplaced) > len(features) * MAX_UNPLACED:
        problems.append(f'{len(unplaced)} of {len(features)} codes have no position, e.g. {unplaced[:5]}')
    for code, refs in features.items():
        points = [coords[ref] for ref in refs if ref in coords]
        spread = max((km(a, b) for a in points for b in points), default=0)
        if spread > MAX_SPREAD_KM:
            problems.append(f'the features of code {code} are {spread:.1f} km apart: {refs}')
    return problems


def main():
    args = sys.argv[1:]
    if args[:1] == ['cr'] and len(args) == 2:
        problems = check_cr(args[1])
    elif args[:1] == ['jp'] and len(args) == 3:
        problems = check_jp(args[1], args[2])
    else:
        sys.exit(__doc__)
    for problem in problems:
        print(f'check-stations: {problem}', file=sys.stderr)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
