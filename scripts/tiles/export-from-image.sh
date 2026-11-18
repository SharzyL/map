#!/usr/bin/env bash
# Builds the railway tile archive from an OpenRailwayMap import database
# image: starts the database from the image, runs export-tippecanoe.sh against
# it and stops it again.
#
# Usage: ./scripts/tiles/export-from-image.sh <image reference> <out.pmtiles>
#
# The image reference may be pinned by digest
# (ghcr.io/hiddewie/openrailwaymap-import-db@sha256:...). export-tippecanoe.sh's
# environment variables pass through (LINE_RELATIONS_OPL, LINE_GROUPS_DIR,
# CR_STATION_TRAINS, JP_STATION_CODES, MAX_ZOOM, LAYERS, BBOX, ...).
#
# Needs docker, ogr2ogr, tippecanoe and pmtiles; on CI (CI=true) it installs
# the last three when missing and first frees the runner's disk, which the
# image and the export's intermediate files would otherwise fill.

set -euo pipefail

if [ $# -ne 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
IMAGE="$1"
OUT="$2"
PORT="${ORM_DB_PORT:-54329}"
CONTAINER="orm-db-$$"
WORK="$(mktemp -d)"
trap 'docker rm -f "${CONTAINER}" > /dev/null 2>&1 || true; rm -rf "${WORK}"' EXIT

if [ "${CI:-}" = "true" ]; then
  sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL
  docker image prune -af > /dev/null
  df -h / | tail -1
  if ! command -v ogr2ogr > /dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq gdal-bin
  fi
  if ! command -v tippecanoe > /dev/null; then
    sudo apt-get install -y -qq build-essential libsqlite3-dev zlib1g-dev
    git clone -q --depth 1 https://github.com/felt/tippecanoe.git "${WORK}/tippecanoe"
    make -s -C "${WORK}/tippecanoe" -j"$(nproc)" > /dev/null
    sudo make -s -C "${WORK}/tippecanoe" install > /dev/null
    rm -rf "${WORK}/tippecanoe"
  fi
  if ! command -v pmtiles > /dev/null; then
    curl -sSfL https://github.com/protomaps/go-pmtiles/releases/download/v1.22.3/go-pmtiles_1.22.3_Linux_x86_64.tar.gz \
      | sudo tar xz -C /usr/local/bin pmtiles
  fi
fi

echo "Starting the database from ${IMAGE}"
docker run -d --name "${CONTAINER}" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e PGDATA=/data/postgresql --shm-size=2g "${IMAGE}" > /dev/null
for _ in $(seq 1 180); do
  if docker exec "${CONTAINER}" psql -U postgres -d gis -c 'SELECT 1' > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "${ready:-}" ]; then
  echo "The database did not come up" >&2
  docker logs "${CONTAINER}" 2>&1 | tail -n 20 >&2
  exit 1
fi
docker exec "${CONTAINER}" psql -U postgres -d gis -At -c "
  SELECT 'railway_line ' || count(*) FROM railway_line
  UNION ALL SELECT 'stations ' || count(*) FROM stations"

DATABASE_URL="postgresql://postgres@127.0.0.1:${PORT}/gis" OUTPUT_DIR="${WORK}/output" \
  "$(dirname "$0")/export-tippecanoe.sh"

pmtiles show "${WORK}/output/openrailwaymap.pmtiles"
mkdir -p "$(dirname "${OUT}")"
mv "${WORK}/output/openrailwaymap.pmtiles" "${OUT}"
