#!/usr/bin/env sh
# Prints the digest currently published for a tag, so a deploy always pins
# what was actually built.
#
# The digest in server/deploy/deployment.yaml is only a snapshot: the image
# labels embed the commit SHA, so every push to main produces a new digest and
# any value committed to the repo is stale the moment it is committed.
#
#   ./server/scripts/current-digest.sh            # tag "main"
#   ./server/scripts/current-digest.sh v1.0.0
#
# Needs only sh + curl. The package is public, so no credentials.
set -eu

IMAGE="${IMAGE:-therehim/tableplanner}"
TAG="${1:-main}"

TOKEN=$(curl -fsSL "https://ghcr.io/token?scope=repository:${IMAGE}:pull" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "could not get a pull token for ${IMAGE}" >&2; exit 1; }

DIGEST=$(curl -fsSL -o /dev/null -D - \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${IMAGE}/manifests/${TAG}" \
  | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: //p')

[ -n "$DIGEST" ] || { echo "no digest for ${IMAGE}:${TAG}" >&2; exit 1; }
echo "ghcr.io/${IMAGE}@${DIGEST}"
