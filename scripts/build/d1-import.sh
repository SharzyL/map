#!/usr/bin/env bash
# Imports one of the build's SQL files into the Worker's D1 database, then
# drops the tables of the versions it replaced. Each file writes tables named
# by its data version and switches the views to them last, so a failed import
# leaves the previous version serving; the script that wrote the file knows
# its tables (its --list-old and --drop-old).
#
# Usage: ./scripts/build/d1-import.sh <file.sql> <script.py> <version> [<version> ...]
#
# <version>s are what the script's --drop-old takes: the versions to keep.
# Needs wrangler's credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).

set -euo pipefail

if [ $# -lt 3 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
SQL="$1"
SCRIPT="$2"
shift 2
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

d1() { pnpm exec wrangler d1 execute cr --remote --yes "$@"; }

d1 --file="${SQL}" > "${WORK}/import.log" || { tail -n 40 "${WORK}/import.log" >&2; exit 1; }
grep -E '"(rows_written|size_after)"' "${WORK}/import.log" || true
# The import switched the views; now drop the tables of other versions
d1 --json --command "$(python3 "${SCRIPT}" --list-old)" > "${WORK}/tables.json"
drop="$(python3 "${SCRIPT}" --drop-old "$@" < "${WORK}/tables.json")"
if [ -n "${drop}" ]; then
  echo "${drop}"
  d1 --command "${drop}" > /dev/null
fi
