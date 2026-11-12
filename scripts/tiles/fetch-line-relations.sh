#!/usr/bin/env bash
# Collects OSM data the import database leaves out, for the tile export:
# railway line relations (route=railway) and the number of tracks and opening
# dates of railway ways (tracks, start_date, opening_date). They come from an
# OSM extract, normally the planet: it is streamed through osmium without
# being stored (~95 GB, more than a CI runner's disk) and only those
# relations and railway ways are kept. update-line-relations.sh then brings
# them up to date with hourly diffs, and <out-dir>/lines.opl (the relations
# and the ways with any of those tags) is what export-tippecanoe.sh reads
# (LINE_RELATIONS_OPL).
#
# Usage: ./scripts/tiles/fetch-line-relations.sh <.osm.pbf URL> <out-dir>
#
# Needs curl and osmium.

set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '12p' "$0" >&2
  exit 1
fi
URL="$1"
OUT="$2"
mkdir -p "${OUT}"
start="$(date +%s)"
minutes() { echo "$(( ($(date +%s) - start) / 60 ))"; }

echo "Streaming ${URL} through osmium"
curl -sSfL "${URL}" | osmium tags-filter -F pbf - r/route=railway w/railway -R -O -o "${OUT}/planet.osm.pbf"
echo "Extract filtered after $(minutes) min"

"$(dirname "$0")/update-line-relations.sh" "${OUT}/planet.osm.pbf" "${OUT}/lines.osm.pbf"
# Every railway way was kept so diffs can update them; only the tagged ones go on.
osmium tags-filter "${OUT}/lines.osm.pbf" r/route=railway w/tracks w/start_date w/opening_date -R -O \
  -o "${OUT}/tagged.osm.pbf"
osmium cat "${OUT}/tagged.osm.pbf" -f opl,add_metadata=false -O -o "${OUT}/lines.opl"
echo "Line relations ready after $(minutes) min"
