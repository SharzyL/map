# Railway extract

`lines.osm.pbf`, the artifact of the manual "Fetch line relations" workflow
(`.github/workflows/fetch-line-relations.yml`): OSM's railways as a self-contained file, with
railway lines, transit routes and their stops, stations, every railway way, and the nodes all of
these use, so it has coordinates. It is taken from the planet and brought up to date with
OSM's hourly changes. The "Export PMTiles" workflow builds the same file on every run and reads
the railway lines and some way tags from it; the fetch workflow only uploads it.

It holds what a route API needs from OSM: a relation's ways and stops, their geometry (for
bounding boxes and overview lines), stations, and the track network with its junctions.

## Getting it

```bash
gh workflow run fetch-line-relations.yml           # ~1.5 h; a few min with a cached planet pass
gh run list -w fetch-line-relations.yml -L 1        # the run id
gh run download <run id> -n line-relations -D output/line-relations
```

The artifact is kept for 7 days. A run with input `line_relations_pbf` set to another `.osm.pbf`
URL (a Geofabrik country extract, say) builds the same file for that area only.

## Format

An OSM PBF file, readable with [osmium](https://osmcode.org/osmium-tool/),
[pyosmium](https://osmcode.org/pyosmium/), or any PBF reader. The header's
`osmosis_replication_timestamp` is the time of the last hourly change applied, so the data is
current to that hour.

```bash
osmium fileinfo -e output/line-relations/lines.osm.pbf     # counts, header, bounding box
osmium cat output/line-relations/lines.osm.pbf -f opl -o lines.opl   # one object per line
# Ways carrying their own coordinates, for readers that do not join nodes themselves:
osmium add-locations-to-ways --ignore-missing-nodes output/line-relations/lines.osm.pbf -o located.osm.pbf
```

## Contents

The objects `scripts/tiles/railway-extract.filter` selects, each with all its tags, and the
nodes they refer to.

### Relations

| relation                                                               | what it is                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `route=railway`                                                        | an infrastructure line: a national line number (`DB 6100`), a named line (`京广高速铁路`, `京沪线`, `東海道本線`) |
| `route=train`, `subway`, `light_rail`, `tram`, `monorail`, `funicular` | a transit route, one direction of a service (`JR山手線`, `湘南新宿ライン (前橋=>小田原)`)                         |
| `route_master=` the same types                                         | the service that groups a route's directions                                                                      |
| `public_transport=stop_area`                                           | the stop positions, platforms and station nodes of one station                                                    |

Members are kept in OSM order with their type, id and role, so a route's stops (roles `stop`,
`platform`, and their `_entry_only`/`_exit_only` variants) come in the order the route
serves them. Tags include `name`, `name:*`, `alt_name`, `old_name`, `ref`, `from`, `to`,
`operator`, `network`, `colour`, `wikidata`.

### Ways

Every way tagged `railway`, whatever its value: tracks in service (`rail`, `subway`,
`light_rail`, `tram`, `narrow_gauge`, `monorail`, `funicular`, `miniature`), tracks out of
service or not yet built (`disused`, `abandoned`, `razed`, `construction`, `proposed`), and the
other railway ways (`platform`, `station` and `halt` outlines, `turntable`, …). Each keeps all
its tags (`usage`, `service`, `highspeed`, `maxspeed`, `tracks`, `gauge`, `electrified`,
`start_date`, …) and its node ids in order.

Two ways meet where they share a node id, so the ways alone give the network's junctions.

### Nodes

- **Stations and stops tagged as such**, on a track or not: `railway=station`, `halt`, `stop`,
  `tram_stop`, `platform`, and `public_transport=station`.
- **Every node of the ways above**, with its position. Track nodes keep their tags, so stop
  positions (`public_transport=stop_position`, `railway=stop`), switches, signals and level
  crossings on a track are in the file too.
- **Every node member of the relations above**: a route's stop positions and platform nodes, a
  stop area's nodes.

### Not included

- Ways that are not tagged `railway`, even when a relation lists them (a ferry in a train
  route, a road in a tram route, a way tagged only `disused:railway=*`), and the ways and
  relations a stop area lists besides its nodes (platform ways tagged only
  `public_transport=platform`). Their references stay, with nothing behind them.
- Bus, ferry and other non-rail routes, and anything else outside the filter.

## How it is made

1. `scripts/tiles/fetch-line-relations.sh` streams the planet (`planet-latest.osm.pbf`,
   published weekly) twice, as a runner cannot store it and osmium can only follow references
   in a file it can read more than once:
   1. `osmium tags-filter -e railway-extract.filter -R` keeps the filtered objects;
   2. `osmium getid` fetches the nodes those ways and relations refer to, by id;

   and merges the two.

2. `scripts/tiles/update-line-relations.sh` applies OSM's hourly changes since the planet,
   each filtered with the same filter (keeping the nodes of the ways it adds or changes), so
   the file matches the nightly import database (and is a little newer than it).

The two planet passes are cached in GitHub Actions by the planet's md5 and the hash of the fetch
script and the filter, so until the next weekly planet, a run only applies the hourly changes.

## Caveats

- **Deletions do not propagate.** A change that deletes an object, or removes the tag the
  filter keeps it by, is filtered away, so the object stays as it was in the planet. Up to a
  week of such deletions and retaggings can linger.
- **Node moves do not either.** A node moved without a change to its way is untagged, so the
  filter drops the change and the node keeps its position from the planet (up to a week old).
  A new way drawn through existing nodes that are not in the file lacks their positions
  (`--ignore-missing-nodes` above skips them).
- **Newer than the database.** The hourly changes go up to the run, while the OpenRailwayMap
  import database (and so the tiles) is from the night before. A relation can list a way the
  tiles do not have yet, and the other way round.

## What the tile export takes from it

The export keeps only the railway lines and the ways with a `tracks`, `start_date` or
`opening_date` tag (`lines.opl`), and `scripts/tiles/line-relations.py` turns them into
three CSV files for PostgreSQL:

| file                        | columns                                 |
| --------------------------- | --------------------------------------- |
| `line_relations.csv`        | `osm_id,name,ref,color,operator`        |
| `line_relation_members.csv` | `relation_id,way_id`                    |
| `line_way_tags.csv`         | `way_id,tracks,start_date,opening_date` |

The script is a small standalone OPL reader, reusable for other tables.
