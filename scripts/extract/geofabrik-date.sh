#!/usr/bin/env bash
# Prints the date (YYMMDD) of the newest Geofabrik extracts that every region
# given has as a dated file (<region>-YYMMDD.osm.pbf): the version of the
# regional extracts as a build source. Geofabrik cuts its regions daily and
# keeps the dated files about a week, so a date pinned longer ago than that
# can no longer be built from.
#
# Usage: ./scripts/extract/geofabrik-date.sh <region> [<region> ...]
#
# e.g. asia russia/far-eastern-fed-district. Needs curl.

set -euo pipefail

if [ $# -lt 1 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
BASE="${GEOFABRIK:-https://download.geofabrik.de}"
# The day of the latest cut, from the first region's replication state
latest="$(curl -sSfL "${BASE}/$1-updates/state.txt" | sed -n 's/^timestamp=//p' | tr -d '\\')"
for back in 0 1 2; do
  date="$(date -u -d "${latest:0:10} - ${back} day" +%y%m%d)"
  for region in "$@"; do
    curl -sSfIL -o /dev/null "${BASE}/${region}-${date}.osm.pbf" || continue 2
  done
  echo "${date}"
  exit 0
done
echo "no date in the last three days has every region" >&2
exit 1
