-- Functional + tenant-isolation test. Run via supabase/tests/run.sh on an
-- EMPTY throwaway database. Any failed check aborts with "FAIL: ...".
\set ON_ERROR_STOP 1
\set QUIET 1

create function pg_temp.check(ok boolean, msg text) returns text language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', msg; end if;
  return 'ok   ' || msg;
end $$;

-- true when the statement raises (used for "must be blocked" checks)
create function pg_temp.fails(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  return true;
end $$;

create function pg_temp.as_user(uid text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', uid, false);
$$;

create function pg_temp.ev(kind text, extra jsonb) returns jsonb language sql as $$
  select jsonb_build_object('kind', kind, 'client_id', gen_random_uuid()) || extra;
$$;

insert into auth.users values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.com');

set role authenticated;
\pset tuples_only on
\pset format unaligned

-- ═══════════ user A: setup ═══════════
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
select create_org('Org A') as org_a \gset
insert into products (org_id, name) values (:'org_a', 'Castle 4x4') returning id as prod_a \gset
select count(*) as n from generate_units(:'prod_a', 5) \gset
select pg_temp.check(:n = 5, 'generate 5 units');
select code as c1 from units order by code limit 1 offset 0 \gset
select code as c2 from units order by code limit 1 offset 1 \gset
select code as c3 from units order by code limit 1 offset 2 \gset

select pg_temp.check(jsonb_array_length(my_orgs()) = 1 and my_orgs()->0->>'name' = 'Org A', 'my_orgs');
select pg_temp.check(jsonb_array_length(pull_units(:'org_a')) = 5, 'pull_units returns all');
select pg_temp.check(jsonb_array_length(pull_units(:'org_a', null, 2)) = 2, 'pull_units limit');
select pg_temp.check(jsonb_array_length(pull_units(:'org_a', :'c2')) = 3, 'pull_units keyset after');

-- ═══════════ moves via sync ═══════════
\set mv1 '11111111-1111-1111-1111-111111111111'
select sync_events(jsonb_build_array(jsonb_build_object(
  'kind','move','client_id',:'mv1','org_id',:'org_a','code',lower(:'c1'),
  'direction','out','reference','Van 2','scanned_at', now() - interval '1 hour'))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'ok', 'move out ok (lowercase code normalised)');
select pg_temp.check((select status from units where code = :'c1') = 'out', 'unit is out');

-- retry of the SAME event (lost response) must not duplicate
select sync_events(jsonb_build_array(jsonb_build_object(
  'kind','move','client_id',:'mv1','org_id',:'org_a','code',:'c1',
  'direction','out','scanned_at', now() - interval '1 hour'))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'ok' and ((:'r'::jsonb)->0->>'replayed')::boolean, 'retry is replayed');
select pg_temp.check((select count(*) from movements) = 1, 'retry did not duplicate movement');

-- online device checks it back IN now
select sync_events(jsonb_build_array(pg_temp.ev('move', jsonb_build_object(
  'org_id',:'org_a','code',:'c1','direction','in','scanned_at', now())))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'ok', 'check in ok');

-- offline device syncs an OUT that was scanned 30 min ago → late, not applied
select sync_events(jsonb_build_array(pg_temp.ev('move', jsonb_build_object(
  'org_id',:'org_a','code',:'c1','direction','out','scanned_at', now() - interval '30 minutes')))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'late', 'older offline event is late');
select pg_temp.check((select status from units where code = :'c1') = 'in_stock', 'late event did not change status');
select pg_temp.check((select count(*) from movements where not applied) = 1, 'late event kept in history');

-- future timestamps are clamped to now (clock running ahead can't win forever)
select sync_events(jsonb_build_array(pg_temp.ev('move', jsonb_build_object(
  'org_id',:'org_a','code',:'c3','direction','out','scanned_at', now() + interval '10 days')))) as r \gset
select pg_temp.check((select last_moved_at <= now() from units where code = :'c3'), 'future scanned_at clamped');

-- batch: one bad event must not block the others
select sync_events(jsonb_build_array(
  pg_temp.ev('move', jsonb_build_object('org_id',:'org_a','code','NOPE999','direction','out')),
  pg_temp.ev('move', jsonb_build_object('org_id',:'org_a','code',:'c2','direction','sideways')),
  pg_temp.ev('move', jsonb_build_object('org_id',:'org_a','code',:'c2','direction','out')),
  pg_temp.ev('move', jsonb_build_object('org_id',:'org_a','code',:'c2','direction','out'))
)) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'unknown', 'batch[0] unknown');
select pg_temp.check((:'r'::jsonb)->1->>'result' = 'error', 'batch[1] error isolated');
select pg_temp.check((:'r'::jsonb)->2->>'result' = 'ok', 'batch[2] ok despite earlier error');
select pg_temp.check((:'r'::jsonb)->3->>'result' = 'already', 'batch[3] already out');
select pg_temp.check((:'r'::jsonb)->2 ? 'client_id', 'results carry client_id');

-- history
select pg_temp.check(jsonb_array_length(movement_history(:'org_a')) = 5, 'history lists all movements');
select pg_temp.check(jsonb_array_length(movement_history(:'org_a', p_code => lower(:'c1'))) = 3, 'history by code');
select pg_temp.check(jsonb_array_length(movement_history(:'org_a', p_reference => 'van')) = 1, 'history by reference');
select pg_temp.check(movement_history(:'org_a', p_code => :'c1')->0->>'user_email' = 'a@example.com', 'history shows user');
select movement_history(:'org_a', p_limit => 2) as page1 \gset
select pg_temp.check(jsonb_array_length(movement_history(:'org_a',
  p_before_at => ((:'page1'::jsonb)->1->>'scanned_at')::timestamptz,
  p_before_id => ((:'page1'::jsonb)->1->>'id')::uuid)) = 3, 'history keyset pagination');

-- ═══════════ stocktake via sync (session created offline) ═══════════
\set sess '22222222-2222-2222-2222-222222222222'
select sync_events(jsonb_build_array(
  jsonb_build_object('kind','session','client_id',:'sess','org_id',:'org_a','name','Nov count'),
  pg_temp.ev('scan', jsonb_build_object('session_id',:'sess','code',:'c1')),
  pg_temp.ev('scan', jsonb_build_object('session_id',:'sess','code',:'c1')),
  pg_temp.ev('scan', jsonb_build_object('session_id',:'sess','code',:'c2')),
  pg_temp.ev('scan', jsonb_build_object('session_id',:'sess','code','ZZZZ'))
)) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'ok', 'session created via sync');
select pg_temp.check((:'r'::jsonb)->1->>'result' = 'ok', 'scan ok');
select pg_temp.check((:'r'::jsonb)->2->>'result' = 'duplicate', 'second device scanning same unit = duplicate');
select pg_temp.check((:'r'::jsonb)->3->>'unit_status' = 'out', 'scan flags unit that system had as out');
select pg_temp.check((:'r'::jsonb)->4->>'result' = 'unknown', 'unknown code in count');
select pg_temp.check(jsonb_array_length(pull_scans(:'sess')) = 4, 'pull_scans');
select pg_temp.check(jsonb_array_length(pull_sessions(:'org_a')) = 1, 'pull_sessions');
select count_summary(:'sess') as s \gset
select pg_temp.check((:'s'::jsonb)->>'matched' = '1' and jsonb_array_length((:'s'::jsonb)->'extra') = 1, 'summary matched/extra');

select close_count(:'sess', true) as r \gset
select pg_temp.check((:'r'::jsonb)->>'found' = '1', 'close: found unit back in stock');
-- a scan synced after the session closed is rejected, not stored
select sync_events(jsonb_build_array(pg_temp.ev('scan', jsonb_build_object('session_id',:'sess','code',:'c3')))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'session_closed', 'late scan to closed session rejected');
select pg_temp.check(jsonb_array_length(pull_scans(:'sess')) = 4, 'closed-session scan not stored');

-- ═══════════ user B attacks org A ═══════════
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002') \gset
select pg_temp.check((select count(*) from orgs) = 0, 'B sees no orgs');
select pg_temp.check((select count(*) from units) = 0, 'B sees no units');
select pg_temp.check((select count(*) from movements) = 0, 'B sees no movements');
select pg_temp.check(jsonb_array_length(my_orgs()) = 0, 'B my_orgs empty');
select pg_temp.check(pg_temp.fails(format('select pull_units(%L)', :'org_a')), 'B cannot pull_units of A');
select pg_temp.check(pg_temp.fails(format('select movement_history(%L)', :'org_a')), 'B cannot read A history');
select pg_temp.check(pg_temp.fails(format('select pull_scans(%L)', :'sess')), 'B cannot pull A scans');
select pg_temp.check(pg_temp.fails(format('select pull_sessions(%L)', :'org_a')), 'B cannot pull A sessions');
select sync_events(jsonb_build_array(
  pg_temp.ev('move', jsonb_build_object('org_id',:'org_a','code',:'c2','direction','in')),
  jsonb_build_object('kind','move','client_id',:'mv1','org_id',:'org_a','code',:'c1','direction','in'),
  pg_temp.ev('scan', jsonb_build_object('session_id',:'sess','code',:'c1')),
  pg_temp.ev('session', jsonb_build_object('org_id',:'org_a','name','evil'))
)) as r \gset
select pg_temp.check((select bool_and(e->>'result' = 'error') from jsonb_array_elements(:'r'::jsonb) e), 'B sync into A: all rejected');

-- B replays A's client_id against B's own org: must not leak A's data
select create_org('Org B') as org_b \gset
select sync_events(jsonb_build_array(jsonb_build_object(
  'kind','move','client_id',:'mv1','org_id',:'org_b','code','X','direction','in'))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'error' and not ((:'r'::jsonb)->0 ? 'product'), 'B replaying A client_id leaks nothing');
select pg_temp.check(pg_temp.fails(format('insert into products (org_id,name) values (%L, %L)', :'org_a', 'evil')), 'B cannot insert into A');
select pg_temp.check(pg_temp.fails(format('insert into movements (org_id, unit_id, direction) values (%L, gen_random_uuid(), %L)', :'org_b', 'in')), 'no direct movement inserts');

-- ═══════════ A state untouched ═══════════
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
select pg_temp.check((select status from units where code = :'c2') = 'in_stock', 'A unit c2 untouched by B (back in stock after count)');
select pg_temp.check((select count(*) from count_sessions) = 1, 'no evil session in A');

reset role;
set role anon;
select pg_temp.check(pg_temp.fails('select sync_events(''[]''::jsonb)'), 'anon cannot sync');
select pg_temp.check(pg_temp.fails('select my_orgs()'), 'anon cannot my_orgs');
reset role;
\echo ALL CHECKS PASSED
