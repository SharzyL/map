#!/usr/bin/env bash
# Builds a railway extract with coordinates from regional OSM extracts
# (Geofabrik's): the objects railway-extract.filter keeps, and the nodes their
# ways run through and their relations list. Regional files fit on disk, so
# osmium reads each twice and follows the references itself, which the
# planet, only streamed (filter-planet.sh), does not allow.
#
# Usage: ./scripts/extract/filter-region.sh <out.osm.pbf> <.osm.pbf URL> [<.osm.pbf URL> ...]
#
# The files must be of one moment (Geofabrik cuts its regions together): the
# output has their osmosis_replication_timestamp, from which update.sh brings
# it up to date. Objects in more than one file (ways across a border) are kept
# once. Each download is filtered and deleted before the next, so the disk
# holds one at a time.
#
# Needs curl, osmium and python3.

set -euo pipefail

if [ $# -lt 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
OUT="$1"
shift
FILTER="$(dirname "$0")/railway-extract.filter"
METER="$(dirname "$0")/meter.py"
mkdir -p "$(dirname "${OUT}")"
WORK="$(mktemp -d "$(dirname "${OUT}")/filter-region.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

timestamp=""
part=0
for url in "$@"; do
  part=$((part + 1))
  size="$(curl -sSfIL "${url}" | tr -d '\r' | sed -n 's/^content-length: *//Ip' | tail -n 1)"
  echo "Downloading ${url}"
  curl -sSfL "${url}" | python3 -I "${METER}" "$(basename "${url}")" ${size} --every 60 > "${WORK}/in.osm.pbf"
  at="$(osmium fileinfo -g header.option.osmosis_replication_timestamp "${WORK}/in.osm.pbf")"
  if [ -z "${at}" ]; then
    echo "${url} has no osmosis_replication_timestamp" >&2
    exit 1
  fi
  if [ -n "${timestamp}" ] && [ "${at}" != "${timestamp}" ]; then
    echo "${url} is of ${at}, the files before it of ${timestamp}" >&2
    exit 1
  fi
  timestamp="${at}"
  # From a file osmium follows references: the nodes of the kept ways come along
  osmium tags-filter "${WORK}/in.osm.pbf" -e "${FILTER}" -O -o "${WORK}/part-${part}.osm.pbf"
  rm "${WORK}/in.osm.pbf"
done
osmium merge "${WORK}"/part-*.osm.pbf -O -o "${WORK}/merged.osm.pbf" \
  --output-header="osmosis_replication_timestamp=${timestamp}"
mv "${WORK}/merged.osm.pbf" "${OUT}"
echo "Railway extract of ${part} regions as of ${timestamp}"
