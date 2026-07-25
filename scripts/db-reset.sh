#!/usr/bin/env bash
# Drop and rebuild the local test database, then apply the shim + every
# migration in order. Used by the RLS test suite and safe to run repeatedly.
#
#   PGPORT=55432 ./scripts/db-reset.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-family_dashboard}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
# Migrations use `drop ... if exists` for idempotency, which is chatty on a
# fresh database. Only surface warnings and errors.
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

psql_admin() { psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres "$@"; }
psql_app()   { psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"; }

echo "==> Recreating database '$PGDATABASE'"
psql_admin -qc "drop database if exists $PGDATABASE with (force);" >/dev/null
psql_admin -qc "create database $PGDATABASE;" >/dev/null

echo "==> Applying local shim"
psql_app -q -f "$ROOT/supabase/local/00_local_shim.sql"

echo "==> Applying migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  psql_app -q -f "$f"
done

echo "==> Done"
