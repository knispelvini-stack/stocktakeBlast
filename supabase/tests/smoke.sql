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
reset role;
select create_org('Org A') as org_a \gset
set role authenticated;
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
select pg_temp.check((select e->>'last_ref' from jsonb_array_elements(pull_units(:'org_a')) e where e->>'code' = :'c1') = 'Van 2', 'pull_units: out reference');
select pg_temp.check((select e->>'last_ref' from jsonb_array_elements(pull_units(:'org_a')) e where e->>'code' = :'c2') is null, 'pull_units: no reference when in stock');

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
select pg_temp.check(movement_history(:'org_a', p_code => :'c1')->0->>'user_label' = 'a@example.com', 'history shows user');
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


-- ═══════════ PIN access (single company) ═══════════
reset role;
insert into auth.users (id, email, is_anonymous) values
  ('cccccccc-0000-0000-0000-000000000003', null, true),
  ('dddddddd-0000-0000-0000-000000000004', null, true);
set role authenticated;
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
select pg_temp.check(pg_temp.fails('select create_org(''nope'')'), 'create_org not callable from the app');
select pg_temp.check(pg_temp.fails(format('select set_pin(%L, %L)', :'org_a', '123')), 'PIN shorter than 6 digits rejected');
select pg_temp.check(pg_temp.fails(format('select set_pin(%L, %L)', :'org_a', 'abcdef')), 'non-numeric PIN rejected');
select pg_temp.check((set_pin(:'org_a', '482915')->>'ok')::boolean, 'owner sets PIN');
select pg_temp.check((pin_status(:'org_a')->>'has_pin')::boolean, 'pin_status');
select pg_temp.check(pg_temp.fails('select * from org_pins'), 'PIN hashes not readable');
select pg_temp.check(pg_temp.fails('select * from pin_attempts'), 'PIN attempts not readable');

