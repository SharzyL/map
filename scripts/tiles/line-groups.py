#!/usr/bin/env python3
"""Group railway ways into lines, using MLIT's railway data (国土数値情報 N02) as the reference in Japan.

Usage: line-groups.py <extract.opl> <RailroadSection.geojson> <Station.geojson> <out_dir>

The extract is the railway extract with node locations on its ways
(osmium add-locations-to-ways -n --ignore-missing-nodes -f opl). The two
GeoJSON files come from N02's UTF-8 folder (CC BY 4.0, 国土交通省 国土数値情報).

In Japan a line is an official line (路線) of N02. Each way joins the N02
line its geometry follows, with its name and operator breaking ties between
parallel lines, and also any other N02 line drawn on the same track (a line
running on another's track, such as 京成成田空港線 on 北総線). The line's
name comes from OSM, which keeps 本線 and company prefixes (山陰本線,
東武伊勢崎線), and other names on its ways (総武緩行線, 横須賀線) become
aliases. Ways outside N02 are grouped by their route=railway relation, else
by name and operator along connected track.
Writes:
  line_groups.csv      group_id,line_id,source,operator,legal_name,name,aliases
  line_group_ways.csv  group_id,way_id,rank (a way on shared track is in several
                       groups; rank 0 is the line it follows, then the lines
                       drawn on the same track)

line_id is stable across runs for N02 lines (a hash of the operator and the
official name) and empty for the other groups.
  review.csv           one row per N02 line, with lengths and checks
  unmatched.csv        named ways in Japan that no N02 line took, by name
"""

import csv
import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ESCAPE = re.compile(r'%([0-9a-fA-F]+)%')
NODE = re.compile(r'n(\d+)x([-\d.]+)y([-\d.]+)')


def unescape(value):
    return ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), value)


def parse_tags(field):
    tags = {}
    for item in field.split(',') if field else []:
        key, _, value = item.partition('=')
        tags[unescape(key)] = unescape(value)
    return tags


LINE_RAILWAYS = {'rail', 'light_rail', 'subway', 'monorail', 'narrow_gauge', 'funicular', 'tram'}
# A way follows an N02 line where its samples lie within this distance of
# the line, running in the same direction. N02 is drawn from 1:25,000 maps
# with one line per route, so double and quadruple track sit 5-30 m off it.
MATCH_RADIUS_M = 45
MAX_ANGLE_DEG = 35
# Two N02 lines share track where they lie this close to each other.
SHARED_TRACK_M = 3
SAMPLE_STEP_M = 40
MAX_SAMPLES = 24
GRID_DEG = 0.01
JAPAN_CELL_DEG = 0.25
ALIAS_MIN_M = 3000
ALIAS_MIN_SHARE = 0.1
GENERIC_NAMES = {'貨物線', '連絡線', '支線'}
STRUCTURE_NAME = re.compile(r'(トンネル|隧道|橋梁|鉄橋)$')
M_PER_DEG = 111320


def length_m(points):
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        k = math.cos(math.radians((y1 + y2) / 2))
        total += math.hypot((x2 - x1) * k, y2 - y1) * M_PER_DEG
    return total


def samples(points):
    """Points every SAMPLE_STEP_M along the line (at most MAX_SAMPLES), each with its bearing."""
    total = length_m(points)
    if total == 0:
        return []
    count = max(1, min(MAX_SAMPLES, round(total / SAMPLE_STEP_M)))
    targets = [(i + 0.5) * total / count for i in range(count)]
    out = []
    walked = 0.0
    t = 0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        k = math.cos(math.radians((y1 + y2) / 2))
        step = math.hypot((x2 - x1) * k, y2 - y1) * M_PER_DEG
        while t < count and targets[t] <= walked + step:
            f = (targets[t] - walked) / step if step else 0
            out.append((x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, math.atan2(y2 - y1, (x2 - x1) * k)))
            t += 1
        walked += step
    return out


def angle_ok(a, b):
    d = abs(a - b) % math.pi
    return min(d, math.pi - d) <= math.radians(MAX_ANGLE_DEG)


def point_segment_m(x, y, x1, y1, x2, y2):
    k = math.cos(math.radians(y))
    ax, ay, bx, by = (x1 - x) * k, y1 - y, (x2 - x) * k, y2 - y
    dx, dy = bx - ax, by - ay
    seg = dx * dx + dy * dy
    f = 0.0 if seg == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg))
    return math.hypot(ax + f * dx, ay + f * dy) * M_PER_DEG


