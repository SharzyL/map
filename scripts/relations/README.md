# Railway relations for `/api/v1/relations`

The Worker's `GET /api/v1/relations/{id}` (see
[`public/api/v1/doc.md`](../../public/api/v1/doc.md#railway-relations)) answers from the
D1 database `cr`, which also holds the China Railway timetables. Each answer is prefilled from
OSM's railway extract: the routes and lines of China, Japan and what lies between, and Japan's
official lines (路線) from MLIT's railway data, 国土数値情報 N02 (`../lines`).

| File                                        | Use                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `relations.sh`                              | Runs `build_relations.py` on the extract cut to the box, with N02's stations                     |
| `build_relations.py`                        | Builds one SQL file: a row per relation (split under D1's statement limit) with its whole answer |
| `relations_sql.py`                          | The SQL format; `--list-old` and `--drop-old` remove other versions' tables after an import      |
| `../lines/fetch-n02.sh`                     | Downloads N02 and extracts its lines and stations                                                |
| `../lines/line-groups.sh`, `line-groups.py` | Japan's official lines, from the same extract                                                    |

## Building

The build (`scripts/build`) runs these steps; by hand, they need curl, osmium, and Python 3
with osmium (pyosmium), numpy and scipy (`nix-shell ../routing/shell.nix` has them, and
`PYTHON="uv run --script"` makes `relations.sh` install them). From this directory, with the
railway extract `lines.osm.pbf` (`../extract`):

```bash
../lines/fetch-n02.sh https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip n02
export N02_DIR=n02
../lines/line-groups.sh lines.osm.pbf line-groups        # ~1 min, 4 GB of memory

# China and Japan, with what lies in between; the cut drops the extract's time
version=$(osmium fileinfo -g header.option.osmosis_replication_timestamp lines.osm.pbf)
osmium extract -b 73,17,146,54 -s smart lines.osm.pbf -o box.osm.pbf
./relations.sh box.osm.pbf line-groups relations.sql "$version"   # ~6 min, 4.3 GB
```

The data version is the extract's `osmosis_replication_timestamp`.

The build of 2026-11-17T13:00:00Z holds 10,172 relations in 10,202 rows, 32 MB of JSON: 5,046
routes, 3,249 OSM lines, 596 official lines and 1,281 route masters. An answer is 1–3 KB
typically and 96 KB at most (沪昆线). The same inputs give the same file, byte for byte.

## Loading into D1

From the repository root, with the Cloudflare credentials of the `cr` database:

```bash
d1() { npx --yes wrangler@4 d1 execute cr --remote "$@"; }
d1 --file=relations.sql
d1 --command "SELECT version, (SELECT count(DISTINCT id) FROM osm_relations) AS relations FROM osm_version"
# The import switched the views; now drop the tables of other versions
version=2026-11-17T13:00:00Z
d1 --json --command "$(python3 scripts/relations/relations_sql.py --list-old)" > tables.json
drop=$(python3 scripts/relations/relations_sql.py --drop-old "$version" < tables.json)
if [ -n "$drop" ]; then d1 --command "$drop"; fi
```

- **Versions switch at the end.** Tables carry the data version
  (`osm_relations_202611171300`); the file ends by pointing the `osm_relations` and
  `osm_version` views at them, so a failed import leaves the previous version serving.
  Importing the same version again makes the endpoint answer 503 while it runs.
- **Rows written.** An import writes about 10,000 rows and stores about 35 MB, twice while
  two versions exist.
- **Independent of the Worker.** Without the data the endpoint answers 503
  `data_unavailable`; the other endpoints are unaffected.

To check a route, a Chinese line, an official line and a missing relation:

```bash
for id in 1972920 14031196 jp-15e84d7cdd 42; do
  curl -s -o /dev/null -w "$id %{http_code} %{size_download}\n" "https://map.shz.al/api/v1/relations/$id"
done   # 200 with about 6, 96 and 41 KB, then 404
```

Anything showing an official line must credit N02; answers carry the credit in
`relation.attribution`. The tile export reads the same official lines
(`LINE_GROUPS_DIR`), so their ids are the tiles' when both come from one extract.
