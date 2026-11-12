#!/usr/bin/env bash
# Builds the railway extract: the OSM objects railway-extract.filter keeps
# (railway lines, transit routes, stop areas, every railway way, stations) and
# the nodes those ways run through and those relations list, so it has
# coordinates. The tile export reads the railway lines and the number of
# tracks and opening dates of railway ways from it, which the import database
# leaves out.
#
# It comes from an OSM extract, normally the planet, streamed rather than
# stored (~95 GB, more than a CI runner's disk), twice: osmium can only follow
# references when it can read its input more than once, so the first pass
# keeps the filtered objects and the second fetches the nodes they refer to by
# id. update-line-relations.sh then brings the result up to date with hourly
# diffs into <out-dir>/lines.osm.pbf, and <out-dir>/lines.opl (the line
# relations and the ways with any of those tags) is what export-tippecanoe.sh
# reads (LINE_RELATIONS_OPL).
#
# The filtered extract, <out-dir>/planet.osm.pbf, only depends on the planet,
# this script and the filter, so it is reused when it is already there (the
# workflows cache it by the planet's md5); the diffs are applied anew either
# way.
#
# Usage: ./scripts/tiles/fetch-line-relations.sh <.osm.pbf URL> <out-dir>
#
# Needs curl, osmium and awk.

set -euo pipefail

if [ $# -ne 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
URL="$1"
OUT="$2"
mkdir -p "${OUT}"
start="$(date +%s)"
minutes() { echo "$(( ($(date +%s) - start) / 60 ))"; }

FILTER="$(dirname "$0")/railway-extract.filter"
if [ -s "${OUT}/planet.osm.pbf" ]; then
  echo "Reusing the filtered extract ${OUT}/planet.osm.pbf"
else
  # Both passes read the same file, even if a newer one is published meanwhile.
  URL="$(curl -sSfIL -o /dev/null -w '%{url_effective}' "${URL}")"
  echo "Streaming ${URL} through osmium (1/2: the filtered objects)"
  curl -sSfL "${URL}" | osmium tags-filter -F pbf - -e "${FILTER}" -R -O -f pbf -o "${OUT}/selected.osm.pbf"
  echo "Filtered after $(minutes) min"
  # The nodes of the kept ways and the node members of the kept relations, as
  # "n<id>" lines (OPL fields: N<node>,... on ways, M<type><id>@<role>,... on
  # relations).
  osmium cat "${OUT}/selected.osm.pbf" -f opl,add_metadata=false -o - | awk '
    $1 ~ /^w/ { for (i = 2; i <= NF; i++) if ($i ~ /^N/) { n = split(substr($i, 2), refs, ","); for (j = 1; j <= n; j++) print refs[j] } }
    $1 ~ /^r/ { for (i = 2; i <= NF; i++) if ($i ~ /^M/) { n = split(substr($i, 2), refs, ","); for (j = 1; j <= n; j++) if (refs[j] ~ /^n/) { sub(/@.*/, "", refs[j]); print refs[j] } } }
  ' > "${OUT}/node-ids.txt"
  echo "$(wc -l < "${OUT}/node-ids.txt") node references; streaming again (2/2: their nodes)"
  # getid exits with 1 when some ids are not in the input: nodes across the
  # border of a regional extract. That is fine; 2 is an error.
  curl -sSfL "${URL}" | { osmium getid -F pbf - -i "${OUT}/node-ids.txt" -O -f pbf -o "${OUT}/nodes.osm.pbf" || [ $? -eq 1 ]; }
  # Written under another name first, so an interrupted run leaves nothing to reuse.
  osmium merge "${OUT}/selected.osm.pbf" "${OUT}/nodes.osm.pbf" -O -f pbf -o "${OUT}/planet.osm.pbf.part"
  mv "${OUT}/planet.osm.pbf.part" "${OUT}/planet.osm.pbf"
  rm "${OUT}/selected.osm.pbf" "${OUT}/nodes.osm.pbf" "${OUT}/node-ids.txt"
  echo "Extract built after $(minutes) min"
fi

"$(dirname "$0")/update-line-relations.sh" "${OUT}/planet.osm.pbf" "${OUT}/lines.osm.pbf"
# The export only needs the line relations and the ways with these tags.
osmium tags-filter "${OUT}/lines.osm.pbf" r/route=railway w/tracks w/start_date w/opening_date -R -O \
  -o "${OUT}/tagged.osm.pbf"
osmium cat "${OUT}/tagged.osm.pbf" -f opl,add_metadata=false -O -o "${OUT}/lines.opl"
echo "Line relations ready after $(minutes) min"
