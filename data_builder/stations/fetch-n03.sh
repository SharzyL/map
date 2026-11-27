#!/usr/bin/env bash
# Downloads MLIT's administrative boundaries (国土数値情報 N03, CC BY 4.0; the
# map credits it) and extracts the municipalities' shapefile (.shp, .shx and
# .dbf, UTF-8) that station-index.py reads to give Japan's stations their
# prefecture and municipality.
#
# Usage: ./data_builder/stations/fetch-n03.sh <N03 zip URL> <out-dir>
#
# The URL is an edition's GML zip, e.g.
# https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_GML.zip
# (~800 MB; the shapefile is ~280 MB of it).
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
curl -sSfL --retry 3 "${URL}" -o "${WORK}/n03.zip"
python3 -I - "${WORK}/n03.zip" "${OUT}" <<'PY'
import shutil
import sys
import zipfile
from pathlib import Path

found = set()
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in archive.namelist():
        path = Path(name)
        # The municipalities' polygons, not the prefectures' (_prefecture)
        if path.suffix in ('.shp', '.shx', '.dbf') and not path.stem.endswith('_prefecture'):
            with archive.open(name) as source, open(Path(sys.argv[2]) / f'N03{path.suffix}', 'wb') as target:
                shutil.copyfileobj(source, target)
            found.add(path.suffix)
if len(found) != 3:
    sys.exit('no municipalities shapefile (.shp, .shx, .dbf) in the archive')
PY
ls -l "${OUT}"
