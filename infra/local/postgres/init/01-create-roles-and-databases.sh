#!/bin/sh
set -eu

bootstrap_password=${POSTGRES_PASSWORD:-}
app_password=${SERVICEFLOW_APP_PASSWORD:-}
migrator_password=${SERVICEFLOW_MIGRATOR_PASSWORD:-}

for value in "$bootstrap_password" "$app_password" "$migrator_password"; do
  if [ -z "$value" ] || [ "${#value}" -lt 32 ]; then
    printf '%s\n' 'Refusing PostgreSQL initialization: bootstrap, application, and migration passwords must each be at least 32 characters.' >&2
    exit 1
  fi
done

if [ "$bootstrap_password" = "$app_password" ] ||
  [ "$bootstrap_password" = "$migrator_password" ] ||
  [ "$app_password" = "$migrator_password" ]; then
  printf '%s\n' 'Refusing PostgreSQL initialization: bootstrap, application, and migration passwords must differ.' >&2
  exit 1
fi

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --file=/docker-entrypoint-initdb.d/sql/roles.sql

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --file=/docker-entrypoint-initdb.d/sql/databases.sql
