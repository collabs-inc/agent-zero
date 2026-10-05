#!/bin/sh
set -eu
cube_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export CUBE_AGENT_ZERO_DATA_DIR="${CUBE_AGENT_ZERO_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cube-agent-zero}"
mkdir -p "$CUBE_AGENT_ZERO_DATA_DIR"
# Shared infrastructure must start before the application lock is acquired.
node "$cube_dir/ensure-docker.mjs"
# Hold an advisory lock for the whole foreground run. It is released by the OS
# on a crash, so stale container ownership can be recovered without a race.
exec flock --no-fork --nonblock "$CUBE_AGENT_ZERO_DATA_DIR/cube-app.lock" node "$cube_dir/start.mjs" "$@"
