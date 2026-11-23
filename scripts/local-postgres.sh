#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$PROJECT_ROOT/.env.local"
COMPOSE_FILE="$PROJECT_ROOT/infra/local/postgres/compose.yaml"
VOLUME_NAME=serviceflow-phase1-postgres-data
STATE_DIR="$PROJECT_ROOT/.local"
VOLUME_MARKER="$STATE_DIR/serviceflow-postgres-volume-id"

if [ ! -f "$ENV_FILE" ]; then
  printf '%s\n' "Missing .env.local. Create it only if it does not already exist, then replace its placeholders. See README.md." >&2
  exit 1
fi

if [ "$#" -ne 1 ] || { [ "$1" != up ] && [ "$1" != stop ]; }; then
  printf '%s\n' "Usage: scripts/local-postgres.sh {up|stop}" >&2
  exit 2
fi

cd "$PROJECT_ROOT"

if [ "$1" = up ]; then
  if grep -Eq '^(POSTGRES_BOOTSTRAP_PASSWORD|SERVICEFLOW_APP_PASSWORD|SERVICEFLOW_MIGRATOR_PASSWORD)=($|REPLACE_)' "$ENV_FILE"; then
    printf '%s\n' 'Refusing to initialize PostgreSQL while placeholder credentials remain in .env.local.' >&2
    exit 1
  fi

  if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    if [ ! -f "$VOLUME_MARKER" ]; then
      printf '%s\n' "Refusing to reuse pre-existing volume '$VOLUME_NAME' without this helper's ownership marker." >&2
      exit 1
    fi

    volume_identity=$(docker volume inspect --format '{{.Name}}|{{.CreatedAt}}' "$VOLUME_NAME")
    marker_identity=$(cat "$VOLUME_MARKER")
    if [ "$volume_identity" != "$marker_identity" ]; then
      printf '%s\n' "Refusing to reuse volume '$VOLUME_NAME': its identity differs from the recorded project volume." >&2
      exit 1
    fi
  elif [ -e "$VOLUME_MARKER" ]; then
    printf '%s\n' 'Refusing to create a replacement volume while a stale ownership marker exists.' >&2
    exit 1
  fi

  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d db
  volume_identity=$(docker volume inspect --format '{{.Name}}|{{.CreatedAt}}' "$VOLUME_NAME")
  mkdir -p "$STATE_DIR"
  (set -C; printf '%s' "$volume_identity" > "$VOLUME_MARKER")
else
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop db
fi
