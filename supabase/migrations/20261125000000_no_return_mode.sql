-- stocktakeBlast — companies that don't scan returns.
--
-- Some companies scan only when loading a van and in the weekly stocktake;
-- returns are not scanned. orgs.scan_returns = false means:
--   * Loading a unit that is still "out" is accepted as a new load (it came
--     back unscanned). The same vehicle within 3 hours is a double scan.
--   * The stocktake is where units come back: it expects in-stock AND out
--     units. Not scanned → "missing" (was in stock) or "not back" (last loaded,
--     never seen since). Closing with "update stock" puts scanned units back in
--     stock, marks missing ones lost and leaves "not back" ones out.
-- Check IN keeps working for anyone who wants to use it.
-- No DROP statements.

alter table public.orgs add column scan_returns boolean not null default true;

create or replace function public.my_orgs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'org_id', m.org_id, 'role', m.role, 'name', o.name,
           'display_name', m.display_name, 'overdue_days', o.overdue_days,
           'scan_returns', o.scan_returns) order by m.created_at), '[]'::jsonb)
  from public.org_members m join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid();
$$;

create or replace function public._sync_move(p_ev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (p_ev->>'client_id')::uuid;
  v_org     uuid := (p_ev->>'org_id')::uuid;
  v_code    text := upper(btrim(p_ev->>'code'));
  v_dir     text := p_ev->>'direction';
  v_at      timestamptz := public._event_time(p_ev);
  v_vehicle uuid := nullif(p_ev->>'vehicle_id', '')::uuid;
  v_ref     text := nullif(btrim(p_ev->>'reference'), '');
  v_corr    uuid := nullif(p_ev->>'corrects', '')::uuid;
  v_orig    public.movements;
  v_prev    public.movements;
  v_unit    public.units;
  v_name    text;
  v_new     text;
  v_last_vehicle uuid;
  v_last_at      timestamptz;
begin
  if not public.is_member(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dir not in ('in', 'out') then raise exception 'bad direction' using errcode = '22023'; end if;
  if v_vehicle is not null and not exists (select 1 from public.vehicles where id = v_vehicle and org_id = v_org) then
    raise exception 'vehicle not found' using errcode = '42501';
  end if;

  -- Already processed (a retry): answer with what happened the first time.
  select * into v_prev from public.movements where id = v_id;
  if found then
    if v_prev.org_id <> v_org then raise exception 'forbidden' using errcode = '42501'; end if;
    select * into v_unit from public.units where id = v_prev.unit_id;
    select name into v_name from public.products where id = v_unit.product_id;
    return jsonb_build_object(
      'result', case when v_prev.applied then 'ok' else 'late' end,
      'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name, 'replayed', true);
  end if;

  select * into v_unit from public.units where org_id = v_org and code = v_code for update;
  if not found then
    return jsonb_build_object('result', 'unknown');
  end if;
  select name into v_name from public.products where id = v_unit.product_id;

  -- ── undo of an earlier move ──
  if v_corr is not null then
    select * into v_orig from public.movements where id = v_corr;
    if not found or v_orig.org_id <> v_org or v_orig.unit_id <> v_unit.id then
      raise exception 'movement to undo not found' using errcode = '22023';
    end if;
    if v_orig.user_id is distinct from auth.uid() then
      raise exception 'only the device that made a scan can undo it' using errcode = '42501';
    end if;
    if v_orig.direction = v_dir then raise exception 'an undo goes the other way' using errcode = '22023'; end if;
    if not v_orig.applied
       or exists (select 1 from public.movements where corrects_id = v_orig.id and applied) then
      return jsonb_build_object('result', 'already', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
    end if;
    -- Someone moved (or a stocktake/retire changed) the unit since: the undo
    -- would overwrite that, so it is recorded but not applied.
    if v_unit.status <> (case v_orig.direction when 'out' then 'out' else 'in_stock' end)
       or exists (select 1 from public.movements m
               where m.unit_id = v_unit.id and m.applied and m.id <> v_orig.id
                 and (m.scanned_at, m.id) > (v_orig.scanned_at, v_orig.id)) then
      insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied, vehicle_id, corrects_id)
      values (v_id, v_org, v_unit.id, v_dir, v_ref, auth.uid(), v_at, false, null, v_orig.id);
      return jsonb_build_object('result', 'late', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
    end if;
    if v_dir = 'out' then
      -- Undoing a check-in: back out where it was before (same vehicle/reference).
      select m.reference, m.vehicle_id into v_ref, v_vehicle
      from public.movements m
      where m.unit_id = v_unit.id and m.applied and m.direction = 'out'
        and (m.scanned_at, m.id) < (v_orig.scanned_at, v_orig.id)
      order by m.scanned_at desc, m.id desc limit 1;
    else
      v_ref := null;
      v_vehicle := null;
    end if;
    v_new := case v_dir when 'out' then 'out' else 'in_stock' end;
    update public.units set status = v_new, last_moved_at = greatest(v_at, v_unit.last_moved_at) where id = v_unit.id;
    insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied, vehicle_id, corrects_id)
    values (v_id, v_org, v_unit.id, v_dir, v_ref, auth.uid(), greatest(v_at, v_unit.last_moved_at), true, v_vehicle, v_orig.id);
    return jsonb_build_object('result', 'ok', 'unit_id', v_unit.id, 'status', v_new,
                              'previous', v_unit.status, 'product', v_name, 'undo', true);
  end if;

  if v_unit.status = 'retired' then
    return jsonb_build_object('result', 'retired', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
  end if;

  v_new := case v_dir when 'out' then 'out' else 'in_stock' end;

  if v_unit.status = v_new then
    -- Companies that don't scan returns: loading a unit that is still "out"
    -- means it came back unscanned and is going out again. Same vehicle within
    -- 3 hours is a double scan of the same load.
    if v_new = 'out' and not (select scan_returns from public.orgs where id = v_org) then
      select m.vehicle_id, m.scanned_at into v_last_vehicle, v_last_at
      from public.movements m
      where m.unit_id = v_unit.id and m.applied and m.direction = 'out'
      order by m.scanned_at desc, m.id desc limit 1;
      if v_last_at is not null and v_last_vehicle is not distinct from v_vehicle
         and v_at < v_last_at + interval '3 hours' then
        return jsonb_build_object('result', 'already', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
      end if;
    else
      return jsonb_build_object('result', 'already', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
    end if;
  end if;

  if v_unit.last_moved_at is not null and v_at < v_unit.last_moved_at then
    insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied, vehicle_id)
    values (v_id, v_org, v_unit.id, v_dir, v_ref, auth.uid(), v_at, false, v_vehicle);
    return jsonb_build_object('result', 'late', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
  end if;

  update public.units set status = v_new, last_moved_at = v_at where id = v_unit.id;
  insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied, vehicle_id)
  values (v_id, v_org, v_unit.id, v_dir, v_ref, auth.uid(), v_at, true, v_vehicle);

  return jsonb_build_object('result', 'ok', 'unit_id', v_unit.id, 'status', v_new,
                            'previous', v_unit.status, 'product', v_name);
end;
$$;
revoke execute on function public._sync_move(jsonb) from public, anon, authenticated;

-- Summary with "not back": out units not scanned in this stocktake, with where
-- they were last loaded and how many earlier stocktakes have missed them.
create or replace function public.count_summary(p_session uuid)
returns jsonb
language sql stable security invoker set search_path = public as $$
  with s as (
    select cs.id, cs.org_id, cs.created_at, o.scan_returns
    from public.count_sessions cs join public.orgs o on o.id = cs.org_id
    where cs.id = p_session
  ),
  scanned as (
    select distinct c.unit_id from public.count_scans c, s
    where c.session_id = s.id and c.result = 'ok' and not public._scan_voided(c.id)
  ),
  expected as (
    select u.id, u.code, u.product_id, u.status from public.units u, s
    where u.org_id = s.org_id
      and (u.status = 'in_stock' or (not s.scan_returns and u.status = 'out'))
  ),
  not_back as (
    select u.id, u.code, p.name as product, lm.scanned_at as out_since, v.name as vehicle,
           (select count(*) from public.count_sessions o, s
             where o.org_id = s.org_id and o.status = 'closed' and o.id <> s.id
               and o.created_at > lm.scanned_at) as missed
    from public.units u
    join s on u.org_id = s.org_id
    join public.products p on p.id = u.product_id
    left join lateral (
      select m.scanned_at, m.vehicle_id from public.movements m
      where m.unit_id = u.id and m.applied and m.direction = 'out'
      order by m.scanned_at desc limit 1
    ) lm on true
    left join public.vehicles v on v.id = lm.vehicle_id
    where u.status = 'out' and not exists (select 1 from scanned x where x.unit_id = u.id)
  )
  select jsonb_build_object(
    'expected', (select count(*) from expected),
    'scanned',  (select count(*) from scanned),
    'matched',  (select count(*) from expected e join scanned x on x.unit_id = e.id),
    'missing',  coalesce((
      select jsonb_agg(jsonb_build_object('code', e.code, 'product', p.name) order by p.name, e.code)
      from expected e join public.products p on p.id = e.product_id
      where e.status = 'in_stock' and not exists (select 1 from scanned x where x.unit_id = e.id)
    ), '[]'::jsonb),
    'not_back', coalesce((
      select jsonb_agg(jsonb_build_object('code', n.code, 'product', n.product, 'out_since', n.out_since,
                                          'vehicle', n.vehicle, 'missed', n.missed) order by n.out_since, n.code)
      from not_back n
    ), '[]'::jsonb),
    'returned', (select count(*) from scanned x join public.units u on u.id = x.unit_id, s
                 where u.status = 'out' and not s.scan_returns),
    'extra',    coalesce((
      select jsonb_agg(jsonb_build_object('code', u.code, 'product', p.name, 'status', u.status) order by p.name, u.code)
      from scanned x join public.units u on u.id = x.unit_id
      join public.products p on p.id = u.product_id, s
      where u.status in ('lost', 'retired') or (u.status = 'out' and s.scan_returns)
    ), '[]'::jsonb),
    'unknown',  coalesce((
      select jsonb_agg(distinct c.code)
      from public.count_scans c, s
      where c.session_id = s.id and c.result = 'unknown' and not public._scan_voided(c.id)
    ), '[]'::jsonb)
  )
  from s;
$$;
