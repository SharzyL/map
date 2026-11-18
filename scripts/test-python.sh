#!/usr/bin/env bash
# Runs the Python tests of the data scripts (scripts/*/test_*.py), one
# directory at a time: the directories are not packages, and each test imports
# the modules beside it by name.
#
# Usage: ./scripts/test-python.sh
#
# The relations and routing tests need osmium (pyosmium), numpy, scipy and
# shapely: nix-shell scripts/routing/shell.nix --run ./scripts/test-python.sh

set -euo pipefail

cd "$(dirname "$0")"
failed=0
for dir in */; do
  if compgen -G "${dir}test_*.py" > /dev/null; then
    echo "== scripts/${dir%/}"
    python3 -m unittest discover -s "${dir}" -p 'test_*.py' || failed=1
  fi
done
exit "${failed}"
