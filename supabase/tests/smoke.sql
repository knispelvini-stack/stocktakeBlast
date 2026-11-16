-- Functional + tenant-isolation smoke test. See README "Database tests".
-- Errors marked by the comments for user B are EXPECTED (they prove isolation).
\set ON_ERROR_STOP 0
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'),('bbbbbbbb-0000-0000-0000-000000000002');
set role authenticated;
-- ===== user A
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001',false) \gset
select create_org('Org A') as org_a \gset
insert into products (org_id,name,sku) values (:'org_a','Castle 4x4','C44') returning id as prod_a \gset
select count(*) as generated from generate_units(:'prod_a', 5);
select code as c1 from units order by created_at, code limit 1 offset 0 \gset
select code as c2 from units order by created_at, code limit 1 offset 1 \gset
select code as c3 from units order by created_at, code limit 1 offset 2 \gset
select move_unit(:'org_a', lower(:'c1'), 'out', 'Van 2');
select move_unit(:'org_a', :'c1', 'out', 'Van 2') as again;
select move_unit(:'org_a', 'NOPE123', 'out') as unknown;
select * from product_stock;
insert into count_sessions (org_id,name) values (:'org_a','Nov count') returning id as sess \gset
select record_scan(:'sess', :'c2');
select record_scan(:'sess', :'c2') as dup;
select record_scan(:'sess', :'c1') as found_out_unit;
select record_scan(:'sess', 'ZZZZ');
select count_summary(:'sess');
-- ===== user B (attacker)
select set_config('request.jwt.claim.sub','bbbbbbbb-0000-0000-0000-000000000002',false) \gset
select 'B sees orgs' t, count(*) from orgs; select 'B sees units' t, count(*) from units;
select 'B sees scans' t, count(*) from count_scans;
insert into products (org_id,name) values (:'org_a','evil');
select move_unit(:'org_a', :'c2', 'out');
select record_scan(:'sess', :'c3');
select close_count(:'sess', true);
select count(*) from generate_units(:'prod_a', 1);
select count_summary(:'sess') as b_summary;
insert into count_sessions (org_id,name) values (:'org_a','evil');
select create_org('Org B') as org_b \gset
insert into products (org_id,name) values (:'org_b','B prod') returning id as prod_b \gset
-- try to re-point own product into A / steal A unit into B product
update products set org_id = :'org_a' where id = :'prod_b';
update units set product_id = :'prod_b' where code = :'c2';
select 'B unit update rows (expect 0)' t;
-- ===== back to A: close and apply
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001',false) \gset
select close_count(:'sess', true);
select record_scan(:'sess', :'c3') as after_close;
select code, status from units order by status, code;
select direction, reference from movements order by created_at;
-- direct write to audit trail should fail
insert into movements (org_id, unit_id, direction) select org_id, id, 'in' from units limit 1;
reset role;
-- anon cannot call RPCs
set role anon; select create_org('anon');