class Grid:
    def __init__(self):
        self.cells = defaultdict(list)

    def add(self, item, x1, y1, x2, y2, pad_deg):
        for gx in range(
            math.floor((min(x1, x2) - pad_deg) / GRID_DEG), math.floor((max(x1, x2) + pad_deg) / GRID_DEG) + 1
        ):
            for gy in range(
                math.floor((min(y1, y2) - pad_deg) / GRID_DEG), math.floor((max(y1, y2) + pad_deg) / GRID_DEG) + 1
            ):
                self.cells[(gx, gy)].append(item)

    def near(self, x, y):
        return self.cells.get((math.floor(x / GRID_DEG), math.floor(y / GRID_DEG)), ())


class Components:
    def __init__(self):
        self.parent = {}

    def find(self, a):
        self.parent.setdefault(a, a)
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a, b):
        self.parent[self.find(a)] = self.find(b)


# Names. N02 has official names: 総武線, 山陰線, 伊勢崎線, 本線 (京成).
# OSM ways say 総武本線, JR山陰線, 東武伊勢崎線, 京成本線, and also carry
# service names (総武緩行線) and pairs (東海道本線（横須賀線）, JR外房・内房線).
FULL_PARENS = re.compile(r'^(.*?)（(.+)）$')
HALF_PARENS = re.compile(r'^(.*?)\s*\((.+)\)$')
LATIN = re.compile(r'[A-Za-z]')


def name_parts(name):
    """The line names a way name stands for: 東海道本線（横須賀線） gives both, JR外房・内房線 gives 外房線 and 内房線."""
    name = name.split(';')[0].strip()
    parts = [name]
    for pattern in (FULL_PARENS, HALF_PARENS):
        m = pattern.match(name)
        if m:
            parts = [m.group(1).strip()] + ([m.group(2).strip()] if not LATIN.search(m.group(2)) else [])
            break
    out = []
    for part in parts:
        part = re.sub(r'^JR\s*', '', part)
        if '・' in part and part.endswith('線'):
            pieces = part.split('・')
            out += [p if p.endswith('線') else p + '線' for p in pieces[:-1]] + [pieces[-1]]
        elif part:
            out.append(part)
    return out


def name_key(name):
    return re.sub(r'(本線|線)$', '', name)


def name_prefix(name, legal):
    """What a name puts before an official name (東武 in 東武伊勢崎線), or None if it doesn't end with it."""
    key = name_key(legal)
    stem = name_key(name) if key else name
    end = key or legal
    if stem != end and stem.endswith(end):
        return stem[: -len(end)]
    return None


def line_id_of(operator, official):
    """A line id that stays the same across runs: jp- and a hash of the operator and the official name."""
    return 'jp-' + hashlib.sha1(f'{operator}/{official}'.encode()).hexdigest()[:10]


def operator_key(operator):
    return re.sub(r'\s*\(.*\)$', '', operator or '').strip()


def common_name(official):
    """N02's subway names without their number: 3号線銀座線 and 6号線(堺筋線) are 銀座線 and 堺筋線."""
    m = re.match(r'^\d+号線[（(]?(.+?)[)）]?$', official)
    return m.group(1) if m else official


def names_line(name, operator, official):
    """Whether a way name is a spelling of the official line.

    That is the same name up to 本, or with a company prefix (東武伊勢崎線, 名鉄名古屋本線, Osaka Metro堺筋線).
    """
    official = common_name(official)
    if name == official or name_key(name) == name_key(official):
        return True
    prefix = name_prefix(name, official)
    return bool(prefix) and (prefix[0] == operator[:1] or re.fullmatch(r'[A-Za-z .]+', prefix) is not None)


