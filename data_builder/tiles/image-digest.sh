#!/usr/bin/env bash
# Prints the digest a container image tag points at now, asked from its
# registry without pulling: the version of the image as a build source.
#
# Usage: ./data_builder/tiles/image-digest.sh ghcr.io/<owner>/<image>:<tag>
#
# Public images on ghcr.io only. Needs curl and python3.

set -euo pipefail

if [ $# -ne 1 ]; then
  grep '^# Usage:' "$0" >&2
  exit 1
fi
image="${1#ghcr.io/}"
name="${image%:*}"
tag="${image##*:}"
token="$(curl -sSfL "https://ghcr.io/token?scope=repository:${name}:pull" \
  | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["token"])')"
curl -sSfIL "https://ghcr.io/v2/${name}/manifests/${tag}" \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
  -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  | tr -d '\r' | sed -n 's/^docker-content-digest: //Ip'
