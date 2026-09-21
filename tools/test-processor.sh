#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -f Dockerfile.video-processor -t show-and-tell-processor:test .
tools=$(mktemp -d)
container=$(docker create show-and-tell-processor:test)
cleanup() {
  docker rm "$container" >/dev/null
  rm -rf "$tools"
}
trap cleanup EXIT
docker cp "$container:/usr/local/bin/ffmpeg" "$tools/ffmpeg"
docker cp "$container:/usr/local/bin/ffprobe" "$tools/ffprobe"
PATH="$tools:$PATH" npm run test:processor
