#!/usr/bin/env bash
# Builds the SQL for the API's /api/v1/relations (build_relations.py) from the
# railway extract (data_builder/osm-railways) cut to the box around China and Japan,
# line-groups.sh's output for the same extract, and N02's stations
# (fetch-n02.sh) for Japan's official lines.
#
# Usage: N02_DIR=<dir> ./data_builder/relations/relations.sh <box.osm.pbf> <line-groups dir> <out.sql> [version]
#
# STATION_RANKS, when set, is where the stations' ranks go as CSV too.
#
# <box.osm.pbf> is the extract after
#   osmium extract -b 73,17,146,54 -s smart lines.osm.pbf
# (China and Japan, with what lies in between: Korea, Taiwan, ...). The data
# version is the extract's replication timestamp: [version], else the input's
# osmosis_replication_timestamp header, which osmium extract drops unless
# given --output-header.
#
# N02_DIR is fetch-n02.sh's output directory, of the edition line-groups.sh
# used. PYTHON overrides the interpreter, which needs osmium, numpy and scipy
# (PYTHON="uv run --script" installs them).
#
# Needs osmium and python3.

set -euo pipefail

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
EXTRACT="$1"
LINE_GROUPS="$2"
OUT="$3"
N02_DIR="${N02_DIR:?set N02_DIR to the output of fetch-n02.sh}"
PYTHON="${PYTHON:-python3}"

version="${4:-$(osmium fileinfo -g header.option.osmosis_replication_timestamp "${EXTRACT}")}"
if [ -z "${version}" ]; then
  echo "${EXTRACT} has no osmosis_replication_timestamp; give the version" >&2
  exit 1
fi
stations="$(find "${N02_DIR}" -name '*_Station.geojson')"
if [ ! -f "${stations}" ]; then
  echo "${N02_DIR} must hold one *_Station.geojson" >&2
  exit 1
fi

${PYTHON} "$(dirname "$0")/build_relations.py" "${EXTRACT}" "${LINE_GROUPS}" "${stations}" "${version}" "${OUT}" \
  ${STATION_RANKS:+"${STATION_RANKS}"}
