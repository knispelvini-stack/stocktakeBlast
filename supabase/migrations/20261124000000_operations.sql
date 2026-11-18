-- stocktakeBlast — day-to-day operations.
--
--   * Condition: a unit can be marked damaged (with a note) and repaired.
--     Separate from status, because a damaged piece can be out (torn at the
--     party) or in the warehouse (in repair). "Available" = in stock and OK.
--   * Mark lost outside a stocktake (a customer kept or wrecked it).
--   * Overdue: orgs.overdue_days — units out longer than this are flagged.
--   * CSV import of products (+ labels), owner only, all-or-nothing.
--   * Stocktake: remove a wrong scan (count_scan_voids). Scans are never
--     deleted; a void can be lifted by scanning the unit again.
-- No DROP statements: only new columns/tables/functions and create or replace.

-- ───────────────────────────── condition ─────────────────────────────

alter table public.units
  add column condition      text not null default 'ok' check (condition in ('ok', 'damaged')),
  add column condition_note text check (condition_note is null or length(condition_note) <= 200),
  add column condition_at   timestamptz;

alter table public.unit_status_log
  add column field text not null default 'status' check (field in ('status', 'condition')),
  add column note  text;

create function public.set_unit_condition(p_unit uuid, p_condition text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_unit public.units;
  v_note text := nullif(btrim(p_note), '');
begin
  select * into v_unit from public.units where id = p_unit for update;
  if not found or not public.is_member(v_unit.org_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_condition not in ('ok', 'damaged') then
    raise exception 'condition must be ok or damaged' using errcode = '22023';
  end if;
  if p_condition = 'damaged' and v_note is null then
    raise exception 'say what is wrong (a short note)' using errcode = '22023';
  end if;
  if v_unit.status = 'retired' then
    raise exception 'unit is retired' using errcode = '22023';
  end if;
  update public.units
     set condition = p_condition,
         condition_note = case when p_condition = 'damaged' then left(v_note, 200) end,
         condition_at = now()
   where id = v_unit.id;
  insert into public.unit_status_log (org_id, unit_id, field, from_status, to_status, note, user_id)
  values (v_unit.org_id, v_unit.id, 'condition', v_unit.condition, p_condition, v_note, auth.uid());
  return jsonb_build_object('result', 'ok', 'condition', p_condition);
end;
$$;
revoke execute on function public.set_unit_condition(uuid, text, text) from public, anon;
grant execute on function public.set_unit_condition(uuid, text, text) to authenticated;

-- ───────────────────────────── set_unit_status: + lost ─────────────────────────────

create or replace function public.set_unit_status(p_unit uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_unit public.units;
begin
  select * into v_unit from public.units where id = p_unit for update;
  if not found or not public.is_member(v_unit.org_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status = 'retired' then
    if v_unit.status = 'retired' then
      return jsonb_build_object('result', 'already', 'status', v_unit.status);
    end if;
  elsif p_status = 'lost' then
    if v_unit.status not in ('in_stock', 'out') then
      raise exception 'only a unit in stock or out can be marked lost' using errcode = '22023';
    end if;
  elsif p_status = 'in_stock' then
    if v_unit.status <> 'retired' then
      raise exception 'only a retired unit can be restored here (scan it in instead)' using errcode = '22023';
    end if;
  else
    raise exception 'status must be retired, lost or in_stock' using errcode = '22023';
  end if;
  update public.units set status = p_status where id = v_unit.id;
  insert into public.unit_status_log (org_id, unit_id, from_status, to_status, user_id)
  values (v_unit.org_id, v_unit.id, v_unit.status, p_status, auth.uid());
  return jsonb_build_object('result', 'ok', 'status', p_status, 'previous', v_unit.status);
end;
$$;

-- ───────────────────────────── reads ─────────────────────────────

create or replace function public.pull_units(p_org uuid, p_after text default null, p_limit int default 2000)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'code', u.code, 'status', u.status, 'product_id', u.product_id,
      'product', p.name, 'last_moved_at', u.last_moved_at,
      'last_ref', lm.reference, 'out_since', lm.scanned_at, 'vehicle_id', lm.vehicle_id,
      'condition', u.condition, 'condition_note', u.condition_note) order by u.code)
    from (select * from public.units
          where org_id = p_org and (p_after is null or code > p_after)
          order by code limit least(greatest(p_limit, 1), 5000)) u
    join public.products p on p.id = u.product_id
    left join lateral (
      select m.reference, m.scanned_at, m.vehicle_id
      from public.movements m
      where m.unit_id = u.id and m.applied and m.direction = 'out' and u.status = 'out'
      order by m.scanned_at desc
      limit 1
    ) lm on true
  ), '[]'::jsonb);
end;
$$;

