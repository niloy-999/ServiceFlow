#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

export COREPACK_HOME="$PROJECT_ROOT/.cache/corepack"

mkdir -p "$COREPACK_HOME"

cd "$PROJECT_ROOT"

exec corepack pnpm "$@"