def read_extract(path):
    ways = {}
    relations = {}
    with open(path, encoding='utf-8') as src:
        for line in src:
            fields = line.rstrip('\n').split(' ')
            kind = fields[0][0]
            if kind not in 'wr':
                continue
            tags, nodes, members = {}, [], []
            for field in fields[1:]:
                if field.startswith('T'):
                    tags = parse_tags(field[1:])
                elif field.startswith('N') and kind == 'w':
                    nodes = [(int(m.group(1)), float(m.group(2)), float(m.group(3))) for m in NODE.finditer(field)]
                elif field.startswith('M') and kind == 'r':
                    for member in field[1:].split(',') if len(field) > 1 else []:
                        ref = member.partition('@')[0]
                        if ref.startswith('w'):
                            members.append(int(ref[1:]))
            if kind == 'w':
                if tags.get('railway') in LINE_RAILWAYS and 'service' not in tags and len(nodes) >= 2:
                    points = [(n[1], n[2]) for n in nodes]
                    ways[int(fields[0][1:])] = (tags, [n[0] for n in nodes], points, length_m(points))
            elif tags.get('route') == 'railway':
                relations[int(fields[0][1:])] = (tags, list(dict.fromkeys(members)))
    return ways, relations


def read_n02(sections_path, stations_path):
    lines = {}  # (operator, official name) -> list of coordinate lists
    with open(sections_path, encoding='utf-8') as src:
        features = json.load(src)['features']
    for feature in features:
        p = feature['properties']
        geometry = feature['geometry']
        coords = [geometry['coordinates']] if geometry['type'] == 'LineString' else geometry['coordinates']
        lines.setdefault((p['N02_004'], p['N02_003']), []).extend(coords)
    stations = defaultdict(list)
    with open(stations_path, encoding='utf-8') as src:
        features = json.load(src)['features']
    for feature in features:
        p = feature['properties']
        coords = feature['geometry']['coordinates']
        coords = coords if feature['geometry']['type'] == 'LineString' else coords[0]
        x = sum(c[0] for c in coords) / len(coords)
        y = sum(c[1] for c in coords) / len(coords)
        stations[(p['N02_004'], p['N02_003'])].append((p['N02_005'], x, y))
    return lines, stations


def line_ends(parts, stations):
    """The stations at the N02 line's open ends (vertices used by one section end only)."""
    degree = Counter()
    for coords in parts:
        for c in (coords[0], coords[-1]):
            degree[(round(c[0], 5), round(c[1], 5))] += 1
    ends = []
    for (x, y), count in degree.items():
        if count == 1 and stations:
            ends.append(min(stations, key=lambda s: (s[1] - x) ** 2 + (s[2] - y) ** 2)[0])
    return list(dict.fromkeys(ends))


def coincide(segments, grid, s, other):
    """Whether N02 line `other` runs on segment s: the middle of s lies on it."""
    _, x1, y1, x2, y2, _ = segments[s]
    x, y = (x1 + x2) / 2, (y1 + y2) / 2
    return any(
        segments[t][0] == other and point_segment_m(x, y, *segments[t][1:5]) <= SHARED_TRACK_M for t in grid.near(x, y)
    )


