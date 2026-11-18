#!/usr/bin/env bash
# Filters an OSM extract, normally the planet, down to the railway extract: the
# OSM objects railway-extract.filter keeps (railway lines, transit routes, stop
# areas, every railway way, stations) and the nodes those ways run through and
# those relations list, so it has coordinates. The tile export reads the
# railway lines and the number of tracks and opening dates of railway ways
# from it, which the import database leaves out; relations, train routes and
# the stations matched to timetables come from it too.
#
# The input is streamed rather than stored (~95 GB, more than a CI runner's
# disk), twice: osmium can only follow references when it can read its input
# more than once, so the first pass keeps the filtered objects and the second
# fetches the nodes they refer to by id. Two passes of the planet take ~80
# min. The result is as old as the planet; update.sh brings it up to date
# with hourly diffs.
#
# Usage: ./scripts/extract/filter-planet.sh <.osm.pbf URL> <out.osm.pbf>
#
# Give a dated planet (planet-YYMMDD.osm.pbf) rather than planet-latest, so
# the same URL is the same file every time.
#
# Each pass says every three minutes how much it has read and how fast
# (meter.py), so a slow or stalled download shows in the log.
#
# Needs curl, osmium, awk and python3.

set -euo pipefail

if [ $# -ne 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
URL="$1"
OUT="$2"
FILTER="$(dirname "$0")/railway-extract.filter"
mkdir -p "$(dirname "${OUT}")"
WORK="$(mktemp -d "$(dirname "${OUT}")/filter-planet.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
start="$(date +%s)"
minutes() { echo "$(( ($(date +%s) - start) / 60 ))"; }

# Both passes read the same file, even if a newer one is published meanwhile.
URL="$(curl -sSfIL -o /dev/null -w '%{url_effective}' "${URL}")"
# Its size, so the passes can say how far they are (meter.py, every 3 min)
SIZE="$(curl -sSfIL "${URL}" | tr -d '\r' | sed -n 's/^content-length: *//Ip' | tail -n 1)"
METER="$(dirname "$0")/meter.py"
echo "Streaming ${URL} through osmium (1/2: the filtered objects)"
curl -sSfL "${URL}" | python3 -I "${METER}" "pass 1/2" ${SIZE} \
  | osmium tags-filter -F pbf - -e "${FILTER}" -R -O -f pbf -o "${WORK}/selected.osm.pbf"
echo "Filtered after $(minutes) min"
# The nodes of the kept ways and the node members of the kept relations, as
# "n<id>" lines (OPL fields: N<node>,... on ways, M<type><id>@<role>,... on
# relations).
osmium cat "${WORK}/selected.osm.pbf" -f opl,add_metadata=false -o - | awk '
  $1 ~ /^w/ { for (i = 2; i <= NF; i++) if ($i ~ /^N/) { n = split(substr($i, 2), refs, ","); for (j = 1; j <= n; j++) print refs[j] } }
  $1 ~ /^r/ { for (i = 2; i <= NF; i++) if ($i ~ /^M/) { n = split(substr($i, 2), refs, ","); for (j = 1; j <= n; j++) if (refs[j] ~ /^n/) { sub(/@.*/, "", refs[j]); print refs[j] } } }
' > "${WORK}/node-ids.txt"
echo "$(wc -l < "${WORK}/node-ids.txt") node references; streaming again (2/2: their nodes)"
# getid exits with 1 when some ids are not in the input: nodes across the
# border of a regional extract. That is fine; 2 is an error.
curl -sSfL "${URL}" | python3 -I "${METER}" "pass 2/2" ${SIZE} \
  | { osmium getid -F pbf - -i "${WORK}/node-ids.txt" -O -f pbf -o "${WORK}/nodes.osm.pbf" || [ $? -eq 1 ]; }
# Written beside the output first, so an interrupted run leaves none.
osmium merge "${WORK}/selected.osm.pbf" "${WORK}/nodes.osm.pbf" -O -f pbf -o "${WORK}/merged.osm.pbf"
mv "${WORK}/merged.osm.pbf" "${OUT}"
echo "Extract built after $(minutes) min"