-- anonymous device C
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003') \gset
select pg_temp.check(jsonb_array_length(my_orgs()) = 0, 'new device has no company');
select pg_temp.check(pg_temp.fails(format('select pull_units(%L)', :'org_a')), 'device without PIN cannot read');
select pg_temp.check(pg_temp.fails('select join_with_pin(''482915'', '''')'), 'name required');
select pg_temp.check(join_with_pin('000000', 'Joao') is null, 'wrong PIN returns null');
select pg_temp.check(join_with_pin('482915', 'Joao') = :'org_a'::uuid, 'right PIN joins the company');
select pg_temp.check(my_orgs()->0->>'display_name' = 'Joao' and my_orgs()->0->>'role' = 'member', 'device is member with its name');
select pg_temp.check(jsonb_array_length(pull_units(:'org_a')) = 5, 'joined device reads units');
select sync_events(jsonb_build_array(pg_temp.ev('move', jsonb_build_object('org_id',:'org_a','code',:'c3','direction','in')))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'ok', 'joined device syncs moves');
select pg_temp.check(movement_history(:'org_a', p_code => :'c3')->0->>'user_label' = 'Joao', 'history shows device name');
select pg_temp.check(pg_temp.fails(format('select set_pin(%L, %L)', :'org_a', '111111')), 'device cannot change PIN');
select pg_temp.check(pg_temp.fails(format('select list_devices(%L)', :'org_a')), 'device cannot list devices');
select pg_temp.check(pg_temp.fails(format('select remove_device(%L, %L)', :'org_a', 'aaaaaaaa-0000-0000-0000-000000000001')), 'device cannot remove owner');
select touch_device(:'org_a');

-- device D: brute force is throttled per device
select pg_temp.as_user('dddddddd-0000-0000-0000-000000000004') \gset
select join_with_pin('100000', 'Eve'), join_with_pin('100001', 'Eve'), join_with_pin('100002', 'Eve'),
       join_with_pin('100003', 'Eve'), join_with_pin('100004', 'Eve');
select pg_temp.check(pg_temp.fails('select join_with_pin(''482915'', ''Eve'')'), '6th try blocked even with right PIN');
select pg_temp.check(jsonb_array_length(my_orgs()) = 0, 'throttled device did not join');

-- owner manages devices
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
select pg_temp.check(jsonb_array_length(list_devices(:'org_a')) = 2, 'owner lists devices (owner + Joao)');
select pg_temp.check(pg_temp.fails(format('select remove_device(%L, %L)', :'org_a', 'aaaaaaaa-0000-0000-0000-000000000001')), 'owner cannot remove self');
select remove_device(:'org_a', 'cccccccc-0000-0000-0000-000000000003');
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003') \gset
select pg_temp.check(pg_temp.fails(format('select pull_units(%L)', :'org_a')), 'removed device loses access');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
select pg_temp.check(movement_history(:'org_a', p_code => :'c3')->0->>'user_label' = 'Joao (removed)', 'history keeps the name of a removed device');
select pg_temp.check(pg_temp.fails('select * from device_names'), 'device_names not readable');
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003') \gset
select pg_temp.check(join_with_pin('482915', 'Joao') = :'org_a'::uuid, 'removed device can rejoin with PIN');
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
select pg_temp.check((set_pin(:'org_a', '736251', true)->>'removed_devices')::int = 1, 'rotate PIN + sign out all devices');
select pg_temp.check(jsonb_array_length(list_devices(:'org_a')) = 1, 'only the owner remains');
select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003') \gset
select pg_temp.check(join_with_pin('482915', 'Joao') is null, 'old PIN no longer works');


-- ═══════════ item codes (BAN-<PREFIX><size>-NN) ═══════════
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
insert into themes (org_id, name, prefix) values (:'org_a', 'Paw Patrol', 'PAW') returning id as paw \gset
select pg_temp.check(pg_temp.fails(format('insert into themes (org_id, name, prefix) values (%L, %L, %L)', :'org_a', 'Pawsome', 'PAW')), 'theme prefix unique');
select pg_temp.check(pg_temp.fails(format('insert into themes (org_id, name, prefix) values (%L, %L, %L)', :'org_a', 'paw patrol', 'PPT')), 'theme name unique (one prefix per theme)');
select pg_temp.check(pg_temp.fails(format('insert into themes (org_id, name, prefix) values (%L, %L, %L)', :'org_a', 'Bad', 'p1')), 'prefix must be upper-case');
insert into products (org_id, name, category, theme_id, size, code_stem) values (:'org_a', 'Paw Patrol banner 4x5', 'BAN', :'paw', '4x5', 'WHATEVER') returning id as ban45, code_stem as stem45 \gset
select pg_temp.check(:'stem45' = 'BAN-PAW45', 'banner stem computed by the database (typed stem ignored)');
insert into products (org_id, name, category, theme_id, size) values (:'org_a', 'Paw Patrol banner 3x4', 'BAN', :'paw', '3 x 4') returning code_stem as stem34 \gset
select pg_temp.check(:'stem34' = 'BAN-PAW34', 'same theme, other size, same prefix');
select pg_temp.check(pg_temp.fails(format('insert into products (org_id, name, category, theme_id, size) values (%L, %L, %L, %L, %L)', :'org_a', 'dup', 'BAN', :'paw', '4x5')), 'same banner twice rejected');
select pg_temp.check(pg_temp.fails(format('insert into products (org_id, name, category) values (%L, %L, %L)', :'org_a', 'no theme', 'BAN')), 'banner needs theme and size');
select pg_temp.check(next_codes(:'ban45', 2) = '["BAN-PAW45-01", "BAN-PAW45-02"]'::jsonb, 'next_codes preview');
select string_agg(code, ',' order by code) as codes from generate_units(:'ban45', 3) \gset
select pg_temp.check(:'codes' = 'BAN-PAW45-01,BAN-PAW45-02,BAN-PAW45-03', 'generate BAN-PAW45-01..03');
update units set status = 'retired' where code = 'BAN-PAW45-03';
select code as c_next from generate_units(:'ban45', 1) \gset
select pg_temp.check(:'c_next' = 'BAN-PAW45-04', 'retired numbers are never reused');
delete from units where code = 'BAN-PAW45-03'; -- RLS: no delete policy, so 0 rows
select pg_temp.check((select count(*) from units where code = 'BAN-PAW45-03') = 1, 'retired unit row is kept');
delete from products where id = :'ban45';
select pg_temp.check((select count(*) from products where id = :'ban45') = 1, 'products cannot be deleted');
select pg_temp.check(pg_temp.fails(format('update products set size = %L where id = %L', '5x6', :'ban45')), 'scheme frozen once labels exist');
-- castles: shared stem across products, 3 digits
insert into products (org_id, name, category, code_stem, code_digits) values (:'org_a', 'Castle Blue', 'CAS', 'cas', 3) returning id as cas1 \gset
insert into products (org_id, name, category, code_stem, code_digits) values (:'org_a', 'Castle Pink', 'CAS', 'CAS', 3) returning id as cas2 \gset
select code as k1 from generate_units(:'cas1', 1) \gset
select code as k2 from generate_units(:'cas2', 1) \gset
select pg_temp.check(:'k1' = 'CAS-001' and :'k2' = 'CAS-002', 'one sequence per stem across products (CAS-001, CAS-002)');
-- exhaustion
insert into products (org_id, name, code_stem, code_digits) values (:'org_a', 'Tiny', 'TNY', 1) returning id as tny \gset
select count(*) from generate_units(:'tny', 9);
select pg_temp.check(pg_temp.fails(format('select generate_units(%L, 1)', :'tny')), 'stops when piece numbers run out');
-- manual codes (blowers)
insert into products (org_id, name, category) values (:'org_a', 'Blower', 'BLO') returning id as blo \gset
select pg_temp.check((add_unit_with_code(:'blo', ' blo-c3 ')).code = 'BLO-C3', 'manual code normalised');
select pg_temp.check(pg_temp.fails(format('select add_unit_with_code(%L, %L)', :'blo', 'BLO-C3')), 'duplicate manual code rejected');
select pg_temp.check(pg_temp.fails(format('select add_unit_with_code(%L, %L)', :'blo', 'bad code!')), 'invalid manual code rejected');
-- legacy random still works
select pg_temp.check(length((select code from generate_units(:'prod_a', 1))) = 8, 'products without a stem keep random codes');


-- ═══════════ vehicles ═══════════
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
insert into vehicles (org_id, name, plate) values (:'org_a', 'Van 1', ' abc123 ') returning id as van1, code as van1_code, plate as van1_plate \gset
insert into vehicles (org_id, name) values (:'org_a', 'Van 2') returning id as van2, code as van2_code \gset
select pg_temp.check(:'van1_code' = 'VEH-01' and :'van2_code' = 'VEH-02', 'vehicle codes auto VEH-01, VEH-02');
select pg_temp.check(:'van1_plate' = 'ABC123', 'plate normalised');
select pg_temp.check(pg_temp.fails(format('insert into vehicles (org_id, name) values (%L, %L)', :'org_a', 'van 1')), 'vehicle name unique');
select pg_temp.check(pg_temp.fails(format('update vehicles set code = %L where id = %L', 'VEH-99', :'van1')), 'vehicle code frozen');
select pg_temp.check(pg_temp.fails(format('select add_unit_with_code(%L, %L)', :'blo', 'VEH-05')), 'unit code cannot look like a vehicle');
select pg_temp.check(pg_temp.fails(format('insert into products (org_id, name, code_stem) values (%L, %L, %L)', :'org_a', 'x', 'VEH')), 'code stem cannot be VEH');
select code as vu1 from generate_units(:'ban45', 1) \gset
select sync_events(jsonb_build_array(jsonb_build_object(
  'kind','move','client_id',gen_random_uuid(),'org_id',:'org_a','code',:'vu1','direction','out','vehicle_id',:'van2'))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'ok', 'check out onto a vehicle');
select pg_temp.check((select e->>'vehicle_id' from jsonb_array_elements(pull_units(:'org_a')) e where e->>'code' = :'vu1') = :'van2', 'pull_units: vehicle of out unit');
select pg_temp.check(activity_feed(:'org_a', p_code => :'vu1')->0->>'vehicle' = 'Van 2', 'history shows vehicle');
select pg_temp.check(jsonb_array_length(activity_feed(:'org_a', p_vehicle => :'van2')) = 1, 'history filter by vehicle');
select pg_temp.check(jsonb_array_length(pull_vehicles(:'org_a')) = 2, 'pull_vehicles');
select pg_temp.check(movement_history(:'org_a', p_code => :'vu1')->0->>'code' = :'vu1', 'old movement_history still works for older app versions');
update vehicles set active = false where id = :'van1';
select pg_temp.check((select not active from vehicles where id = :'van1'), 'vehicle deactivated (not deleted)');
delete from vehicles where id = :'van1';
select pg_temp.check((select count(*) from vehicles where id = :'van1') = 1, 'vehicles cannot be deleted');
-- a PIN device (member) can use vehicles but not create or edit them
reset role;
insert into auth.users (id, is_anonymous) values ('eeeeeeee-0000-0000-0000-000000000005', true);
set role authenticated;
select pg_temp.as_user('eeeeeeee-0000-0000-0000-000000000005') \gset
select pg_temp.check(join_with_pin('736251', 'Eva') = :'org_a'::uuid, 'staff device joins');
select pg_temp.check(jsonb_array_length(pull_vehicles(:'org_a')) = 2, 'staff sees vehicles');
select pg_temp.check(pg_temp.fails(format('insert into vehicles (org_id, name) values (%L, %L)', :'org_a', 'Staff van')), 'staff cannot create vehicles');
update vehicles set name = 'Hacked' where id = :'van2';
select pg_temp.check((select name from vehicles where id = :'van2') = 'Van 2', 'staff cannot rename vehicles');
select sync_events(jsonb_build_array(jsonb_build_object(
  'kind','move','client_id',gen_random_uuid(),'org_id',:'org_a','code',:'vu1','direction','in','vehicle_id',:'van2'))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'ok', 'staff checks in from a vehicle');

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
reset role;
select create_org('Org B') as org_b \gset
set role authenticated;
select sync_events(jsonb_build_array(jsonb_build_object(
  'kind','move','client_id',:'mv1','org_id',:'org_b','code','X','direction','in'))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'error' and not ((:'r'::jsonb)->0 ? 'product'), 'B replaying A client_id leaks nothing');
select pg_temp.check(pg_temp.fails(format('insert into products (org_id,name) values (%L, %L)', :'org_a', 'evil')), 'B cannot insert into A');
select pg_temp.check(pg_temp.fails(format('insert into products (org_id, name, category, theme_id, size) values (%L, %L, %L, %L, %L)', :'org_b', 'steal', 'BAN', :'paw', '9x9')), 'B cannot use A theme');
select pg_temp.check((select count(*) from themes) = 0, 'B sees no themes of A');
select pg_temp.check(pg_temp.fails(format('select add_unit_with_code(%L, %L)', :'ban45', 'EVIL-1')), 'B cannot add units to A');
select pg_temp.check(pg_temp.fails(format('select next_codes(%L)', :'ban45')), 'B cannot preview A codes');
select pg_temp.check(pg_temp.fails(format('select pull_vehicles(%L)', :'org_a')), 'B cannot list A vehicles');
select pg_temp.check(pg_temp.fails(format('select activity_feed(%L)', :'org_a')), 'B cannot read A activity_feed');
select pg_temp.check((select count(*) from vehicles) = 0, 'B sees no vehicles of A');
insert into products (org_id, name) values (:'org_b', 'B thing') returning id as b_prod \gset
select code as b_unit from generate_units(:'b_prod', 1) \gset
select sync_events(jsonb_build_array(jsonb_build_object(
  'kind','move','client_id',gen_random_uuid(),'org_id',:'org_b','code',:'b_unit','direction','out','vehicle_id',:'van2'))) as r \gset
select pg_temp.check((:'r'::jsonb)->0->>'result' = 'error', 'B cannot put its units on A vehicle');
select pg_temp.check(pg_temp.fails(format('insert into movements (org_id, unit_id, direction) values (%L, gen_random_uuid(), %L)', :'org_b', 'in')), 'no direct movement inserts');
select pg_temp.check(pg_temp.fails(format('select _sync_move(%L::jsonb)', jsonb_build_object('client_id', gen_random_uuid(), 'org_id', :'org_b', 'code', 'X', 'direction', 'in'))), 'internal _sync_move not callable');
select pg_temp.check(pg_temp.fails('select gen_unit_code()'), 'internal gen_unit_code not callable');

-- ═══════════ A state untouched ═══════════
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001') \gset
select pg_temp.check((select status from units where code = :'c2') = 'in_stock', 'A unit c2 untouched by B (back in stock after count)');
select pg_temp.check((select count(*) from count_sessions) = 1, 'no evil session in A');

reset role;
set role anon;
select pg_temp.check(pg_temp.fails('select sync_events(''[]''::jsonb)'), 'anon cannot sync');
select pg_temp.check(pg_temp.fails('select my_orgs()'), 'anon cannot my_orgs');
select pg_temp.check(pg_temp.fails('select 1 from units limit 1'), 'anon has no table access');
reset role;
\echo ALL CHECKS PASSED
