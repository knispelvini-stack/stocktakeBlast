-- stocktakeBlast — vehicles.
--
-- Each vehicle has its own label (VEH-01, VEH-02, …). On the check-out screen,
-- scanning a vehicle label selects it; units scanned next are recorded as
-- leaving on that vehicle. Unloading shows what is still out with it.
--
--   * Vehicle codes live in their own namespace: no unit code or code stem
--     may start with VEH-, so a scan is never ambiguous.
--   * Only the owner (a real account) creates or edits vehicles. They are
--     never deleted — set active = false — so history keeps the name.
--   * movements.vehicle_id records which vehicle carried a unit (out) or
--     brought it back (in). Optional: the free-text reference still works.

-- ───────────────────────────── vehicles ─────────────────────────────

create table public.vehicles (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  code       text not null check (code ~ '^VEH-[A-Z0-9]+(-[A-Z0-9]+)*$'),
  name       text not null check (length(btrim(name)) between 1 and 40),
  plate      text check (plate is null or length(btrim(plate)) between 1 and 12),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, code),
  unique (id, org_id)
);
create unique index vehicles_org_name_uq on public.vehicles (org_id, lower(btrim(name)));

-- Next free VEH-NN when no code is given.
create function public._vehicle_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  new.name := btrim(new.name);
  new.plate := nullif(upper(btrim(new.plate)), '');
  if tg_op = 'UPDATE' and new.code is distinct from old.code then
    raise exception 'a vehicle code can''t change (its label is printed)' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' and (new.code is null or btrim(new.code) = '') then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || ':VEH', 0));
    select coalesce(max(substring(code from 5)::int), 0) + 1 into v_n
    from public.vehicles where org_id = new.org_id and code ~ '^VEH-[0-9]+$';
    new.code := 'VEH-' || lpad(v_n::text, 2, '0');
  else
    new.code := upper(btrim(new.code));
  end if;
  return new;
end;
$$;
revoke execute on function public._vehicle_defaults() from public, anon, authenticated;
create trigger vehicles_defaults before insert or update on public.vehicles
  for each row execute function public._vehicle_defaults();

alter table public.vehicles enable row level security;
revoke all on public.vehicles from anon;
create policy vehicles_select on public.vehicles for select to authenticated
  using (public.is_member(org_id));
-- Owner only, and a real account (is_owner is false for PIN devices: they are members).
create policy vehicles_insert on public.vehicles for insert to authenticated
  with check (public.is_owner(org_id));
create policy vehicles_update on public.vehicles for update to authenticated
  using (public.is_owner(org_id)) with check (public.is_owner(org_id));

-- Unit codes can never look like a vehicle label.
alter table public.units add constraint units_code_not_vehicle check (code !~ '^VEH-');
alter table public.products add constraint products_stem_not_vehicle check (code_stem is null or code_stem !~ '^VEH(-|$)');

-- ───────────────────────────── movements.vehicle_id ─────────────────────────────

alter table public.movements
  add column vehicle_id uuid,
  add constraint movements_vehicle_fk foreign key (vehicle_id, org_id) references public.vehicles (id, org_id);
create index movements_vehicle_idx on public.movements (vehicle_id) where vehicle_id is not null;

create or replace function public._sync_move(p_ev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (p_ev->>'client_id')::uuid;
  v_org     uuid := (p_ev->>'org_id')::uuid;
  v_code    text := upper(btrim(p_ev->>'code'));
  v_dir     text := p_ev->>'direction';
  v_at      timestamptz := public._event_time(p_ev);
  v_vehicle uuid := nullif(p_ev->>'vehicle_id', '')::uuid;
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

  if v_unit.status = 'retired' then
    return jsonb_build_object('result', 'retired', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
  end if;

  v_new := case v_dir when 'out' then 'out' else 'in_stock' end;

  if v_unit.status = v_new then
    return jsonb_build_object('result', 'already', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
  end if;

  if v_unit.last_moved_at is not null and v_at < v_unit.last_moved_at then
    insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied, vehicle_id)
    values (v_id, v_org, v_unit.id, v_dir, nullif(btrim(p_ev->>'reference'), ''), auth.uid(), v_at, false, v_vehicle);
    return jsonb_build_object('result', 'late', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
  end if;

  update public.units set status = v_new, last_moved_at = v_at where id = v_unit.id;
  insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied, vehicle_id)
  values (v_id, v_org, v_unit.id, v_dir, nullif(btrim(p_ev->>'reference'), ''), auth.uid(), v_at, true, v_vehicle);

  return jsonb_build_object('result', 'ok', 'unit_id', v_unit.id, 'status', v_new,
                            'previous', v_unit.status, 'product', v_name);
end;
$$;
revoke execute on function public._sync_move(jsonb) from public, anon, authenticated;

-- ───────────────────────────── reads ─────────────────────────────

create function public.pull_vehicles(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'plate', plate, 'active', active)
                     order by active desc, code)
    from public.vehicles where org_id = p_org
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.pull_vehicles(uuid) from public, anon;
grant execute on function public.pull_vehicles(uuid) to authenticated;

-- pull_units: also the vehicle of the movement that took an out unit out.
create or replace function public.pull_units(p_org uuid, p_after text default null, p_limit int default 2000)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'code', u.code, 'status', u.status, 'product_id', u.product_id,
      'product', p.name, 'last_moved_at', u.last_moved_at,
      'last_ref', lm.reference, 'out_since', lm.scanned_at, 'vehicle_id', lm.vehicle_id) order by u.code)
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

-- movement_history: vehicle name + optional filter by vehicle. New signature
-- (extra parameter), so drop the old one first; re-grant below.
drop function public.movement_history(uuid, text, text, text, timestamptz, timestamptz, timestamptz, uuid, int);
create function public.movement_history(
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
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(r order by r.scanned_at desc, r.id desc)
    from (
      select m.id, m.direction, m.reference, m.applied, m.scanned_at, m.created_at,
             u.code, p.name as product, v.name as vehicle, m.vehicle_id,
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
        and (p_reference is null or m.reference ilike '%' || p_reference || '%')
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
revoke execute on function public.movement_history(uuid, text, text, text, timestamptz, timestamptz, timestamptz, uuid, int, uuid) from public, anon;
grant execute on function public.movement_history(uuid, text, text, text, timestamptz, timestamptz, timestamptz, uuid, int, uuid) to authenticated;
