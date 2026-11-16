-- stocktakeBlast — "what's out, and where" for the Overview screen.
--
-- pull_units() (the offline cache feed) now also returns, for units that are
-- out, the reference of the movement that took them out (e.g. "Van 2") and
-- when. The Overview groups out units by that reference and works offline,
-- because it reads only the local cache.
--
-- Same signature, same grants (CREATE OR REPLACE keeps privileges), and the
-- extra keys are ignored by older clients.

create or replace function public.pull_units(p_org uuid, p_after text default null, p_limit int default 2000)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'code', u.code, 'status', u.status, 'product_id', u.product_id,
      'product', p.name, 'last_moved_at', u.last_moved_at,
      'last_ref', lm.reference, 'out_since', lm.scanned_at) order by u.code)
    from (select * from public.units
          where org_id = p_org and (p_after is null or code > p_after)
          order by code limit least(greatest(p_limit, 1), 5000)) u
    join public.products p on p.id = u.product_id
    left join lateral (
      select m.reference, m.scanned_at
      from public.movements m
      where m.unit_id = u.id and m.applied and m.direction = 'out' and u.status = 'out'
      order by m.scanned_at desc
      limit 1
    ) lm on true
  ), '[]'::jsonb);
end;
$$;

-- ───────────── keep "who did it" after a device is removed ─────────────
-- remove_device() deletes the membership row, and with it the device's name,
-- so History lost who made that device's movements. Names are now also kept
-- in device_names, which is never deleted from.

create table public.device_names (
  org_id       uuid not null references public.orgs (id) on delete cascade,
  user_id      uuid not null,
  display_name text not null,
  updated_at   timestamptz not null default now(),
  primary key (org_id, user_id)
);
alter table public.device_names enable row level security;
revoke all on public.device_names from anon, authenticated;

create function public._remember_device_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.display_name is not null then
    insert into public.device_names (org_id, user_id, display_name, updated_at)
    values (new.org_id, new.user_id, new.display_name, now())
    on conflict (org_id, user_id) do update set display_name = excluded.display_name, updated_at = now();
  end if;
  return new;
end;
$$;
revoke execute on function public._remember_device_name() from public, anon, authenticated;

create trigger org_members_remember_name
  after insert or update of display_name on public.org_members
  for each row execute function public._remember_device_name();

insert into public.device_names (org_id, user_id, display_name)
select org_id, user_id, display_name from public.org_members where display_name is not null
on conflict do nothing;

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
             coalesce(om.display_name, au.email,
                      dn.display_name || ' (removed)', 'Removed device') as user_label
      from public.movements m
      join public.units u on u.id = m.unit_id
      join public.products p on p.id = u.product_id
      left join auth.users au on au.id = m.user_id
      left join public.org_members om on om.org_id = m.org_id and om.user_id = m.user_id
      left join public.device_names dn on dn.org_id = m.org_id and dn.user_id = m.user_id
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
