#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
terminal=
if [ -t 0 ] && [ -t 1 ]; then
  terminal=1
fi
exec docker run --rm ${terminal:+-it} --user "$(id -u):$(id -g)" \
  --env TERM --env NO_COLOR \
  --mount "type=bind,source=$PWD,target=/workspace" --workdir /workspace \
  node:22-bookworm node scripts/setup.mjs --docker "$@"
