-- stocktakeBlast — single-company access with a shared PIN.
--
-- How it works:
--   * Each device signs in as a Supabase ANONYMOUS user (role `authenticated`,
--     its own auth.uid()), then calls join_with_pin(pin, name).
--   * The PIN is checked on the server against a bcrypt hash. Only then does
--     the device become a `member` of the company, so every existing RLS
--     policy and RPC keeps working unchanged.
--   * Brute force is throttled per device and for the whole company.
--   * The owner (email account) sets/rotates the PIN and removes devices.
--
-- Anonymous users get the `authenticated` role, so anything callable by
-- `authenticated` is callable by anyone who can reach the API. That's why
-- create_org is revoked here: in a single-company install nobody needs it.

-- ───────────────────────────── schema ─────────────────────────────

alter table public.org_members
  add column display_name text check (display_name is null or length(btrim(display_name)) between 1 and 40),
  add column last_seen_at timestamptz;

create table public.org_pins (
  org_id     uuid primary key references public.orgs (id) on delete cascade,
  pin_hash   text not null,
  updated_at timestamptz not null default now()
);

create table public.pin_attempts (
  id      bigint generated always as identity primary key,
  user_id uuid,
  org_id  uuid,
  ok      boolean not null,
  at      timestamptz not null default now()
);
create index pin_attempts_at_idx on public.pin_attempts (at);
create index pin_attempts_user_at_idx on public.pin_attempts (user_id, at);

-- Only reachable through the functions below.
alter table public.org_pins     enable row level security;
alter table public.pin_attempts enable row level security;
revoke all on public.org_pins, public.pin_attempts from anon, authenticated;

-- ───────────────────────────── helpers ─────────────────────────────

-- True for a real (email) account, false for anonymous PIN devices.
create function public.is_permanent_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users where id = auth.uid() and not coalesce(is_anonymous, false));
$$;

create function public._require_owner(p_org uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner(p_org) or not public.is_permanent_user() then
    raise exception 'only the owner can do this' using errcode = '42501';
  end if;
end;
$$;

-- ───────────────────────────── PIN ─────────────────────────────

create function public.set_pin(p_org uuid, p_pin text, p_remove_devices boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_removed int := 0;
begin
  perform public._require_owner(p_org);
  if p_pin is null or p_pin !~ '^[0-9]{6,12}$' then
    raise exception 'PIN must be 6 to 12 digits' using errcode = '22023';
  end if;

  insert into public.org_pins (org_id, pin_hash, updated_at)
  values (p_org, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), now())
  on conflict (org_id) do update set pin_hash = excluded.pin_hash, updated_at = now();

  if p_remove_devices then
    with d as (delete from public.org_members where org_id = p_org and role = 'member' returning 1)
    select count(*) into v_removed from d;
  end if;
  return jsonb_build_object('ok', true, 'removed_devices', v_removed);
end;
$$;

create function public.pin_status(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_owner(p_org);
  return jsonb_build_object(
    'has_pin', exists (select 1 from public.org_pins where org_id = p_org),
    'updated_at', (select updated_at from public.org_pins where org_id = p_org));
end;
$$;

-- Returns the org id on success, NULL on a wrong PIN (so the failed attempt
-- is recorded — raising would roll the record back). Raises when throttled.
create function public.join_with_pin(p_pin text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_org  uuid;
  r      record;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if length(v_name) not between 1 and 40 then
    raise exception 'enter your name (1 to 40 characters)' using errcode = '22023';
  end if;

  -- Per device: 5 wrong PINs per 15 minutes.
  if (select count(*) from public.pin_attempts
      where user_id = v_uid and not ok and at > now() - interval '15 minutes') >= 5 then
    raise exception 'too many wrong PINs on this device — wait 15 minutes' using errcode = 'P0001';
  end if;
  -- Whole system: 30 wrong PINs per 15 minutes (bounds guessing from many
  -- devices/IPs). Only blocks NEW devices joining; joined devices keep working.
  if (select count(*) from public.pin_attempts
      where not ok and at > now() - interval '15 minutes') >= 30 then
    raise exception 'PIN entry is temporarily locked — try again in 15 minutes' using errcode = 'P0001';
  end if;

  for r in select org_id, pin_hash from public.org_pins loop
    if extensions.crypt(coalesce(p_pin, ''), r.pin_hash) = r.pin_hash then
      v_org := r.org_id;
      exit;
    end if;
  end loop;

  insert into public.pin_attempts (user_id, org_id, ok) values (v_uid, v_org, v_org is not null);
  if v_org is null then
    return null;
  end if;

  insert into public.org_members (org_id, user_id, role, display_name, last_seen_at)
  values (v_org, v_uid, 'member', v_name, now())
  on conflict (org_id, user_id) do update
    set display_name = excluded.display_name, last_seen_at = now();
  return v_org;
end;
$$;

-- ───────────────────────────── devices ─────────────────────────────

create function public.touch_device(p_org uuid) returns void
language sql security definer set search_path = public as $$
  update public.org_members set last_seen_at = now()
  where org_id = p_org and user_id = auth.uid();
$$;

create function public.list_devices(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_owner(p_org);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'role', m.role,
      'name', coalesce(m.display_name, u.email),
      'email', u.email, 'pin_device', coalesce(u.is_anonymous, false),
      'joined_at', m.created_at, 'last_seen_at', m.last_seen_at)
      order by m.role, coalesce(m.last_seen_at, m.created_at) desc)
    from public.org_members m join auth.users u on u.id = m.user_id
    where m.org_id = p_org
  ), '[]'::jsonb);
