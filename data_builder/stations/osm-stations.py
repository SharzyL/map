#!/usr/bin/env python3
"""List the railway stations of China and Japan in the railway extract, for
cr-station-trains.py, jp-station-codes.py and station-coords.py.

Usage: osm-stations.py <extract.osm.pbf> <out-dir>

<extract.osm.pbf> is the railway extract cut to the box around China and
Japan. Writes <out-dir>/china.json and <out-dir>/japan.json in the shape of an
Overpass `out center tags` response, which the matchers read with --osm: every
node, way and relation with railway=station or halt, with its tags. A way's
`center` is the centre of its bounding box, as Overpass gives it. A relation's
is that of its member nodes and ways in the extract; a relation none of whose
members is there (an outline of untagged ways) is asked from the OSM API, and
left out with a warning when that fails.

The extract has no borders, so the two regions are coarse rules on the
position. China is the box without Japan and Taiwan, whose names in kanji and
hanzi could match a Chinese station's; what else the box holds (Korea, Laos,
Mongolia, ...) stays, and matches only where the timetable has the station.
Japan is cut by latitude bands that leave out Korea, Russia, Taiwan and China:
each of its stations costs a station search, and none outside can match.

The same extract gives the same files, byte for byte. Needs pyosmium.
"""

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import osmium

API = 'https://api.openstreetmap.org/api/0.6/relation/{}/full.json'
USER_AGENT = 'sharzy-map osm-stations (https://github.com/SharzyL/map)'
STATIONS = ('station', 'halt')
# China and Japan, with what lies in between (Korea, Taiwan, ...)
BOX = (73, 17, 146, 54)
TYPES = {'node': 0, 'way': 1, 'relation': 2}


def in_box(lat, lon):
    return BOX[0] <= lon <= BOX[2] and BOX[1] <= lat <= BOX[3]


def in_china(lat, lon):
    """Not in Japan or Taiwan: the box takes them in."""
    japan = (lon >= 129 and lat <= 41.8) or (lon >= 139 and lat <= 45.7)
    taiwan = lon >= 119.9 and lat <= 25.4
    return in_box(lat, lon) and not (japan or taiwan)


def in_japan(lat, lon):
    """West of each band lie Taiwan (its railways end at 122.0°E; Yonaguni
    has none), Korea (to 129.6°E, north of 34.3°N), and Russia's coast."""
    if lat < 24 or lat > 45.6 or lon > 146:
        return False
    if lat < 34.3:
        return lon >= 122.9
    if lat < 36:
        return lon >= 130
    if lat < 41.6:
        return lon >= 132
    return lon >= 139.5


class Bounds:
    def __init__(self):
        self.box = None

    def add(self, lat, lon):
        b = self.box
        self.box = (lat, lon, lat, lon) if b is None else (min(b[0], lat), min(b[1], lon), max(b[2], lat), max(b[3], lon))

    def merge(self, other):
        if other.box:
            self.add(other.box[0], other.box[1])
            self.add(other.box[2], other.box[3])

    def centre(self):
        b = self.box
        return {'lat': round((b[0] + b[2]) / 2, 7), 'lon': round((b[1] + b[3]) / 2, 7)}


class Relations(osmium.SimpleHandler):
    """The station relations and their members; relations come last in the
    file, so they are read before the nodes and ways they list."""

    def __init__(self):
        super().__init__()
        self.found = {}  # id -> (tags, [(type, ref)])

    def relation(self, r):
        if r.tags.get('railway') in STATIONS:
            self.found[r.id] = (dict(r.tags), [(m.type, m.ref) for m in r.members])


class Stations(osmium.SimpleHandler):
    def __init__(self, relations):
        super().__init__()
        self.elements = []
        self.member_nodes = {ref for _, members in relations.values() for t, ref in members if t == 'n'}
        self.member_ways = {ref for _, members in relations.values() for t, ref in members if t == 'w'}
        self.node_at = {}
        self.way_bounds = {}

    def node(self, n):
        if n.id in self.member_nodes:
            self.node_at[n.id] = (n.location.lat, n.location.lon)
        if n.tags.get('railway') in STATIONS:
            self.elements.append({
                'type': 'node', 'id': n.id, 'lat': round(n.location.lat, 7), 'lon': round(n.location.lon, 7),
                'tags': dict(n.tags),
            })

    def way(self, w):
        station = w.tags.get('railway') in STATIONS
        if not station and w.id not in self.member_ways:
            return
        bounds = Bounds()
        for node in w.nodes:
            if node.location.valid():
                bounds.add(node.location.lat, node.location.lon)
        if bounds.box is None:
            return
        if w.id in self.member_ways:
            self.way_bounds[w.id] = bounds
        if station:
            self.elements.append({'type': 'way', 'id': w.id, 'center': bounds.centre(), 'tags': dict(w.tags)})


def api_bounds(relation_id):
    """The relation's extent from the OSM API: its member nodes and the nodes
    of its member ways."""
    request = urllib.request.Request(API.format(relation_id), headers={'User-Agent': USER_AGENT})
    for attempt in range(4):
        try:
            data = json.load(urllib.request.urlopen(request, timeout=60))
            break
        except Exception as error:  # network hiccups: retry with backoff
            if attempt == 3:
                print(f'  relation {relation_id}: {error}; left out', file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
    bounds = Bounds()
    for e in data['elements']:
        if e['type'] == 'node':
            bounds.add(e['lat'], e['lon'])
    return bounds if bounds.box else None


def position(element):
    at = element.get('center') or element
    return at['lat'], at['lon']


def write(path, elements):
    # One element a line, so two versions can be compared
    lines = [json.dumps(e, ensure_ascii=False, sort_keys=True) for e in elements]
    Path(path).write_text('{"elements": [\n' + ',\n'.join(lines) + '\n]}\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('extract')
    parser.add_argument('out')
    args = parser.parse_args()

    relations = Relations()
    relations.apply_file(args.extract)
    stations = Stations(relations.found)
    stations.apply_file(args.extract, locations=True, idx='flex_mem')

    elements = stations.elements
    asked = 0
    for relation_id, (tags, members) in sorted(relations.found.items()):
        bounds = Bounds()
        for kind, ref in members:
            if kind == 'n' and ref in stations.node_at:
                bounds.add(*stations.node_at[ref])
            elif kind == 'w' and ref in stations.way_bounds:
                bounds.merge(stations.way_bounds[ref])
        if bounds.box is None:
            asked += 1
            bounds = api_bounds(relation_id)
            if bounds is None:
                continue
        elements.append({'type': 'relation', 'id': relation_id, 'center': bounds.centre(), 'tags': tags})
    elements.sort(key=lambda e: (TYPES[e['type']], e['id']))

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    counts = {}
    for name, inside in (('china', in_china), ('japan', in_japan)):
        chosen = [e for e in elements if inside(*position(e))]
        write(out / f'{name}.json', chosen)
        counts[name] = len(chosen)
    print(f'{len(elements)} stations in {args.extract} ({len(relations.found)} relations, {asked} asked from the OSM API): '
          f'{counts["china"]} in China\'s box, {counts["japan"]} in Japan, written to {out}')


if __name__ == '__main__':
    sys.exit(main())
