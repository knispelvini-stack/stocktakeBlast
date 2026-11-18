-- stocktakeBlast — corrections and tighter writes.
--
--   * Units can no longer be updated directly through the API. Anyone with the
--     company PIN is a member, and a direct UPDATE let them change a unit's
--     code, product or status with no trace. Retire / restore now go through
--     set_unit_status(), which only allows those two changes and logs them.
--   * Products: members may only edit name and SKU (column grants). Category,
--     theme, size and code stem stay as created (labels may be printed).
--   * Undo a scan: a move event with `corrects` = the client id of an earlier
--     move by the same device user. It applies the opposite move and links to
--     the original (movements.corrects_id). Nothing is ever deleted.
--   * activity_feed: p_reference now searches reference, code, product, person
--     and vehicle (same signature, so no DROP); rows say if they were undone.

-- ───────────────────────────── units: no direct writes ─────────────────────────────

-- (alter, not drop: the grant below already blocks it; this makes the intent explicit)
alter policy units_update on public.units using (false) with check (false);
revoke update, insert, delete on public.units from authenticated, anon;

create table public.unit_status_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  unit_id    uuid not null,
  from_status text not null,
  to_status  text not null,
  user_id    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (unit_id, org_id) references public.units (id, org_id)
);
create index unit_status_log_unit_idx on public.unit_status_log (unit_id);
alter table public.unit_status_log enable row level security;
revoke all on public.unit_status_log from anon;
revoke insert, update, delete on public.unit_status_log from authenticated;
create policy unit_status_log_select on public.unit_status_log for select to authenticated
  using (public.is_member(org_id));

-- Retire (any status except retired → retired) or restore (retired → in_stock).
create function public.set_unit_status(p_unit uuid, p_status text) returns jsonb
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
  elsif p_status = 'in_stock' then
    if v_unit.status <> 'retired' then
      raise exception 'only a retired unit can be restored here (scan it in instead)' using errcode = '22023';
    end if;
  else
    raise exception 'status must be retired or in_stock' using errcode = '22023';
  end if;
  update public.units set status = p_status where id = v_unit.id;
  insert into public.unit_status_log (org_id, unit_id, from_status, to_status, user_id)
  values (v_unit.org_id, v_unit.id, v_unit.status, p_status, auth.uid());
  return jsonb_build_object('result', 'ok', 'status', p_status, 'previous', v_unit.status);
end;
$$;
revoke execute on function public.set_unit_status(uuid, text) from public, anon;
grant execute on function public.set_unit_status(uuid, text) to authenticated;

-- ───────────────────────────── products: only name + SKU editable ─────────────────────────────

revoke update on public.products from authenticated, anon;
grant update (name, sku) on public.products to authenticated;

-- ───────────────────────────── undo ─────────────────────────────

alter table public.movements add column corrects_id uuid references public.movements (id);
-- A movement can be undone once.
create unique index movements_corrects_uq on public.movements (corrects_id) where corrects_id is not null and applied;

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
    return jsonb_build_object('result', 'already', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
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

-- ───────────────────────────── activity_feed: search + undo info ─────────────────────────────

-- Same signature as before (create or replace, no DROP). p_reference is the
-- free-text search: reference, unit code, product, person or vehicle.
create or replace function public.activity_feed(
  p_org        uuid,
  p_code       text        default null,
  p_direction  text        default null,
  p_reference  text        default null,
  p_from       timestamptz default null,
  p_to         timestamptz default null,
  p_before_at  timestamptz default null,
  p_before_id  uuid        default null,
  p_limit      int         default 100,
  p_vehicle    uuid        default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_q text := '%' || replace(replace(replace(btrim(p_reference), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(r order by r.scanned_at desc, r.id desc)
    from (
      select m.id, m.direction, m.reference, m.applied, m.scanned_at, m.created_at,
             u.code, p.name as product, v.name as vehicle, m.vehicle_id, m.corrects_id,
             exists (select 1 from public.movements c where c.corrects_id = m.id and c.applied) as undone,
             coalesce(om.display_name, au.email,
                      dn.display_name || ' (removed)', 'Removed device') as user_label
      from public.movements m
      join public.units u on u.id = m.unit_id
      join public.products p on p.id = u.product_id
      left join public.vehicles v on v.id = m.vehicle_id
      left join auth.users au on au.id = m.user_id
      left join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
      left join public.device_names dn on dn.org_id = m.org_id and dn.user_id = m.user_id
      where m.org_id = p_org
        and (p_code is null or u.code = upper(btrim(p_code)))
        and (p_direction is null or m.direction = p_direction)
        and (nullif(btrim(p_reference), '') is null
             or m.reference ilike v_q or u.code ilike v_q or p.name ilike v_q or v.name ilike v_q
             or coalesce(om.display_name, au.email, dn.display_name) ilike v_q)
        and (p_from is null or m.scanned_at >= p_from)
        and (p_to is null or m.scanned_at < p_to)
        and (p_vehicle is null or m.vehicle_id = p_vehicle)
        and (p_before_at is null or (m.scanned_at, m.id) < (p_before_at, p_before_id))
      order by m.scanned_at desc, m.id desc
      limit least(greatest(p_limit, 1), 1000)
    ) r
  ), '[]'::jsonb);
end;
$$;
