#!/usr/bin/env bash
# Filters the planet down to the OSM objects railway-extract.filter keeps
# (railway lines, transit routes, stop areas, every railway way, stations),
# worldwide, in one pass and without the untagged nodes the ways run through:
# what the tile export reads from it, the railway lines and the number of
# tracks and opening dates of railway ways (which the import database leaves
# out), it joins to the database's ways by id, so it needs no coordinates.
# What needs them, inside the box around China and Japan, comes from regional
# extracts instead (filter-region.sh).
#
# The planet (~95 GB, more than a CI runner's disk) is streamed, not stored:
# one pass takes ~30 min. The result is as old as the planet; update.sh brings
# it up to date with hourly diffs.
#
# Usage: ./scripts/extract/filter-planet.sh <.osm.pbf URL> <out.osm.pbf>
#
# Give a dated planet (planet-YYMMDD.osm.pbf) rather than planet-latest, so
# the same URL is the same file every time.
#
# The pass says every three minutes how much it has read and how fast
# (meter.py), so a slow or stalled download shows in the log.
#
# Needs curl, osmium and python3.

set -euo pipefail

if [ $# -ne 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
URL="$1"
OUT="$2"
FILTER="$(dirname "$0")/railway-extract.filter"
METER="$(dirname "$0")/meter.py"
mkdir -p "$(dirname "${OUT}")"
start="$(date +%s)"

URL="$(curl -sSfIL -o /dev/null -w '%{url_effective}' "${URL}")"
SIZE="$(curl -sSfIL "${URL}" | tr -d '\r' | sed -n 's/^content-length: *//Ip' | tail -n 1)"
echo "Streaming ${URL} through osmium"
# -R: what the objects refer to stays out (a stream cannot be read twice)
curl -sSfL "${URL}" | python3 -I "${METER}" "planet" ${SIZE} \
  | osmium tags-filter -F pbf - -e "${FILTER}" -R -O -f pbf -o "${OUT}.part"
# Moved into place last, so an interrupted run leaves none
mv "${OUT}.part" "${OUT}"
echo "Filtered after $(( ($(date +%s) - start) / 60 )) min"
