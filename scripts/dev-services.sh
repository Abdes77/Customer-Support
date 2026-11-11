#!/usr/bin/env bash
# Starts the local PostgreSQL 16 server that development and tests use, and creates the
# "hsrb" role with the hsrb_dev and hsrb_test databases. Safe to run repeatedly.
#
# Usage: pnpm services:up | pnpm services:down | pnpm services:status
#
# The connection strings match the examples in .env.example:
#   postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_dev
#   postgresql://hsrb:hsrb@127.0.0.1:5432/hsrb_test
set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"
PG_CLUSTER="${PG_CLUSTER:-main}"
PG_PORT="${PG_PORT:-5432}"
DB_USER="hsrb"
DB_PASSWORD="hsrb"
DATABASES=("hsrb_dev" "hsrb_test")

as_postgres() {
  if [ "$(id -u)" -eq 0 ]; then
    su postgres -s /bin/bash -c "$1"
  else
    sudo -u postgres bash -c "$1"
  fi
}

is_up() {
  pg_isready -q -h 127.0.0.1 -p "$PG_PORT"
}

start_postgres() {
  if is_up; then
    return 0
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start || true
  elif command -v service >/dev/null 2>&1; then
    service postgresql start || true
  fi
  for _ in $(seq 1 30); do
    if is_up; then
      return 0
    fi
    sleep 0.5
  done
  echo "PostgreSQL did not start on port $PG_PORT. Set DATABASE_URL and TEST_DATABASE_URL to a server you run yourself." >&2
  return 1
}

ensure_role_and_databases() {
  as_postgres "psql -p $PG_PORT -v ON_ERROR_STOP=1 -qtA" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';
  END IF;
  -- Same shape as the "postgres" role on Supabase: not a superuser, but it may create
  -- databases and roles and it bypasses row-level security. Tests that check row-level
  -- security must therefore SET ROLE to a restricted role, exactly as on Supabase.
  ALTER ROLE $DB_USER CREATEDB CREATEROLE BYPASSRLS;
END
\$\$;
SQL
  for db in "${DATABASES[@]}"; do
    exists="$(as_postgres "psql -p $PG_PORT -qtA -c \"SELECT 1 FROM pg_database WHERE datname = '$db'\"")"
    if [ "$exists" != "1" ]; then
      as_postgres "createdb -p $PG_PORT -O $DB_USER $db"
    fi
  done
}

case "${1:-up}" in
  up)
    start_postgres
    ensure_role_and_databases
    echo "PostgreSQL $PG_VERSION is up on 127.0.0.1:$PG_PORT (databases: ${DATABASES[*]}, role: $DB_USER)."
    ;;
  down)
    if command -v pg_ctlcluster >/dev/null 2>&1; then
      pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" stop || true
    fi
    echo "PostgreSQL stopped."
    ;;
  status)
    if is_up; then
      echo "PostgreSQL: up on 127.0.0.1:$PG_PORT"
    else
      echo "PostgreSQL: down"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 up|down|status" >&2
    exit 2
    ;;
esac
