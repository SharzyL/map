#!/usr/bin/env python3
"""List where the matched OSM stations are, for the Worker's station
positions.

Usage: station-coords.py <station csv> ... --osm <stations json> ... --out station-coords.csv

Reads every osm_type, osm_id in the station files (cr-station-trains.csv and
jp-station-codes.csv) and takes each feature's position from osm-stations.py's
files (china.json and japan.json, which the two were matched from): a node's
own, a way's or relation's `center`.

Writes one row per OSM feature: osm_type (N/W/R), osm_id, lat, lon. A feature
in neither file gets no row and is listed.
"""

import argparse
import csv
import json
import sys
from pathlib import Path


def read_refs(paths):
    refs = set()
    for path in paths:
        with open(path, encoding='utf-8') as f:
            refs |= {(r['osm_type'], int(r['osm_id'])) for r in csv.DictReader(f)}
    return refs


def read_coords(paths):
    coords = {}
    for path in paths:
        with open(path, encoding='utf-8') as f:
            for e in json.load(f)['elements']:
                c = e.get('center') or e
                coords[(e['type'][0].upper(), e['id'])] = (c['lat'], c['lon'])
    return coords


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('stations', nargs='+')
    parser.add_argument('--osm', nargs='+', required=True, help="osm-stations.py's china.json and japan.json")
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    refs = read_refs(args.stations)
    everywhere = read_coords(args.osm)
    coords = {ref: everywhere[ref] for ref in refs if ref in everywhere}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['osm_type', 'osm_id', 'lat', 'lon'])
        writer.writerows((t, i, *coords[t, i]) for t, i in sorted(coords))
    print(f'{len(coords)} of {len(refs)} OSM stations written to {out}')
    missing = sorted(refs - set(coords))
    if missing:
        print('  not among the OSM stations:', ' '.join(f'{t}{i}' for t, i in missing))


if __name__ == '__main__':
    sys.exit(main())
