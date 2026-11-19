#!/usr/bin/env bash
# Runs the Python tests of the data build (data_builder/test_*.py and
# data_builder/*/test_*.py), one directory at a time: the directories are not
# packages, and each test imports the modules beside it by name.
#
# Usage: ./data_builder/test.sh
#
# The relations and routing tests need osmium (pyosmium), numpy, scipy and
# shapely: nix-shell data_builder/shell.nix --run ./data_builder/test.sh

set -euo pipefail

cd "$(dirname "$0")"
failed=0
for dir in ./ */; do
  if compgen -G "${dir}test_*.py" > /dev/null; then
    name="data_builder/${dir#./}"
    echo "== ${name%/}"
    python3 -m unittest discover -s "${dir}" -p 'test_*.py' || failed=1
  fi
done
exit "${failed}"
