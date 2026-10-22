#!/usr/bin/env bash
# Load local images into the k3d cluster, then check that every one arrived.
#   scripts/import-images.sh <cluster> <image>...
# Direct mode streams each image into the node. The default mode goes through a tools node and a shared tarball,
# which sometimes loses the tarball and still reports success: pods then sit in ImagePullBackOff with no hint why.
set -euo pipefail

cluster=$1
shift
node="k3d-${cluster}-server-0"

# Prints the images the node doesn't have, one per line.
missing() {
  local have img
  have=$(docker exec "$node" ctr -n k8s.io images ls -q)
  for img in "$@"; do
    grep -qx "docker.io/${img}" <<<"$have" || echo "$img"
  done
}

k3d image import -m direct -c "$cluster" "$@"

left=$(missing "$@")
if [ -n "$left" ]; then
  echo "k3d reported success but these images are not in $node: $(echo "$left" | tr '\n' ' ')Retrying." >&2
  # shellcheck disable=SC2086 # one image per word; image names have no spaces
  k3d image import -m direct -c "$cluster" $left
  # shellcheck disable=SC2086
  left=$(missing $left)
fi
if [ -n "$left" ]; then
  echo "Still missing from $node after a retry: $(echo "$left" | tr '\n' ' ')" >&2
  exit 1
fi
echo "All $# images are in $node."
