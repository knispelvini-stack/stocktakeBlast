-- stocktakeBlast — banner size codes.
--
-- Banner stems are BAN-<theme prefix><size digits> (4x5 → BAN-PAW45). Some
-- sizes have a name the team already uses instead, e.g. the 4.5 x 6 m combo is
-- "C4": products.size_code (optional) replaces the digits → BAN-LIOC4-01.
-- products.size keeps the real dimensions (4.5x6 is stored as 45x6; the
-- size check only allows whole numbers). Fixed once labels exist, like the
-- rest of the scheme; not client-updatable (column grants allow name/sku only).
-- No DROP statements.

alter table public.products
  add column size_code text check (size_code is null or size_code ~ '^[A-Z][A-Z0-9]{0,3}$');

create or replace function public._product_code_scheme() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prefix text;
begin
  new.category := nullif(upper(btrim(new.category)), '');
  new.code_stem := nullif(upper(btrim(new.code_stem)), '');
  new.size := nullif(lower(replace(btrim(new.size), ' ', '')), '');
  new.size_code := nullif(upper(btrim(new.size_code)), '');

  if new.category = 'BAN' then
    if new.theme_id is null or new.size is null then
      raise exception 'a banner needs a theme and a size' using errcode = '22023';
    end if;
    select prefix into v_prefix from public.themes where id = new.theme_id and org_id = new.org_id;
    if v_prefix is null then raise exception 'theme not found' using errcode = '22023'; end if;
    new.code_stem := 'BAN-' || v_prefix || coalesce(new.size_code, replace(new.size, 'x', ''));
    new.code_digits := 2;
  elsif new.size_code is not null then
    raise exception 'a size code is only for banners' using errcode = '22023';
  end if;

  -- Once labels exist, the scheme is frozen (they're already printed).
  if tg_op = 'UPDATE'
     and (new.code_stem is distinct from old.code_stem or new.code_digits is distinct from old.code_digits)
     and exists (select 1 from public.units where product_id = old.id) then
    raise exception 'this product already has labels; its code scheme can''t change' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function public._product_code_scheme() from public, anon, authenticated;

-- CSV import: optional size_code column for banners.
create or replace function public.import_products(p_org uuid, p_rows jsonb) returns jsonb
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

      insert into public.products (org_id, name, sku, category, theme_id, size, size_code, code_stem, code_digits)
      values (
        p_org, v_name, nullif(btrim(r->>'sku'), ''),
        case when v_type = 'OTHER' then null else v_type end,
        v_theme, case when v_type = 'BAN' then v_size end,
        case when v_type = 'BAN' then nullif(upper(btrim(r->>'size_code')), '') end,
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
