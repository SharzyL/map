#!/usr/bin/env bash
# Downloads MLIT's railway data (国土数値情報 N02, CC BY 4.0; the map credits
# it) and extracts the two files line-groups.sh and relations.sh read (their
# N02_DIR): the lines' sections and the stations, as UTF-8 GeoJSON.
#
# Usage: ./scripts/lines/fetch-n02.sh <N02 zip URL> <out-dir>
#
# The URL is an edition's GML zip with a UTF-8 folder, e.g.
# https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-25/N02-25_GML.zip
#
# Needs curl and python3.

set -euo pipefail

if [ $# -ne 2 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
URL="$1"
OUT="$2"
mkdir -p "${OUT}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "Downloading ${URL}"
curl -sSfL --retry 3 "${URL}" -o "${WORK}/n02.zip"
python3 -I - "${WORK}/n02.zip" "${OUT}" <<'PY'
import shutil
import sys
import zipfile
from pathlib import Path

found = set()
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        for kind in ('_RailroadSection.geojson', '_Station.geojson'):
            if '/UTF-8/' in name and name.endswith(kind):
                # Flat, whatever folders the edition has
                with archive.open(name) as source, open(Path(sys.argv[2]) / Path(name).name, 'wb') as target:
                    shutil.copyfileobj(source, target)
                found.add(kind)
if len(found) != 2:
    sys.exit('no UTF-8 RailroadSection and Station GeoJSON in the archive')
PY
ls -l "${OUT}"
