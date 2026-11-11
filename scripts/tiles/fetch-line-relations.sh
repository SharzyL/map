#!/usr/bin/env bash
# Collects OSM railway line relations (route=railway) for the tile export.
# The import database leaves them out, so they come from an OSM extract,
# normally the planet: it is streamed through osmium without being stored
# (~95 GB, more than a CI runner's disk) and only the relations are kept.
# update-line-relations.sh then brings them up to date with hourly diffs, and
# <out-dir>/lines.opl is what export-tippecanoe.sh reads (LINE_RELATIONS_OPL).
#
# Usage: ./scripts/tiles/fetch-line-relations.sh <.osm.pbf URL> <out-dir>
#
# Needs curl and osmium.

set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '9p' "$0" >&2
  exit 1
fi
URL="$1"
OUT="$2"
mkdir -p "${OUT}"
start="$(date +%s)"
minutes() { echo "$(( ($(date +%s) - start) / 60 ))"; }

echo "Streaming ${URL} through osmium"
curl -sSfL "${URL}" | osmium tags-filter -F pbf - r/route=railway -R -O -o "${OUT}/planet.osm.pbf"
echo "Extract filtered after $(minutes) min"

"$(dirname "$0")/update-line-relations.sh" "${OUT}/planet.osm.pbf" "${OUT}/lines.osm.pbf"
osmium cat "${OUT}/lines.osm.pbf" -f opl,add_metadata=false -O -o "${OUT}/lines.opl"
echo "Line relations ready after $(minutes) min"
