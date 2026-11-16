#!/usr/bin/env bash
# Offline end-to-end test: real SQL + real browser, Supabase API mocked (RPCs only).
# Needs: Postgres 15+ reachable via PGHOST/PGPORT/PGUSER, and Playwright + Chromium.
# Usage: PGHOST=localhost PGUSER=postgres e2e/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PGDATABASE=${PGDATABASE:-stb_e2e}
OUT=$(mktemp -d)
psql -q -d postgres -c "drop database if exists $PGDATABASE" -c "create database $PGDATABASE"
psql -q -v ON_ERROR_STOP=1 -f supabase/tests/auth_shim.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -f "$f"; done
psql -q -t -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001','ops@example.com');
set role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001',false);
select create_org('Blast Hire') as org \gset
insert into products (org_id,name) values (:'org','Castle 4x4') returning id as p \gset
select count(*) from generate_units(:'p', 3);
SQL
VITE_SUPABASE_URL=http://localhost:5191 VITE_SUPABASE_ANON_KEY=test npx vite build --outDir "$OUT/dist" >/dev/null
node e2e/mock.cjs "$OUT/dist" & MOCK=$!
trap 'kill $MOCK' EXIT
sleep 1
node e2e/offline.cjs "$OUT"
echo "screenshots: $OUT"
