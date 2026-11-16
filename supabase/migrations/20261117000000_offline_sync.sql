-- stocktakeBlast — offline-first sync + history
--
-- Clients now record every scan locally first (IndexedDB) and push them in
-- batches through sync_events(). Each event carries a client-generated UUID
-- that becomes the row's primary key, so retrying a batch after a dropped
-- connection never creates duplicates.
--
-- Conflict rule: the LATEST SCAN TIME wins, not the latest arrival. An event
-- that arrives after a newer movement of the same unit is stored in history
-- with applied = false and does not change the unit's status.

-- ───────────────────────────── schema ─────────────────────────────

alter table public.movements
  add column scanned_at timestamptz not null default now(),
  add column applied    boolean     not null default true;

create index movements_org_scanned_idx on public.movements (org_id, scanned_at desc, id desc);

alter table public.count_scans
  add column scanned_at timestamptz not null default now();

-- last_moved_at now means "scanned_at of the last APPLIED movement".

-- The online-only RPCs are replaced by sync_events().
drop function public.move_unit(uuid, text, text, text);
drop function public.record_scan(uuid, text);

-- ───────────────────────────── sync ─────────────────────────────

-- Event time from the device, never in the future (guards against a device
-- whose clock runs ahead "winning" every conflict).
create function public._event_time(p_ev jsonb) returns timestamptz
language sql stable set search_path = public as $$
  select least(coalesce((p_ev->>'scanned_at')::timestamptz, now()), now());
$$;

create function public._sync_move(p_ev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid := (p_ev->>'client_id')::uuid;
  v_org  uuid := (p_ev->>'org_id')::uuid;
  v_code text := upper(btrim(p_ev->>'code'));
  v_dir  text := p_ev->>'direction';
  v_at   timestamptz := public._event_time(p_ev);
  v_prev public.movements;
  v_unit public.units;
  v_name text;
  v_new  text;
begin
  if not public.is_member(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dir not in ('in', 'out') then raise exception 'bad direction' using errcode = '22023'; end if;

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
    -- A newer movement already decided this unit's status. Keep the record.
    insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied)
    values (v_id, v_org, v_unit.id, v_dir, nullif(btrim(p_ev->>'reference'), ''), auth.uid(), v_at, false);
    return jsonb_build_object('result', 'late', 'unit_id', v_unit.id, 'status', v_unit.status, 'product', v_name);
  end if;

  update public.units set status = v_new, last_moved_at = v_at where id = v_unit.id;
  insert into public.movements (id, org_id, unit_id, direction, reference, user_id, scanned_at, applied)
  values (v_id, v_org, v_unit.id, v_dir, nullif(btrim(p_ev->>'reference'), ''), auth.uid(), v_at, true);

  return jsonb_build_object('result', 'ok', 'unit_id', v_unit.id, 'status', v_new,
                            'previous', v_unit.status, 'product', v_name);
end;
$$;

create function public._sync_scan(p_ev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id      uuid := (p_ev->>'client_id')::uuid;
  v_session uuid := (p_ev->>'session_id')::uuid;
  v_code    text := upper(btrim(p_ev->>'code'));
  v_prev    public.count_scans;
  v_org     uuid;
  v_status  text;
  v_unit    public.units;
  v_name    text;
  v_result  text;
begin
  -- Lock the session: serialises devices counting the same session.
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
  elsif exists (select 1 from public.count_scans
                where session_id = v_session and unit_id = v_unit.id and result = 'ok') then
    v_result := 'duplicate';
  else
    v_result := 'ok';
  end if;

  insert into public.count_scans (id, session_id, org_id, code, unit_id, result, user_id, scanned_at)
  values (v_id, v_session, v_org, v_code, v_unit.id, v_result, auth.uid(), public._event_time(p_ev));

  if v_unit.id is not null then
    select name into v_name from public.products where id = v_unit.product_id;
  end if;
  return jsonb_build_object('result', v_result, 'unit_id', v_unit.id,
                            'unit_status', v_unit.status, 'product', v_name);
end;
$$;

create function public._sync_session(p_ev jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id  uuid := (p_ev->>'client_id')::uuid;
  v_org uuid := (p_ev->>'org_id')::uuid;
  v_existing uuid;
begin
  if not public.is_member(v_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  select org_id into v_existing from public.count_sessions where id = v_id;
  if v_existing is not null then
    if v_existing <> v_org then raise exception 'forbidden' using errcode = '42501'; end if;
    return jsonb_build_object('result', 'ok', 'replayed', true);
  end if;
  insert into public.count_sessions (id, org_id, name, created_by, created_at)
  values (v_id, v_org, coalesce(nullif(btrim(p_ev->>'name'), ''), 'Stocktake'), auth.uid(),
          public._event_time(p_ev));
  return jsonb_build_object('result', 'ok');
end;
$$;

-- Batch entry point. Events are processed in the order given (clients send
-- them sorted by scan time). A failing event never blocks the others: it is
-- answered with result = 'error' and the client moves it to "needs attention".
create function public.sync_events(p_events jsonb) returns jsonb
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

-- ───────────────────────────── reads for the local cache ─────────────────────────────

create function public.my_orgs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', m.org_id, 'role', m.role, 'name', o.name)
                            order by m.created_at), '[]'::jsonb)
  from public.org_members m join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid();
$$;

-- Keyset-paginated unit list (by code) for the offline cache.
create function public.pull_units(p_org uuid, p_after text default null, p_limit int default 2000)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id, 'code', u.code, 'status', u.status, 'product_id', u.product_id,
      'product', p.name, 'last_moved_at', u.last_moved_at) order by u.code)
    from (select * from public.units
          where org_id = p_org and (p_after is null or code > p_after)
          order by code limit least(greatest(p_limit, 1), 5000)) u
    join public.products p on p.id = u.product_id
  ), '[]'::jsonb);
end;
$$;

create function public.pull_sessions(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.created_at desc)
    from (select id, org_id, name, status, created_at, closed_at
          from public.count_sessions where org_id = p_org
          order by created_at desc limit 50) s
  ), '[]'::jsonb);
end;
$$;

create function public.pull_scans(p_session uuid) returns jsonb
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
      'result', result, 'scanned_at', scanned_at) order by scanned_at)
    from public.count_scans where session_id = p_session
  ), '[]'::jsonb);
end;
$$;

-- Movement history with filters and keyset pagination (newest first).
--   p_code      exact unit code (scanner-friendly)
--   p_reference case-insensitive substring
--   p_before_at / p_before_id  cursor from the last row of the previous page
create function public.movement_history(
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
             u.code, p.name as product, au.email as user_email
      from public.movements m
      join public.units u on u.id = m.unit_id
      join public.products p on p.id = u.product_id
      left join auth.users au on au.id = m.user_id
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

revoke execute on function
  public._event_time(jsonb), public._sync_move(jsonb), public._sync_scan(jsonb),
  public._sync_session(jsonb), public.sync_events(jsonb), public.my_orgs(),
  public.pull_units(uuid, text, int), public.pull_sessions(uuid), public.pull_scans(uuid),
  public.movement_history(uuid, text, text, text, timestamptz, timestamptz, timestamptz, uuid, int)
from public, anon;

grant execute on function
  public.sync_events(jsonb), public.my_orgs(),
  public.pull_units(uuid, text, int), public.pull_sessions(uuid), public.pull_scans(uuid),
  public.movement_history(uuid, text, text, text, timestamptz, timestamptz, timestamptz, uuid, int)
to authenticated;
