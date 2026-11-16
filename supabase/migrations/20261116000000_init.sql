-- stocktakeBlast — initial schema
-- Multi-tenant inventory with one barcode label per physical unit.
--
-- Tenancy model: every row carries org_id. Access is granted through
-- org_members (auth.uid() ↔ org). Composite foreign keys (child.org_id must
-- equal parent.org_id) stop a member from linking rows across tenants.
-- Writes that must stay consistent or auditable (movements, scans, unit
-- creation, closing counts) only happen through SECURITY DEFINER RPCs that
-- check membership themselves.

-- ───────────────────────────── tables ─────────────────────────────

create table public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id     uuid not null references public.orgs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id);

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  sku        text,
  created_at timestamptz not null default now(),
  unique (org_id, sku),
  unique (id, org_id)
);

create table public.units (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  product_id    uuid not null,
  code          text not null check (code = upper(btrim(code)) and length(code) >= 3),
  status        text not null default 'in_stock'
                check (status in ('in_stock', 'out', 'lost', 'retired')),
  last_moved_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (org_id, code),
  unique (id, org_id),
  foreign key (product_id, org_id) references public.products (id, org_id) on delete cascade
);
create index units_product_idx on public.units (product_id);
create index units_org_status_idx on public.units (org_id, status);

create table public.movements (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  unit_id    uuid not null,
  direction  text not null check (direction in ('in', 'out')),
  reference  text,
  user_id    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (unit_id, org_id) references public.units (id, org_id) on delete cascade
);
create index movements_org_created_idx on public.movements (org_id, created_at desc);
create index movements_unit_idx on public.movements (unit_id);

create table public.count_sessions (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  status     text not null default 'open' check (status in ('open', 'closed')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at  timestamptz,
  unique (id, org_id)
);
create index count_sessions_org_idx on public.count_sessions (org_id, created_at desc);

create table public.count_scans (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  org_id     uuid not null,
  code       text not null,
  unit_id    uuid references public.units (id) on delete set null,
  result     text not null check (result in ('ok', 'duplicate', 'unknown')),
  user_id    uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (session_id, org_id) references public.count_sessions (id, org_id) on delete cascade
);
create index count_scans_session_idx on public.count_scans (session_id);
create unique index count_scans_one_ok_per_unit
  on public.count_scans (session_id, unit_id) where result = 'ok';

-- Per-product stock counts (RLS of the caller applies).
create view public.product_stock with (security_invoker = true) as
select
  p.id as product_id,
  p.org_id,
  count(u.id) filter (where u.status = 'in_stock') as in_stock,
  count(u.id) filter (where u.status = 'out')      as out,
  count(u.id) filter (where u.status = 'lost')     as lost,
  count(u.id) filter (where u.status <> 'retired') as total
from public.products p
left join public.units u on u.product_id = p.id
group by p.id, p.org_id;

-- ───────────────────────────── helpers ─────────────────────────────

create function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.org_members where org_id = p_org and user_id = auth.uid()
  );
$$;

create function public.is_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = auth.uid() and role = 'owner'
  );
$$;

-- 8 chars from an alphabet without look-alikes (no 0/O, 1/I). 32^8 ≈ 1.1e12.
-- Uses the random bytes of gen_random_uuid() so no extension is needed.
create function public.gen_unit_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b   bytea := uuid_send(gen_random_uuid());
  idx int[] := array[0, 1, 2, 3, 4, 5, 10, 11]; -- bytes free of version/variant bits
  s   text := '';
  i   int;
begin
  foreach i in array idx loop
    s := s || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return s;
end;
$$;

-- ───────────────────────────── RLS ─────────────────────────────

alter table public.orgs           enable row level security;
alter table public.org_members    enable row level security;
alter table public.products       enable row level security;
alter table public.units          enable row level security;
alter table public.movements      enable row level security;
alter table public.count_sessions enable row level security;
alter table public.count_scans    enable row level security;

create policy orgs_select on public.orgs for select to authenticated
  using (public.is_member(id));
create policy orgs_update on public.orgs for update to authenticated
  using (public.is_owner(id)) with check (public.is_owner(id));

create policy members_select on public.org_members for select to authenticated
  using (public.is_member(org_id));

create policy products_select on public.products for select to authenticated
  using (public.is_member(org_id));
create policy products_insert on public.products for insert to authenticated
  with check (public.is_member(org_id));
create policy products_update on public.products for update to authenticated
  using (public.is_member(org_id)) with check (public.is_member(org_id));
create policy products_delete on public.products for delete to authenticated
  using (public.is_owner(org_id));

-- Units are created only via generate_units(); status changes normally go
-- through move_unit()/close_count(). Direct update is allowed so a member can
-- retire a unit; delete is owner-only.
create policy units_select on public.units for select to authenticated
  using (public.is_member(org_id));
create policy units_update on public.units for update to authenticated
  using (public.is_member(org_id)) with check (public.is_member(org_id));
create policy units_delete on public.units for delete to authenticated
  using (public.is_owner(org_id));

-- Movements and scans are an audit trail: read-only for clients.
create policy movements_select on public.movements for select to authenticated
  using (public.is_member(org_id));

create policy sessions_select on public.count_sessions for select to authenticated
  using (public.is_member(org_id));
create policy sessions_insert on public.count_sessions for insert to authenticated
  with check (public.is_member(org_id) and status = 'open' and closed_at is null);

create policy scans_select on public.count_scans for select to authenticated
  using (public.is_member(org_id));

-- ───────────────────────────── RPCs ─────────────────────────────