-- New columns go at the end (create or replace view can only append).
create or replace view public.product_stock with (security_invoker = true) as
select
  p.id as product_id,
  p.org_id,
  count(u.id) filter (where u.status = 'in_stock') as in_stock,
  count(u.id) filter (where u.status = 'out')      as out,
  count(u.id) filter (where u.status = 'lost')     as lost,
  count(u.id) filter (where u.status <> 'retired') as total,
  count(u.id) filter (where u.status <> 'retired' and u.condition = 'damaged') as damaged,
  count(u.id) filter (where u.status = 'in_stock' and u.condition = 'ok')      as available
from public.products p
left join public.units u on u.product_id = p.id
group by p.id, p.org_id;

-- ───────────────────────────── overdue ─────────────────────────────

alter table public.orgs add column overdue_days int not null default 3 check (overdue_days between 1 and 60);

create or replace function public.my_orgs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'org_id', m.org_id, 'role', m.role, 'name', o.name,
           'display_name', m.display_name, 'overdue_days', o.overdue_days) order by m.created_at), '[]'::jsonb)
  from public.org_members m join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid();
$$;

-- ───────────────────────────── CSV import ─────────────────────────────

-- p_rows: [{ name, sku?, type: BAN|CAS|BLO|OTHER, theme?, prefix?, size?, stem?, digits?, quantity? }]
-- All rows or none. Errors name the row (1 = first data row).
create function public.import_products(p_org uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r       jsonb;
  i       int := 0;
  v_type  text;
  v_name  text;
  v_theme uuid;
  v_tname text;
  v_pref  text;
  v_size  text;
  v_qty   int;
  v_prod  uuid;
  v_codes int;
  v_out   jsonb := '[]'::jsonb;
begin
  perform public._require_owner(p_org);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 500 then
    raise exception 'expected 1 to 500 rows' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_type := upper(coalesce(nullif(btrim(r->>'type'), ''), 'OTHER'));
      v_name := nullif(btrim(r->>'name'), '');
      v_qty  := coalesce(nullif(btrim(r->>'quantity'), '')::int, 0);
      v_size := nullif(lower(replace(btrim(r->>'size'), ' ', '')), '');
      v_theme := null;
      if v_type not in ('BAN', 'CAS', 'BLO', 'OTHER') then
        raise exception 'type must be BAN, CAS, BLO or OTHER';
      end if;
      if v_qty < 0 or v_qty > 500 then raise exception 'quantity must be 0 to 500'; end if;
      if v_type = 'BLO' and v_qty > 0 then
        raise exception 'blower codes are entered by hand: use quantity 0 and add pieces in the app';
      end if;

      if v_type = 'BAN' then
        v_tname := nullif(btrim(r->>'theme'), '');
        v_pref  := nullif(upper(btrim(r->>'prefix')), '');
        if v_tname is null then raise exception 'a banner needs a theme'; end if;
        select id into v_theme from public.themes
         where org_id = p_org and lower(btrim(name)) = lower(v_tname)
           and (v_pref is null or prefix = v_pref);
        if v_theme is null then
          if exists (select 1 from public.themes where org_id = p_org and lower(btrim(name)) = lower(v_tname)) then
            raise exception 'theme "%" already exists with another prefix (one prefix per theme)', v_tname;
          end if;
          if v_pref is null then raise exception 'new theme "%" needs a prefix', v_tname; end if;
          insert into public.themes (org_id, name, prefix) values (p_org, v_tname, v_pref) returning id into v_theme;
        end if;
        v_name := coalesce(v_name, v_tname || ' banner ' || coalesce(v_size, ''));
      end if;
      if v_name is null then raise exception 'name is required'; end if;

      insert into public.products (org_id, name, sku, category, theme_id, size, code_stem, code_digits)
      values (
        p_org, v_name, nullif(btrim(r->>'sku'), ''),
        case when v_type = 'OTHER' then null else v_type end,
        v_theme, case when v_type = 'BAN' then v_size end,
        case v_type when 'CAS' then coalesce(nullif(upper(btrim(r->>'stem')), ''), 'CAS')
                    when 'OTHER' then nullif(upper(btrim(r->>'stem')), '') end,
        coalesce(nullif(btrim(r->>'digits'), '')::int, case v_type when 'CAS' then 3 else 2 end))
      returning id into v_prod;

      v_codes := 0;
      if v_qty > 0 then
        select count(*) into v_codes from public.generate_units(v_prod, v_qty);
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('row', i, 'product_id', v_prod, 'name', v_name, 'units', v_codes));
    exception when others then
      raise exception 'row %: %', i, sqlerrm using errcode = '22023';
    end;
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.import_products(uuid, jsonb) from public, anon;
grant execute on function public.import_products(uuid, jsonb) to authenticated;

-- ───────────────────────────── stocktake: remove a wrong scan ─────────────────────────────

