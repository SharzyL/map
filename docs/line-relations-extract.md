# Line relations extract

`lines.osm.pbf`, the artifact of the manual "Fetch line relations" workflow
(`.github/workflows/fetch-line-relations.yml`): OSM's railway lines (`route=railway` relations)
and every railway way, taken from the planet and brought up to date with OSM's hourly changes.
The "Export PMTiles" workflow builds the same file on every run to add `line_relations`,
`tracks` and the opening dates to the tiles. This workflow only uploads it.

## Getting it

```bash
gh workflow run fetch-line-relations.yml           # about 45 min; a few with a cached planet pass
gh run list -w fetch-line-relations.yml -L 1        # the run id
gh run download <run id> -n line-relations -D output/line-relations
```

The artifact is kept for 7 days. A run with input `line_relations_pbf` set to another `.osm.pbf`
URL (a Geofabrik country extract, say) builds the same file for that area only.

## Format

An OSM PBF file, readable with [osmium](https://osmcode.org/osmium-tool/),
[pyosmium](https://osmcode.org/pyosmium/), or any PBF reader. Objects keep their OSM version,
timestamp and changeset. The header's `osmosis_replication_timestamp` is the time of the last
hourly change applied, so the data is current to that hour.

```bash
osmium fileinfo -e output/line-relations/lines.osm.pbf     # counts, header, bounding box
osmium cat output/line-relations/lines.osm.pbf -f opl -o lines.opl   # one object per line
```

## Contents

Exactly two kinds of object, each with all its tags:

### Railway lines: relations with `route=railway`

The infrastructure lines: a national line number (`DB 6100`), a named line (`京广高速铁路`,
`京沪线`, `東海道本線`), with tags such as `name`, `name:*`, `alt_name`, `old_name`, `ref`,
`operator`, `colour`, `wikidata`.

Members are kept in OSM order, with their type, id and role: mostly the line's ways, sometimes
its stations and stop nodes. Only the references are kept, not the members themselves: a member
way is in the file only if it is a railway way (below), and member nodes never are.

### Railway ways: ways with any `railway=*` tag

Every way tagged `railway`, whatever its value: tracks in service (`rail`, `subway`,
`light_rail`, `tram`, `narrow_gauge`, `monorail`, `funicular`, `miniature`), tracks out of
service or not yet built (`disused`, `abandoned`, `razed`, `construction`, `proposed`), and the
other railway ways (`platform`, `station` and `halt` outlines, `turntable`, …). Each keeps all
its tags (`usage`, `service`, `highspeed`, `maxspeed`, `tracks`, `gauge`, `electrified`,
`start_date`, …) and its node ids in order.

### Not included

- **Node positions.** Ways carry node ids, but there are no nodes in the file, so it has no
  coordinates. A way's geometry is in the OpenRailwayMap import database (`railway_line`, by
  `osm_id`) or in the tiles (`railway_line_high`, by `osm_id`). Two ways sharing a node id
  meet there, so the file alone gives the network's topology.
- **Transit routes** (`route=train`, `subway`, `light_rail`, `tram`, `monorail`,
  `funicular`): the import database has those, in `routes`, `route_line` and `route_stop`.
- **Stations and other nodes**, and anything not tagged `railway` or `route=railway`.

## How it is made

1. `scripts/tiles/fetch-line-relations.sh` streams the planet (`planet-latest.osm.pbf`,
   published weekly) through
   `osmium tags-filter r/route=railway w/railway -R`, which keeps the matching relations and
   ways and drops whatever they reference.
2. `scripts/tiles/update-line-relations.sh` applies OSM's hourly changes since the planet,
   each filtered the same way, so the file matches the nightly import database (and is a little
   newer than it).

The filtered planet is cached in GitHub Actions by the planet's md5 and the fetch script's
hash, so until the next weekly planet, a run only applies the hourly changes.

## Caveats

- **Deletions do not propagate.** A change that deletes an object, or removes the tag the
  filter keeps it by, is filtered away, so the object stays as it was in the planet. Up to a
  week of such deletions and retaggings can linger.
- **Newer than the database.** The hourly changes go up to the run, while the import database
  is from the night before. A relation can list a way the database does not have yet, and the
  other way round.
- **Members outside the file.** A relation member that is not a railway way (a ferry, a road,
  a way tagged only `disused:railway=*`) is a reference with nothing behind it.

## What the tile export takes from it

The export keeps only the relations and the ways with a `tracks`, `start_date` or
`opening_date` tag (`lines.opl`), and `scripts/tiles/line-relations.py` turns them into
three CSV files for PostgreSQL:

| file                        | columns                                 |
| --------------------------- | --------------------------------------- |
| `line_relations.csv`        | `osm_id,name,ref,color,operator`        |
| `line_relation_members.csv` | `relation_id,way_id`                    |
| `line_way_tags.csv`         | `way_id,tracks,start_date,opening_date` |

The script is a small standalone OPL reader, reusable for other tables.
