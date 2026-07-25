#!/usr/bin/env bash
# Rebuild the database, load fixtures, run every RLS test file, report results.
# Exits non-zero if any assertion failed.
#
#   ./scripts/test-rls.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-family_dashboard}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

q() { psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" "$@"; }

"$ROOT/scripts/db-reset.sh" >/dev/null

echo "==> Loading test harness and fixtures"
q -q -f "$ROOT/test/rls/00_helpers.sql"
q -q -f "$ROOT/test/rls/01_fixtures.sql"

echo "==> Running tests"
for f in "$ROOT"/test/rls/[0-9][0-9]_*.sql; do
  base="$(basename "$f")"
  case "$base" in 00_helpers.sql|01_fixtures.sql) continue ;; esac
  printf '    %s\n' "$base"
  q -q -f "$f" >/dev/null
done

echo
q -qtA -F'  ' -c "
  select suite,
         count(*) filter (where passed) || '/' || count(*) || ' passed'
  from test.results group by suite order by suite;"

failed=$(q -qtA -c "select count(*) from test.results where not passed")

if [ "$failed" -gt 0 ]; then
  echo
  echo "FAILURES:"
  q -qtA -F' | ' -c "select suite, name, coalesce(detail,'') from test.results where not passed order by id"
  echo
  echo "==> $failed assertion(s) FAILED"
  exit 1
fi

total=$(q -qtA -c "select count(*) from test.results")
echo
echo "==> all $total assertions passed"
