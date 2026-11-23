#!/bin/sh
set -eu

for variable in POSTGRES_BOOTSTRAP_PASSWORD SERVICEFLOW_APP_PASSWORD SERVICEFLOW_MIGRATOR_PASSWORD; do
  eval "value=\${$variable}"
  if [ -z "$value" ] || [ "${#value}" -lt 32 ]; then
    printf '%s\n' "Refusing PostgreSQL initialization: $variable must be replaced with a unique local value of at least 32 characters." >&2
    exit 1
  fi
done

if [ "$POSTGRES_BOOTSTRAP_PASSWORD" = "$SERVICEFLOW_APP_PASSWORD" ] ||
  [ "$POSTGRES_BOOTSTRAP_PASSWORD" = "$SERVICEFLOW_MIGRATOR_PASSWORD" ] ||
  [ "$SERVICEFLOW_APP_PASSWORD" = "$SERVICEFLOW_MIGRATOR_PASSWORD" ]; then
  printf '%s\n' 'Refusing PostgreSQL initialization: bootstrap, application, and migration passwords must differ.' >&2
  exit 1
fi

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=app_password="$SERVICEFLOW_APP_PASSWORD" \
  --set=migrator_password="$SERVICEFLOW_MIGRATOR_PASSWORD" \
  --file=/docker-entrypoint-initdb.d/roles.sql

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --file=/docker-entrypoint-initdb.d/databases.sql