create table public.count_scan_voids (
  id          uuid primary key,             -- client event id (idempotency)
  session_id  uuid not null,
  org_id      uuid not null,
  scan_id     uuid not null references public.count_scans (id),
  user_id     uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  restored_at timestamptz,                  -- set when the unit is scanned again
  foreign key (session_id, org_id) references public.count_sessions (id, org_id)
);
create unique index count_scan_voids_active_uq on public.count_scan_voids (scan_id) where restored_at is null;
alter table public.count_scan_voids enable row level security;
revoke all on public.count_scan_voids from anon;
revoke insert, update, delete on public.count_scan_voids from authenticated;
create policy count_scan_voids_select on public.count_scan_voids for select to authenticated
  using (public.is_member(org_id));

-- Is this scan currently voided? Invoker: callers only see voids of their own
-- company (RLS); the definer functions below see all.
create function public._scan_voided(p_scan uuid) returns boolean
language sql stable security invoker set search_path = public as $$
  select exists (select 1 from public.count_scan_voids where scan_id = p_scan and restored_at is null);
$$;
revoke execute on function public._scan_voided(uuid) from public, anon;
grant execute on function public._scan_voided(uuid) to authenticated; -- used by count_summary (invoker)

create function public._sync_unscan(p_ev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (p_ev->>'client_id')::uuid;
  v_session uuid := (p_ev->>'session_id')::uuid;
  v_scan    uuid := (p_ev->>'scan_id')::uuid;
  v_org     uuid;
  v_status  text;
  v_row     public.count_scans;
begin
  select org_id, status into v_org, v_status from public.count_sessions where id = v_session for update;
  if v_org is null or not public.is_member(v_org) then
    raise exception 'session not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.count_scan_voids where id = v_id) then
    if not exists (select 1 from public.count_scan_voids where id = v_id and session_id = v_session) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    return jsonb_build_object('result', 'ok', 'replayed', true);
  end if;
  if v_status <> 'open' then return jsonb_build_object('result', 'session_closed'); end if;
  select * into v_row from public.count_scans where id = v_scan and session_id = v_session;
  if not found then raise exception 'scan not found in this stocktake' using errcode = '22023'; end if;
  if v_row.result not in ('ok', 'unknown') or public._scan_voided(v_scan) then
    return jsonb_build_object('result', 'already', 'unit_id', v_row.unit_id);
  end if;
  insert into public.count_scan_voids (id, session_id, org_id, scan_id, user_id)
  values (v_id, v_session, v_org, v_scan, auth.uid());
  return jsonb_build_object('result', 'ok', 'unit_id', v_row.unit_id);
end;
$$;
revoke execute on function public._sync_unscan(jsonb) from public, anon, authenticated;

-- Scanning a voided unit again lifts the void (the original 'ok' row counts again).
create or replace function public._sync_scan(p_ev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (p_ev->>'client_id')::uuid;
  v_session uuid := (p_ev->>'session_id')::uuid;
  v_code    text := upper(btrim(p_ev->>'code'));
  v_prev    public.count_scans;
  v_ok      public.count_scans;
  v_org     uuid;
  v_status  text;
  v_unit    public.units;
  v_name    text;
  v_result  text;
  v_reply   text;
begin
  select org_id, status into v_org, v_status
  from public.count_sessions where id = v_session for update;
  if v_org is null or not public.is_member(v_org) then
    raise exception 'session not found' using errcode = '42501';
  end if;

  select * into v_prev from public.count_scans where id = v_id;
  if found then
    if v_prev.session_id <> v_session then raise exception 'forbidden' using errcode = '42501'; end if;
    return jsonb_build_object('result', v_prev.result, 'unit_id', v_prev.unit_id, 'replayed', true);
  end if;

  if v_status <> 'open' then
    return jsonb_build_object('result', 'session_closed');
  end if;

  select * into v_unit from public.units where org_id = v_org and code = v_code;
  if not found then
    v_result := 'unknown';
  else
    select * into v_ok from public.count_scans
     where session_id = v_session and unit_id = v_unit.id and result = 'ok';
    if not found then
      v_result := 'ok';
    elsif public._scan_voided(v_ok.id) then
      update public.count_scan_voids set restored_at = now() where scan_id = v_ok.id and restored_at is null;
      v_result := 'duplicate'; -- stored as a duplicate row; the original ok row counts again
      v_reply := 'ok';
    else
      v_result := 'duplicate';
    end if;
  end if;

  insert into public.count_scans (id, session_id, org_id, code, unit_id, result, user_id, scanned_at)
  values (v_id, v_session, v_org, v_code, v_unit.id, v_result, auth.uid(), public._event_time(p_ev));

  if v_unit.id is not null then
    select name into v_name from public.products where id = v_unit.product_id;
  end if;
  return jsonb_build_object('result', coalesce(v_reply, v_result), 'unit_id', v_unit.id,
                            'unit_status', v_unit.status, 'product', v_name,
                            'restored', v_reply is not null);
end;
$$;
revoke execute on function public._sync_scan(jsonb) from public, anon, authenticated;

create or replace function public.sync_events(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev  jsonb;
  res jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 500 then
    raise exception 'expected an array of at most 500 events' using errcode = '22023';
  end if;

  for ev in select value from jsonb_array_elements(p_events) loop
    begin
      res := case ev->>'kind'
        when 'move'    then public._sync_move(ev)
        when 'scan'    then public._sync_scan(ev)
        when 'unscan'  then public._sync_unscan(ev)
        when 'session' then public._sync_session(ev)
        else jsonb_build_object('result', 'error', 'message', 'unknown event kind')
      end;
    exception when others then
      res := jsonb_build_object('result', 'error', 'message', sqlerrm);
    end;
    v_out := v_out || jsonb_build_array(res || jsonb_build_object('client_id', ev->>'client_id'));
  end loop;
  return v_out;
end;
$$;

create or replace function public.pull_scans(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.count_sessions where id = p_session;
  if v_org is null or not public.is_member(v_org) then
    raise exception 'session not found' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'session_id', session_id, 'code', code, 'unit_id', unit_id,
      'result', result, 'scanned_at', scanned_at, 'voided', public._scan_voided(id)) order by scanned_at)
    from public.count_scans where session_id = p_session
  ), '[]'::jsonb);