create function public.create_org(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  insert into public.orgs (name) values (btrim(p_name)) returning id into v_org;
  insert into public.org_members (org_id, user_id, role) values (v_org, auth.uid(), 'owner');
  return v_org;
end;
$$;

create function public.generate_units(p_product uuid, p_count int)
returns setof public.units
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  r     public.units;
  i     int;
begin
  select org_id into v_org from public.products where id = p_product;
  if v_org is null or not public.is_member(v_org) then
    raise exception 'product not found' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 500 then
    raise exception 'count must be between 1 and 500' using errcode = '22023';
  end if;

  for i in 1..p_count loop
    loop
      begin
        insert into public.units (org_id, product_id, code)
        values (v_org, p_product, public.gen_unit_code())
        returning * into r;
        exit;
      exception when unique_violation then
        -- code collision: try another
      end;
    end loop;
    return next r;
  end loop;
end;
$$;

-- Check a unit out (direction 'out') or back in ('in').
-- result: ok | unknown | already | retired
create function public.move_unit(p_org uuid, p_code text, p_direction text, p_reference text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(btrim(p_code));
  v_unit public.units;
  v_name text;
  v_new  text;
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_direction not in ('in', 'out') then raise exception 'bad direction' using errcode = '22023'; end if;

  select u.* into v_unit from public.units u
  where u.org_id = p_org and u.code = v_code
  for update;

  if not found then
    return jsonb_build_object('result', 'unknown', 'code', v_code);
  end if;

  select name into v_name from public.products where id = v_unit.product_id;

  if v_unit.status = 'retired' then
    return jsonb_build_object('result', 'retired', 'code', v_code, 'product', v_name);
  end if;

  v_new := case p_direction when 'out' then 'out' else 'in_stock' end;
  if v_unit.status = v_new then
    return jsonb_build_object('result', 'already', 'code', v_code, 'product', v_name, 'status', v_unit.status);
  end if;

  update public.units set status = v_new, last_moved_at = now() where id = v_unit.id;
  insert into public.movements (org_id, unit_id, direction, reference, user_id)
  values (p_org, v_unit.id, p_direction, nullif(btrim(p_reference), ''), auth.uid());

  return jsonb_build_object(
    'result', 'ok', 'code', v_code, 'product', v_name,
    'previous', v_unit.status, 'status', v_new
  );
end;
$$;

-- Record one scan in an open count session.
-- result: ok | duplicate | unknown  (+ unit_status so the UI can flag "found")
create function public.record_scan(p_session uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_code   text := upper(btrim(p_code));
  v_org    uuid;
  v_status text;
  v_unit   public.units;
  v_name   text;
  v_result text;
begin
  -- Lock the session row: serialises concurrent scanners so duplicate
  -- detection is exact.
  select org_id, status into v_org, v_status
  from public.count_sessions where id = p_session for update;

  if v_org is null or not public.is_member(v_org) then
    raise exception 'session not found' using errcode = '42501';
  end if;
  if v_status <> 'open' then
    raise exception 'session is closed' using errcode = '22023';
  end if;

  select u.* into v_unit from public.units u where u.org_id = v_org and u.code = v_code;

  if not found then
    v_result := 'unknown';
  elsif exists (select 1 from public.count_scans
                where session_id = p_session and unit_id = v_unit.id and result = 'ok') then
    v_result := 'duplicate';
  else
    v_result := 'ok';
  end if;

  insert into public.count_scans (session_id, org_id, code, unit_id, result, user_id)
  values (p_session, v_org, v_code, v_unit.id, v_result, auth.uid());

  if v_unit.id is not null then
    select name into v_name from public.products where id = v_unit.product_id;
  end if;

  return jsonb_build_object(
    'result', v_result, 'code', v_code,
    'product', v_name, 'unit_status', v_unit.status
  );
end;
$$;

-- Expected vs counted. Runs as the caller, so RLS scopes everything.
--   expected = units currently in_stock
--   missing  = expected but not scanned
--   extra    = scanned but recorded as out / lost / retired ("found")
--   unknown  = codes that matched no unit
create function public.count_summary(p_session uuid)
returns jsonb
language sql stable security invoker set search_path = public as $$
  with s as (
    select id, org_id from public.count_sessions where id = p_session
  ),
  scanned as (
    select distinct cs.unit_id from public.count_scans cs, s
    where cs.session_id = s.id and cs.result = 'ok'
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
      where cs.session_id = s.id and cs.result = 'unknown'
    ), '[]'::jsonb)
  )
  from s;
$$;

-- Close a count. With p_apply = true:
--   missing units  → 'lost'
--   found out/lost → 'in_stock' (+ an 'in' movement referencing the count)
create function public.close_count(p_session uuid, p_apply boolean default false)
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
                    where cs.session_id = p_session and cs.unit_id = u.id and cs.result = 'ok')
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
                        where cs.session_id = p_session and cs.unit_id = u.id and cs.result = 'ok')
      returning 1
    )
    select count(*) into v_lost from lost;
  end if;

  update public.count_sessions set status = 'closed', closed_at = now() where id = p_session;

  return jsonb_build_object('lost', v_lost, 'found', v_found, 'applied', p_apply);
end;
$$;

-- ───────────────────────────── grants ─────────────────────────────

revoke execute on function
  public.is_member(uuid), public.is_owner(uuid), public.gen_unit_code(),
  public.create_org(text), public.generate_units(uuid, int),
  public.move_unit(uuid, text, text, text), public.record_scan(uuid, text),
  public.count_summary(uuid), public.close_count(uuid, boolean)
from public, anon;

grant execute on function
  public.is_member(uuid), public.is_owner(uuid),
  public.create_org(text), public.generate_units(uuid, int),
  public.move_unit(uuid, text, text, text), public.record_scan(uuid, text),
  public.count_summary(uuid), public.close_count(uuid, boolean)
to authenticated;
