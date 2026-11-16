#!/usr/bin/env bash
# Usage: PGURL=postgres://postgres@localhost:5432/scratch supabase/tests/run.sh
# Needs an EMPTY throwaway database (it creates the auth schema + tables).
set -euo pipefail
cd "$(dirname "$0")"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f auth_shim.sql
psql "$PGURL" -v ON_ERROR_STOP=1 -q -f ../migrations/20261116000000_init.sql
psql "$PGURL" -q -f smoke.sql
