#!/usr/bin/env bash
# Brings an extract of route=railway relations up to date with OSM's hourly
# replication diffs, so it matches the (nightly) import database rather than
# the weekly planet it was cut from. Ways added to a line since then would
# otherwise miss the line in the tiles.
#
# Usage: ./scripts/tiles/update-line-relations.sh <in.osm.pbf> <out.osm.pbf>
#
# Each diff is filtered down to route=railway relations as it streams in, so
# memory stays small; a relation that lost its tag or was deleted since the
# planet is kept as it was. Needs curl and osmium.
#
# Environment variables:
#   REPLICATION_SERVER - default https://planet.openstreetmap.org/replication/hour
#   PARALLEL           - concurrent downloads (default: 8)

set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '7p' "$0" >&2
  exit 1
fi
IN="$1"
OUT="$2"
SERVER="${REPLICATION_SERVER:-https://planet.openstreetmap.org/replication/hour}"
PARALLEL="${PARALLEL:-8}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Value of key= in a replication state.txt (colons are escaped there).
state_value() {
  sed -n "s/^$2=//p" <<< "$1" | sed 's/\\//g'
}

sequence_path() {
  local padded
  padded="$(printf '%09d' "$1")"
  echo "${padded:0:3}/${padded:3:3}/${padded:6:3}"
}

file_time="$(osmium fileinfo -g header.option.osmosis_replication_timestamp "${IN}" 2>/dev/null || true)"
[ -n "${file_time}" ] || file_time="$(osmium fileinfo -g header.option.timestamp "${IN}")"
latest_state="$(curl -sSfL "${SERVER}/state.txt")"
latest_sequence="$(state_value "${latest_state}" sequenceNumber)"
latest_time="$(state_value "${latest_state}" timestamp)"

# Diffs are one per interval, so count back from the latest one. Start a
# couple of diffs early; applying a change the file already has is harmless
# because apply-changes keeps the newest version of each object.
case "${SERVER}" in
  */day) interval=86400 ;;
  */minute) interval=60 ;;
  *) interval=3600 ;;
esac
behind="$(( ($(date -d "${latest_time}" +%s) - $(date -d "${file_time}" +%s)) / interval ))"
first_sequence="$(( latest_sequence - behind - 2 ))"
echo "Extract from ${file_time}; applying diffs ${first_sequence}..${latest_sequence} (${latest_time})"

fetch_diff() {
  local sequence="$1"
  curl -sSfL --retry 5 --retry-all-errors "${SERVER}/$(sequence_path "${sequence}").osc.gz" \
    | osmium tags-filter -F osc.gz - r/route=railway -R -O -o "${WORK}/${sequence}.osc.gz" --output-format osc.gz
  # Report every 25 finished diffs.
  touch "${WORK}/${sequence}.ok"
  local finished
  finished="$(find "${WORK}" -name '*.ok' | wc -l)"
  if (( finished % 25 == 0 )); then echo "  ${finished} of ${TOTAL} diffs"; fi
}
TOTAL="$(( latest_sequence - first_sequence + 1 ))"
export -f fetch_diff sequence_path
export SERVER WORK TOTAL

seq "${first_sequence}" "${latest_sequence}" | xargs -P "${PARALLEL}" -I{} bash -c 'fetch_diff {}'

osmium apply-changes "${IN}" "${WORK}"/*.osc.gz -O -o "${OUT}" \
  --output-header="osmosis_replication_timestamp=${latest_time}"
echo "Updated line relations written to ${OUT}"