end;
$$;

create function public.remove_device(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_owner(p_org);
  if p_user = auth.uid() then raise exception 'you cannot remove yourself' using errcode = '22023'; end if;
  delete from public.org_members where org_id = p_org and user_id = p_user and role = 'member';
end;
$$;

-- ───────────────────────────── names in reads ─────────────────────────────

-- my_orgs now also returns this device's display name.
create or replace function public.my_orgs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'org_id', m.org_id, 'role', m.role, 'name', o.name,
           'display_name', m.display_name) order by m.created_at), '[]'::jsonb)
  from public.org_members m join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid();
$$;

-- History shows the device's name for PIN devices, the email for accounts.
create or replace function public.movement_history(
  p_org        uuid,
  p_code       text        default null,
  p_direction  text        default null,
  p_reference  text        default null,
  p_from       timestamptz default null,
  p_to         timestamptz default null,
  p_before_at  timestamptz default null,
  p_before_id  uuid        default null,
  p_limit      int         default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(r order by r.scanned_at desc, r.id desc)
    from (
      select m.id, m.direction, m.reference, m.applied, m.scanned_at, m.created_at,
             u.code, p.name as product,
             coalesce(om.display_name, au.email) as user_label
      from public.movements m
      join public.units u on u.id = m.unit_id
      join public.products p on p.id = u.product_id
      left join auth.users au on au.id = m.user_id
      left join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
      where m.org_id = p_org
        and (p_code is null or u.code = upper(btrim(p_code)))
        and (p_direction is null or m.direction = p_direction)
        and (p_reference is null or m.reference ilike '%' || p_reference || '%')
        and (p_from is null or m.scanned_at >= p_from)
        and (p_to is null or m.scanned_at < p_to)
        and (p_before_at is null or (m.scanned_at, m.id) < (p_before_at, p_before_id))
      order by m.scanned_at desc, m.id desc
      limit least(greatest(p_limit, 1), 1000)
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ───────────────────────────── grants ─────────────────────────────

-- Single company: nobody creates companies from the app (anonymous PIN
-- devices are `authenticated` too). Bootstrap is a one-off SQL step (DEPLOY.md).
revoke execute on function public.create_org(text) from authenticated;

revoke execute on function
  public.is_permanent_user(), public._require_owner(uuid), public.set_pin(uuid, text, boolean),
  public.pin_status(uuid), public.join_with_pin(text, text), public.touch_device(uuid),
  public.list_devices(uuid), public.remove_device(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.set_pin(uuid, text, boolean), public.pin_status(uuid), public.join_with_pin(text, text),
  public.touch_device(uuid), public.list_devices(uuid), public.remove_device(uuid, uuid)
to authenticated;