def match_ways(ways, keys, n02):
    """Each Japanese way's N02 lines: the one it follows, then any drawn on the same track."""
    pad = MATCH_RADIUS_M / M_PER_DEG / math.cos(math.radians(46))
    grid = Grid()
    segments = []
    japan = set()
    for index, key in enumerate(keys):
        for coords in n02[key]:
            for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
                segments.append((index, x1, y1, x2, y2, math.atan2(y2 - y1, (x2 - x1) * math.cos(math.radians(y1)))))
                grid.add(len(segments) - 1, x1, y1, x2, y2, pad)
                cx, cy = math.floor(x1 / JAPAN_CELL_DEG), math.floor(y1 / JAPAN_CELL_DEG)
                japan.update((cx + dx, cy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1))

    in_japan = set()
    matched = {}
    shared = []  # (way, another line drawn on its track)
    for way_id, (tags, _, points, _) in ways.items():
        x, y = points[0]
        if (math.floor(x / JAPAN_CELL_DEG), math.floor(y / JAPAN_CELL_DEG)) not in japan:
            continue
        in_japan.add(way_id)
        taken = samples(points)
        nearest = []  # per sample: N02 line -> distance
        hits = Counter()
        for x, y, bearing in taken:
            best = {}
            for s in grid.near(x, y):
                index, x1, y1, x2, y2, seg_bearing = segments[s]
                if angle_ok(bearing, seg_bearing):
                    d = point_segment_m(x, y, x1, y1, x2, y2)
                    if d <= MATCH_RADIUS_M and d < best.get(index, (math.inf,))[0]:
                        best[index] = (d, s)
            nearest.append(best)
            hits.update(best.keys())
        if not hits:
            continue
        operator = operator_key(tags.get('operator'))
        parts = name_parts(tags.get('name', ''))
        named = {index for index in hits if any(names_line(p, keys[index][0], keys[index][1]) for p in parts)}

        def score(index):
            return (
                hits[index] / len(taken) + (0.5 if index in named else 0) + (0.25 if operator == keys[index][0] else 0)
            )

        first = max(hits, key=score)
        if hits[first] / len(taken) < (0.3 if first in named else 0.6):
            continue
        matched[way_id] = [first]
        for other, count in hits.items():
            if other != first and count >= 0.8 * len(taken):
                same = sum(1 for best in nearest if first in best and coincide(segments, grid, best[first][1], other))
                if same >= 0.8 * len(taken):
                    shared.append((way_id, other))

    # N02 draws lines a few metres apart in the same place, so it can't tell
    # shared track (京成成田空港線 on 北総線's) from parallel lines
    # (東海道新幹線 beside 東海道本線). OSM can: a line with track of its own
    # alongside the way doesn't share it.
    own = Grid()
    for way_id, (first,) in matched.items():
        points = ways[way_id][2]
        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            own.add((first, x1, y1, x2, y2), x1, y1, x2, y2, pad)
    for way_id, other in shared:
        taken = samples(ways[way_id][2])
        alongside = sum(
            1
            for x, y, _ in taken
            if any(line == other and point_segment_m(x, y, *seg) <= MATCH_RADIUS_M for line, *seg in own.near(x, y))
        )
        if alongside < len(taken) / 2:
            matched[way_id].append(other)
    return matched, in_japan


def service_name(name):
    """The service a way name puts in parentheses after its line: 横須賀線 in 東海道本線（横須賀線）."""
    parts = name_parts(name)
    return parts[1] if len(parts) == 2 and '・' not in name.split(';')[0] else None


def name_line(key, way_ids, ways, relations, relation_of, keys, n02_m):
    """The display name and aliases of an N02 line, from the names on its ways and relations."""
    operator, legal = key

    def is_variant(name, official):
        return names_line(name, operator, official)

    names = Counter()
    services = set()
    relation_km = Counter()
    for way_id in way_ids:
        tags, _, _, length = ways[way_id]
        parts = name_parts(tags.get('name', ''))
        for part in parts:
            names[part] += length
        service = service_name(tags.get('name', ''))
        if service and names_line(parts[0], operator, legal):
            services.add(service)
        for relation_id in relation_of.get(way_id, []):
            relation_km[relation_id] += length
    total = sum(ways[w][3] for w in way_ids) or 1
    # Names of other official lines, of any operator: never this line's name or alias,
    # unless a way gives them as its service.
    others = {
        n
        for n in names
        if n not in services
        and not is_variant(n, legal)
        and any(names_line(n, o, official) for o, official in keys if (o, official) != key)
    }
    name = None
    for relation_id, length in relation_km.most_common():
        relation_name = re.sub(r'^JR\s*', '', relations[relation_id][0].get('name', ''))
        if length >= total / 2 and is_variant(relation_name, legal):
            name = relation_name
            break
    variants = [n for n in names if is_variant(n, legal)]
    if not name and variants:
        name = max(variants, key=names.get)
    if not name:
        # No spelling of the official name (つくばエクスプレス for 常磐新線): the most common
        # other name, if it runs most of the line.
        name = next(
            (
                n
                for n, length in names.most_common()
                if n not in others and n not in GENERIC_NAMES and length >= n02_m / 2
            ),
            common_name(legal),
        )
    aliases = [
        n
        for n, length in names.most_common()
        if n != name
        and not is_variant(n, legal)
        and n not in others
        and n not in GENERIC_NAMES
        and n != operator_key(operator)
        and not STRUCTURE_NAME.search(n)
        and (length >= ALIAS_MIN_M or length >= ALIAS_MIN_SHARE * total)
    ]
    return name, aliases, others, names


