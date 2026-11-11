#!/usr/bin/env python3
"""Turn OSM route=railway relations (OPL) into CSV files for PostgreSQL.

Usage: line-relations.py <relations.opl> <out_dir>

The input comes from
  osmium tags-filter <planet.osm.pbf> r/route=railway -R
  osmium cat -f opl,add_metadata=false
and holds one relation per line. Writes:
  line_relations.csv         osm_id,name,ref,color,operator
  line_relation_members.csv  relation_id,way_id
"""

import csv
import re
import sys
from pathlib import Path

ESCAPE = re.compile(r'%([0-9a-fA-F]+)%')


def unescape(value):
    return ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), value)


def parse_tags(field):
    tags = {}
    for item in field.split(',') if field else []:
        key, _, value = item.partition('=')
        tags[unescape(key)] = unescape(value)
    return tags


def main(opl_path, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    relations = members = 0
    with (
        open(opl_path, encoding='utf-8') as src,
        open(out / 'line_relations.csv', 'w', newline='', encoding='utf-8') as rel_file,
        open(out / 'line_relation_members.csv', 'w', newline='', encoding='utf-8') as member_file,
    ):
        rel_csv = csv.writer(rel_file)
        member_csv = csv.writer(member_file)
        for line in src:
            fields = line.rstrip('\n').split(' ')
            if not fields[0].startswith('r'):
                continue
            relation_id = int(fields[0][1:])
            tags = {}
            way_ids = []
            for field in fields[1:]:
                if field.startswith('T'):
                    tags = parse_tags(field[1:])
                elif field.startswith('M'):
                    for member in field[1:].split(',') if len(field) > 1 else []:
                        ref = member.partition('@')[0]
                        if ref.startswith('w'):
                            way_ids.append(int(ref[1:]))
            if tags.get('route') != 'railway':
                continue
            rel_csv.writerow(
                [relation_id, tags.get('name', ''), tags.get('ref', ''), tags.get('colour', ''), tags.get('operator', '')]
            )
            relations += 1
            for way_id in dict.fromkeys(way_ids):
                member_csv.writerow([relation_id, way_id])
                members += 1
    print(f'{relations} line relations, {members} way members')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