end;
$$;

create or replace function public.count_summary(p_session uuid)
returns jsonb
language sql stable security invoker set search_path = public as $$
  with s as (
    select id, org_id from public.count_sessions where id = p_session
  ),
  scanned as (
    select distinct cs.unit_id from public.count_scans cs, s
    where cs.session_id = s.id and cs.result = 'ok' and not public._scan_voided(cs.id)
  ),
  expected as (
    select u.id, u.code, u.product_id from public.units u, s
    where u.org_id = s.org_id and u.status = 'in_stock'
  )
  select jsonb_build_object(
    'expected', (select count(*) from expected),
    'scanned',  (select count(*) from scanned),
    'matched',  (select count(*) from expected e join scanned x on x.unit_id = e.id),
    'missing',  coalesce((
      select jsonb_agg(jsonb_build_object('code', e.code, 'product', p.name) order by p.name, e.code)
      from expected e join public.products p on p.id = e.product_id
      where not exists (select 1 from scanned x where x.unit_id = e.id)
    ), '[]'::jsonb),
    'extra',    coalesce((
      select jsonb_agg(jsonb_build_object('code', u.code, 'product', p.name, 'status', u.status) order by p.name, u.code)
      from scanned x join public.units u on u.id = x.unit_id
      join public.products p on p.id = u.product_id
      where u.status <> 'in_stock'
    ), '[]'::jsonb),
    'unknown',  coalesce((
      select jsonb_agg(distinct cs.code)
      from public.count_scans cs, s
      where cs.session_id = s.id and cs.result = 'unknown' and not public._scan_voided(cs.id)
    ), '[]'::jsonb)
  )
  from s;
$$;

create or replace function public.close_count(p_session uuid, p_apply boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org     uuid;
  v_status  text;
  v_name    text;
  v_lost    int := 0;
  v_found   int := 0;
begin
  select org_id, status, name into v_org, v_status, v_name
  from public.count_sessions where id = p_session for update;

  if v_org is null or not public.is_member(v_org) then
    raise exception 'session not found' using errcode = '42501';
  end if;
  if v_status <> 'open' then
    raise exception 'session is already closed' using errcode = '22023';
  end if;

  if p_apply then
    with found as (
      update public.units u set status = 'in_stock', last_moved_at = now()
      where u.org_id = v_org and u.status in ('out', 'lost')
        and exists (select 1 from public.count_scans cs
                    where cs.session_id = p_session and cs.unit_id = u.id and cs.result = 'ok'
                      and not public._scan_voided(cs.id))
      returning u.id
    ), mv as (
      insert into public.movements (org_id, unit_id, direction, reference, user_id)
      select v_org, id, 'in', 'count: ' || v_name, auth.uid() from found
      returning 1
    )
    select count(*) into v_found from mv;

    with lost as (
      update public.units u set status = 'lost'
      where u.org_id = v_org and u.status = 'in_stock'
        and not exists (select 1 from public.count_scans cs
                        where cs.session_id = p_session and cs.unit_id = u.id and cs.result = 'ok'
                          and not public._scan_voided(cs.id))
      returning 1
    )
    select count(*) into v_lost from lost;
  end if;

  update public.count_sessions set status = 'closed', closed_at = now() where id = p_session;

  return jsonb_build_object('lost', v_lost, 'found', v_found, 'applied', p_apply);
end;
$$;
