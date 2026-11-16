#!/usr/bin/env bash
# Usage: PGURL=postgres://postgres@localhost:5432/scratch supabase/tests/run.sh
# Needs an EMPTY throwaway database (it creates the auth schema + tables).
set -euo pipefail
cd "$(dirname "$0")"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f auth_shim.sql
for f in ../migrations/*.sql; do psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"; done
psql "$PGURL" -q -f smoke.sql
