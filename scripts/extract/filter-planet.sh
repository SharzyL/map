#!/usr/bin/env bash
# Streams the planet once and makes two railway extracts of it:
#
#   <world.osm.pbf>  worldwide, the railway ways and relations without the
#                    nodes the ways run through. The tile export joins their
#                    tags to the import database's ways by id, so it needs
#                    no coordinates.
#   <box.osm.pbf>    inside <bbox>, the objects railway-extract.filter keeps
#                    with the nodes their ways run through and their relations
#                    list: what needs coordinates (relations, routes,
#                    stations, official lines).
#
# The planet (~95 GB, more than a CI runner's disk) is streamed, not stored,
# and read by two osmium commands at once: one filters it worldwide (nodes
# are only skipped, so that is cheap), the other keeps everything inside the
# box, nodes included, on disk, which is then filtered with references
# followed. Ways crossing the box's edge end at it, so give a box a little
# larger than what is used. The pass takes ~25 min, as long as the download.
# The results are as old as the planet; fetch-diffs.sh brings them up to date with
# hourly diffs.
#
# Usage: ./scripts/extract/filter-planet.sh <.osm.pbf URL> <world.osm.pbf> <box.osm.pbf> <bbox>
#
# Give a dated planet (planet-YYMMDD.osm.pbf) rather than planet-latest, so
# the same URL is the same file every time, and <bbox> as
# minlon,minlat,maxlon,maxlat.
#
# The pass says every three minutes how much it has read and how fast
# (meter.py), so a slow or stalled download shows in the log.
#
# Needs curl, osmium and python3.

set -euo pipefail

if [ $# -ne 4 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
URL="$1"
WORLD="$2"
BOX="$3"
BBOX="$4"
FILTER="$(dirname "$0")/railway-extract.filter"
METER="$(dirname "$0")/meter.py"
mkdir -p "$(dirname "${WORLD}")" "$(dirname "${BOX}")"
WORK="$(mktemp -d "$(dirname "${BOX}")/filter-planet.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
start="$(date +%s)"
minutes() { echo "$(( ($(date +%s) - start) / 60 ))"; }

URL="$(curl -sSfIL -o /dev/null -w '%{url_effective}' "${URL}")"
SIZE="$(curl -sSfIL "${URL}" | tr -d '\r' | sed -n 's/^content-length: *//Ip' | tail -n 1)"
echo "Streaming ${URL} through osmium"
mkfifo "${WORK}/box.fifo"
osmium extract -F pbf - -b "${BBOX}" -s simple -O -f pbf -o "${WORK}/box-all.osm.pbf" < "${WORK}/box.fifo" &
cut="$!"
# Worldwide: the railway ways, whose tags the tiles take, and the relations
# railway-extract.filter keeps (the line relations for the tiles, the rest
# for the box, below). No nodes: skipping them is what keeps this cheap. -R
# keeps out what they refer to (a stream cannot be read twice).
{ grep '^r/' "${FILTER}"; echo 'w/railway'; } > "${WORK}/world.filter"
curl -sSfL "${URL}" | python3 -I "${METER}" "planet" ${SIZE} | tee "${WORK}/box.fifo" \
  | osmium tags-filter -F pbf - -e "${WORK}/world.filter" -R -O -f pbf -o "${WORK}/world.osm.pbf"
wait "${cut}"
echo "Streamed after $(minutes) min; the box holds $(du -h "${WORK}/box-all.osm.pbf" | cut -f1)"

# From a file osmium follows references: the nodes of the kept ways come along
osmium tags-filter "${WORK}/box-all.osm.pbf" -e "${FILTER}" -O -o "${WORK}/box-railway.osm.pbf"
# A cut of a stream keeps only the relations with a member node in the box:
# routes made of ways alone, and route masters, which list only routes, are
# left out. They come from the worldwide extract: the relations listing
# anything in the box, then those listing one of these (the masters of the
# routes just added).
osmium getparents "${WORK}/world.osm.pbf" -I "${WORK}/box-railway.osm.pbf" -O -o "${WORK}/parents.osm.pbf"
osmium getparents "${WORK}/world.osm.pbf" -I "${WORK}/parents.osm.pbf" -O -o "${WORK}/grandparents.osm.pbf"
osmium merge "${WORK}/box-railway.osm.pbf" "${WORK}/parents.osm.pbf" "${WORK}/grandparents.osm.pbf" \
  -O -o "${WORK}/box.osm.pbf"
echo "$(osmium fileinfo -e -g data.count.relations "${WORK}/box.osm.pbf") relations in the box," \
  "$(osmium fileinfo -e -g data.count.relations "${WORK}/box-railway.osm.pbf") of them found by the cut"
# Moved into place last, so an interrupted run leaves neither
mv "${WORK}/world.osm.pbf" "${WORLD}"
mv "${WORK}/box.osm.pbf" "${BOX}"
echo "Filtered after $(minutes) min"