def extend_lines(matched, in_japan, ways, keys):
    """Add track N02 leaves out (freight-only sections, stretches drawn too far off) to the line it's named after."""
    ways_at = defaultdict(list)
    for way_id in in_japan:
        for node in ways[way_id][1]:
            ways_at[node].append(way_id)
    queue = list(matched)
    while queue:
        way_id = queue.pop()
        for index in matched[way_id]:
            operator, legal = keys[index]
            for node in ways[way_id][1]:
                for other in ways_at[node]:
                    if other in matched:
                        continue
                    if any(names_line(p, operator, legal) for p in name_parts(ways[other][0].get('name', ''))):
                        matched[other] = [index]
                        queue.append(other)

    # Pieces joined to their line only through sidings or other lines' track (武蔵野線's
    # freight section at 府中本町): a named piece whose end lies near the line's track.
    near_line = defaultdict(set)
    for way_id, lines in matched.items():
        for x, y in ways[way_id][2]:
            near_line[(math.floor(x / GRID_DEG), math.floor(y / GRID_DEG))].update(lines)
    pieces = Components()
    names = {}
    for way_id in in_japan:
        if way_id in matched or not ways[way_id][0].get('name'):
            continue
        tags, nodes, _, _ = ways[way_id]
        names[way_id] = (name_parts(tags['name'])[0], operator_key(tags.get('operator')))
        for node in nodes:
            pieces.union(('w', way_id), (names[way_id], node))
    by_piece = defaultdict(list)
    for way_id in names:
        by_piece[pieces.find(('w', way_id))].append(way_id)
    for way_ids in by_piece.values():
        name, operator = names[way_ids[0]]
        candidates = set()
        for way_id in way_ids:
            for x, y in (ways[way_id][2][0], ways[way_id][2][-1]):
                gx, gy = math.floor(x / GRID_DEG), math.floor(y / GRID_DEG)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        candidates.update(near_line.get((gx + dx, gy + dy), ()))
        lines = [
            index
            for index in candidates
            if operator in ('', keys[index][0]) and names_line(name, keys[index][0], keys[index][1])
        ]
        if len(lines) == 1:
            for way_id in way_ids:
                matched[way_id] = lines


