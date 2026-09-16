#!/usr/bin/env bash
#
# Starts a local PostgreSQL cluster and prepares the development and test
# databases. Idempotent: safe to re-run.
#
# docker compose is the normal path (see docker-compose.yml). This script exists
# for environments without a Docker daemon — CI runners with a Postgres service,
# and sandboxes where only the postgres binaries are available.
#
# Usage:  ./scripts/local-postgres.sh [start|stop|reset|status]

set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/var/lib/postgresql/aiw}"
PGPORT="${PGPORT:-5432}"
PGLOG="${PGLOG:-/var/lib/postgresql/aiw.log}"
DEV_DB="${DEV_DB:-ai_workforce}"
TEST_DB="${TEST_DB:-ai_workforce_test}"
# Test-only password for the least-privilege role. Production sets this out of
# band; see docs/deployment.md.
APP_USER_PASSWORD="${APP_USER_PASSWORD:-app_user_test_password}"

export PATH="$PG_BIN:$PATH"

as_postgres() {
  su postgres -c "PATH=$PG_BIN:\$PATH $1"
}

psql_super() {
  psql "postgres://postgres@127.0.0.1:$PGPORT/$1" -v ON_ERROR_STOP=1 -q "${@:2}"
}

start() {
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "==> Initializing cluster at $PGDATA"
    mkdir -p "$PGDATA"
    chown postgres:postgres "$PGDATA"
    chmod 700 "$PGDATA"
    as_postgres "initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
  fi

  if as_postgres "pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
    echo "==> Cluster already running"
  else
    echo "==> Starting cluster on port $PGPORT"
    as_postgres "pg_ctl -D $PGDATA -l $PGLOG -o '-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1' -w start" >/dev/null
  fi

  for db in "$DEV_DB" "$TEST_DB"; do
    if ! psql "postgres://postgres@127.0.0.1:$PGPORT/postgres" -tAc \
        "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
      echo "==> Creating database $db"
      psql "postgres://postgres@127.0.0.1:$PGPORT/postgres" -q -c "CREATE DATABASE $db"
    fi
  done

  echo "==> Applying migrations"
  for db in "$DEV_DB" "$TEST_DB"; do
    # 0000 creates enum types, which have no IF NOT EXISTS form, so re-running
    # it aborts. Skip the base migration once the schema exists; the RLS
    # migration is written to be idempotent and is always re-applied so a
    # policy change lands without a full reset.
    already_migrated=$(psql "postgres://postgres@127.0.0.1:$PGPORT/$db" -tAc \
      "SELECT to_regclass('public.organizations') IS NOT NULL")

    for migration in drizzle/*.sql; do
      case "$migration" in
        *0000_*) [ "$already_migrated" = "t" ] && continue ;;
      esac
      psql "postgres://postgres@127.0.0.1:$PGPORT/$db" -v ON_ERROR_STOP=1 -q \
        -f "$migration" 2>&1 | grep -Ev 'NOTICE' || true
    done
  done

  # The integration tests connect as app_user so row-level security is actually
  # exercised. A superuser connection bypasses RLS entirely, which would make
  # the isolation tests pass without proving anything.
  echo "==> Granting login to app_user (test database)"
  psql_super "$TEST_DB" -c "ALTER ROLE app_user LOGIN PASSWORD '$APP_USER_PASSWORD'"
  psql_super "$TEST_DB" -c "GRANT CONNECT ON DATABASE $TEST_DB TO app_user"
  psql_super "$DEV_DB"  -c "GRANT CONNECT ON DATABASE $DEV_DB TO app_user"

  echo
  echo "Ready."
  echo "  DATABASE_URL=postgres://postgres@127.0.0.1:$PGPORT/$DEV_DB"
  echo "  TEST_DATABASE_URL=postgres://app_user:$APP_USER_PASSWORD@127.0.0.1:$PGPORT/$TEST_DB"
  echo "  TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:$PGPORT/$TEST_DB"
}

stop() {
  as_postgres "pg_ctl -D $PGDATA -m fast stop" || true
}

reset() {
  stop
  rm -rf "$PGDATA"
  start
}

status() {
  as_postgres "pg_ctl -D $PGDATA status" || echo "not running"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  status) status ;;
  *) echo "Usage: $0 [start|stop|reset|status]" >&2; exit 1 ;;
esac
