#!/usr/bin/env bash
# Groups Japan's railway ways into their official lines (line-groups.py) for
# export-tippecanoe.sh (LINE_GROUPS_DIR): OSM lacks route=railway relations
# for about a quarter of Japan's mainline track, and its way names vary too
# much to tell lines apart by name. The reference is MLIT's railway data
# (国土数値情報 N02, CC BY 4.0; the map credits it), downloaded here; the
# railway ways come from the railway extract (fetch-line-relations.sh), cut
# to Japan and given their node locations.
#
# Writes line_groups.csv and line_group_ways.csv, plus review.csv and
# unmatched.csv for checking the result, into <out-dir>.
#
# Usage: ./scripts/tiles/line-groups.sh <lines.osm.pbf> <out-dir>
#
# N02_URL overrides the N02 edition (a GML zip with a UTF-8 folder).
#
# Needs curl, osmium and python3.

set -euo pipefail

if [ $# -ne 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
EXTRACT="$1"
OUT="$2"
N02_URL="${N02_URL:-https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip}"
# Japan, Okinawa included; ways outside N02 in this box (Korea, Sakhalin) match nothing.
JAPAN_BBOX="122.9,24,146,45.6"
mkdir -p "${OUT}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "Downloading ${N02_URL}"
curl -sSfL "${N02_URL}" -o "${WORK}/n02.zip"
python3 -I - "${WORK}/n02.zip" "${WORK}/n02" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        if '/UTF-8/' in name and name.endswith(('_RailroadSection.geojson', '_Station.geojson')):
            archive.extract(name, sys.argv[2])
PY
sections="$(find "${WORK}/n02" -name '*_RailroadSection.geojson')"
stations="$(find "${WORK}/n02" -name '*_Station.geojson')"

osmium extract -b "${JAPAN_BBOX}" -s smart "${EXTRACT}" -O -o "${WORK}/japan.osm.pbf"
osmium add-locations-to-ways -n --ignore-missing-nodes "${WORK}/japan.osm.pbf" -f opl,add_metadata=false -O \
  -o "${WORK}/japan.opl"
python3 -I "$(dirname "$0")/line-groups.py" "${WORK}/japan.opl" "${sections}" "${stations}" "${OUT}"