def main(opl_path, sections_path, stations_path, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    ways, relations = read_extract(opl_path)
    n02, n02_stations = read_n02(sections_path, stations_path)
    keys = sorted(n02)
    print(f'{len(ways)} line ways, {len(relations)} route=railway relations, {len(keys)} N02 lines')

    matched, in_japan = match_ways(ways, keys, n02)
    extend_lines(matched, in_japan, ways, keys)
    by_line = defaultdict(list)
    for way_id, lines in matched.items():
        for index in lines:
            by_line[index].append(way_id)
    relation_of = defaultdict(list)
    for relation_id, (_, members) in relations.items():
        for way_id in members:
            relation_of[way_id].append(relation_id)

    groups = []
    group_ways = defaultdict(list)
    review = []
    for index, key in enumerate(keys):
        way_ids = by_line.get(index, [])
        name, aliases, others, names = name_line(
            key, way_ids, ways, relations, relation_of, keys, sum(length_m(c) for c in n02[key])
        )
        groups.append({'source': 'n02', 'operator': key[0], 'legal_name': key[1], 'name': name, 'aliases': aliases})
        group_ways[len(groups) - 1] = way_ids
        review.append((len(groups) - 1, key, way_ids, others, names))

    # Outside N02: route=railway relations (not one direction of a service), then name and
    # operator along connected track.
    grouped = set(matched)
    for relation_id, (tags, members) in sorted(relations.items()):
        free = [w for w in members if w in ways and w not in grouped and w not in in_japan]
        if not free or re.search(r'→|=>|->|（[上下]り）', tags.get('name', '')):
            continue
        groups.append(
            {
                'source': f'r{relation_id}',
                'operator': tags.get('operator', ''),
                'legal_name': '',
                'name': tags.get('name', ''),
                'aliases': [],
            }
        )
        group_ways[len(groups) - 1] = free
        grouped.update(free)
    sets = Components()
    named = {}
    for way_id, (tags, nodes, _, _) in ways.items():
        if way_id in grouped or not tags.get('name'):
            continue
        parts = name_parts(tags['name'])
        named[way_id] = (parts[0] if parts else tags['name'], operator_key(tags.get('operator')))
        for node in nodes:
            sets.union(('w', way_id), (named[way_id], node))
    by_component = defaultdict(list)
    for way_id in named:
        by_component[sets.find(('w', way_id))].append(way_id)
    for way_ids in by_component.values():
        name, operator = named[way_ids[0]]
        groups.append({'source': 'name', 'operator': operator, 'legal_name': '', 'name': name, 'aliases': []})
        group_ways[len(groups) - 1] = way_ids

    with open(out / 'line_groups.csv', 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['group_id', 'line_id', 'source', 'operator', 'legal_name', 'name', 'aliases'])
        for group_id, g in enumerate(groups):
            line_id = line_id_of(g['operator'], g['legal_name']) if g['source'] == 'n02' else ''
            aliases = '|'.join(g['aliases'])
            writer.writerow([group_id, line_id, g['source'], g['operator'], g['legal_name'], g['name'], aliases])
    with open(out / 'line_group_ways.csv', 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['group_id', 'way_id', 'rank'])
        for group_id in range(len(groups)):
            n02_line = groups[group_id]['source'] == 'n02'
            for way_id in sorted(group_ways[group_id]):
                # N02 groups come first, in the order of keys, so their group id is the line's index.
                writer.writerow([group_id, way_id, matched[way_id].index(group_id) if n02_line else 0])

    pad = MATCH_RADIUS_M / M_PER_DEG / math.cos(math.radians(46))
    with open(out / 'review.csv', 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                'group_id',
                'operator',
                'legal_name',
                'name',
                'aliases',
                'ends',
                'n02_km',
                'covered',
                'way_km',
                'ways',
                'pieces',
                'shared_ways',
                'relations',
                'other_names',
            ]
        )
        for group_id, key, way_ids, others, names in review:
            # Covered: the share of the N02 line with one of its ways nearby.
            near = Grid()
            for w in way_ids:
                points = ways[w][2]
                for (x1, y1), (x2, y2) in zip(points, points[1:]):
                    near.add((x1, y1, x2, y2), x1, y1, x2, y2, pad)
            total = covered = 0.0
            for coords in n02[key]:
                taken = samples(coords)
                step = length_m(coords) / max(1, len(taken))
                for x, y, _ in taken:
                    total += step
                    if any(point_segment_m(x, y, *seg) <= MATCH_RADIUS_M for seg in near.near(x, y)):
                        covered += step
            pieces = Components()
            for w in way_ids:
                for node in ways[w][1]:
                    pieces.union(('w', w), ('n', node))
            rel_km = Counter()
            for w in way_ids:
                for r in relation_of.get(w, []):
                    rel_km[r] += ways[w][3] / 1000
            g = groups[group_id]
            other_names = Counter({n: km for n, km in names.items() if name_key(n) != name_key(key[1])})
            writer.writerow(
                [
                    group_id,
                    key[0],
                    key[1],
                    g['name'],
                    '|'.join(g['aliases']),
                    '–'.join(line_ends(n02[key], n02_stations.get(key, []))),
                    f'{sum(length_m(c) for c in n02[key]) / 1000:.1f}',
                    f'{covered / total:.0%}' if total else '',
                    f'{sum(ways[w][3] for w in way_ids) / 1000:.1f}',
                    len(way_ids),
                    len({pieces.find(('w', w)) for w in way_ids}),
                    sum(1 for w in way_ids if len(matched[w]) > 1),
                    ' '.join(f'r{r}:{relations[r][0].get("name", "")}:{km:.0f}' for r, km in rel_km.most_common(4)),
                    ' '.join(
                        f'{n}{"*" if n in others else ""}:{km / 1000:.1f}' for n, km in other_names.most_common(5)
                    ),
                ]
            )
    unmatched = Counter()
    for way_id in in_japan:
        tags = ways[way_id][0]
        parts = name_parts(tags.get('name', ''))
        if way_id not in matched and parts:
            unmatched[(parts[0], operator_key(tags.get('operator')))] += ways[way_id][3]
    with open(out / 'unmatched.csv', 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['name', 'operator', 'km'])
        for (name, operator), length in unmatched.most_common():
            writer.writerow([name, operator, f'{length / 1000:.1f}'])
    shared = sum(1 for lines in matched.values() if len(lines) > 1)
    print(
        f'{len(matched)} of {len(in_japan)} ways in Japan follow an N02 line ({shared} on shared track); '
        f'{len(groups)} groups'
    )


if __name__ == '__main__':
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(*sys.argv[1:])
