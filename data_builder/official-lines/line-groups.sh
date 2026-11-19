#!/usr/bin/env bash
# Groups Japan's railway ways into their official lines (line-groups.py) for
# the tile export (LINE_GROUPS_DIR) and relations.sh: OSM lacks
# route=railway relations for about a quarter of Japan's mainline track, and
# its way names vary too much to tell lines apart by name. The reference is
# MLIT's railway data (国土数値情報 N02, CC BY 4.0; the map credits it), as
# fetch-n02.sh extracts it; the railway ways come from the railway extract
# (data_builder/osm-railways), cut to Japan and given their node locations.
#
# Writes line_groups.csv and line_group_ways.csv, plus review.csv and
# unmatched.csv for checking the result, into <out-dir>.
#
# Usage: N02_DIR=<dir> ./data_builder/official-lines/line-groups.sh <lines.osm.pbf> <out-dir>
#
# N02_DIR is fetch-n02.sh's output directory.
#
# Needs osmium and python3.

set -euo pipefail

if [ $# -ne 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
EXTRACT="$1"
OUT="$2"
N02_DIR="${N02_DIR:?set N02_DIR to the output of fetch-n02.sh}"
# Japan, Okinawa included; ways outside N02 in this box (Korea, Sakhalin) match nothing.
JAPAN_BBOX="122.9,24,146,45.6"
mkdir -p "${OUT}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

sections="$(find "${N02_DIR}" -name '*_RailroadSection.geojson')"
stations="$(find "${N02_DIR}" -name '*_Station.geojson')"
if [ ! -f "${sections}" ] || [ ! -f "${stations}" ]; then
  echo "${N02_DIR} must hold one *_RailroadSection.geojson and one *_Station.geojson" >&2
  exit 1
fi

osmium extract -b "${JAPAN_BBOX}" -s smart "${EXTRACT}" -O -o "${WORK}/japan.osm.pbf"
osmium add-locations-to-ways -n --ignore-missing-nodes "${WORK}/japan.osm.pbf" -f opl,add_metadata=false -O \
  -o "${WORK}/japan.opl"
python3 -I "$(dirname "$0")/line-groups.py" "${WORK}/japan.opl" "${sections}" "${stations}" "${OUT}"
