-- stocktakeBlast — meaningful item codes.
--
-- Codes follow <STEM>-<NN>, e.g. BAN-PAW45-01 = Banner, theme Paw Patrol
-- (prefix PAW), size 4x5, piece 01.
--
-- Rules enforced here (not left to the UI):
--   * A theme has exactly one prefix, used for every size (themes table:
--     prefix and name both unique per company).
--   * Banner stems are always BAN-<theme prefix><size digits>; the database
--     computes them, nobody types them.
--   * Piece numbers are counted per STEM across the whole company (two castle
--     products both using CAS share one sequence: CAS-001, CAS-002, …), are
--     never reused, and are allocated under a lock (two devices can't collide).
--   * Units and products are never deleted. Lost/damaged pieces are reprinted
--     with the same code; a discarded piece becomes status 'retired'.
--   * Schemes that aren't settled yet (blowers, e.g. BLO-C3) can add a unit
--     with an exact code by hand.
-- Products without a stem keep the old random 8-character codes.

-- ───────────────────────────── themes ─────────────────────────────

create table public.themes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  prefix     text not null check (prefix ~ '^[A-Z][A-Z0-9]{1,5}$'),
  created_at timestamptz not null default now(),
  unique (org_id, prefix),
  unique (id, org_id)
);
create unique index themes_org_name_uq on public.themes (org_id, lower(btrim(name)));

alter table public.themes enable row level security;
revoke all on public.themes from anon; -- Supabase grants new tables to anon by default
create policy themes_select on public.themes for select to authenticated
  using (public.is_member(org_id));
create policy themes_insert on public.themes for insert to authenticated
  with check (public.is_member(org_id));
-- No update/delete: changing a prefix would break every printed label.

-- ───────────────────────────── product code scheme ─────────────────────────────

alter table public.products
  add column category    text check (category is null or category ~ '^[A-Z]{2,5}$'),
  add column theme_id    uuid,
  add column size        text check (size is null or size ~ '^[0-9]{1,3}x[0-9]{1,3}$'),
  add column code_stem   text check (code_stem is null or code_stem ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'),
  add column code_digits int  not null default 2 check (code_digits between 1 and 4),
  add constraint products_theme_fk foreign key (theme_id, org_id) references public.themes (id, org_id);

create function public._product_code_scheme() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prefix text;
begin
  new.category := nullif(upper(btrim(new.category)), '');
  new.code_stem := nullif(upper(btrim(new.code_stem)), '');
  new.size := nullif(lower(replace(btrim(new.size), ' ', '')), '');

  if new.category = 'BAN' then
    if new.theme_id is null or new.size is null then
      raise exception 'a banner needs a theme and a size' using errcode = '22023';
    end if;
    select prefix into v_prefix from public.themes where id = new.theme_id and org_id = new.org_id;
    if v_prefix is null then raise exception 'theme not found' using errcode = '22023'; end if;
    new.code_stem := 'BAN-' || v_prefix || replace(new.size, 'x', '');
    new.code_digits := 2;
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

create trigger products_code_scheme
  before insert or update on public.products
  for each row execute function public._product_code_scheme();

-- One banner product per theme+size, and no two banners whose sizes collapse
-- to the same stem (4x15 and 41x5 would both be BAN-PAW415).
create unique index products_banner_stem_uq on public.products (org_id, code_stem) where category = 'BAN';

-- Never delete products or units (history must stay complete).
drop policy if exists products_delete on public.products;
drop policy if exists units_delete on public.units;

-- ───────────────────────────── generation ─────────────────────────────

-- Highest piece number used so far for a stem, across the company.
create function public._max_piece(p_org uuid, p_stem text) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(substring(code from length(p_stem) + 2)::int), 0)
  from public.units
  where org_id = p_org
    and code like p_stem || '-%'
    and substring(code from length(p_stem) + 2) ~ '^[0-9]+$';
$$;
revoke execute on function public._max_piece(uuid, text) from public, anon, authenticated;

create or replace function public.generate_units(p_product uuid, p_count int)
returns setof public.units
language plpgsql security definer set search_path = public as $$
declare
  v_prod public.products;
  r      public.units;
  i      int;
  v_next int;
begin
  select * into v_prod from public.products where id = p_product;
  if v_prod.id is null or not public.is_member(v_prod.org_id) then
    raise exception 'product not found' using errcode = '42501';
  end if;
  if p_count is null or p_count < 1 or p_count > 500 then
    raise exception 'count must be between 1 and 500' using errcode = '22023';
  end if;

  if v_prod.code_stem is null then
    -- legacy: random codes
    for i in 1..p_count loop
      loop
        begin
          insert into public.units (org_id, product_id, code)
          values (v_prod.org_id, p_product, public.gen_unit_code())
          returning * into r;
          exit;
        exception when unique_violation then
        end;
      end loop;
      return next r;
    end loop;
    return;
  end if;

  -- One sequence per stem: serialise everyone generating for this stem.
  perform pg_advisory_xact_lock(hashtextextended(v_prod.org_id::text || ':' || v_prod.code_stem, 0));
  v_next := public._max_piece(v_prod.org_id, v_prod.code_stem);

  if v_next + p_count >= power(10, v_prod.code_digits) then
    raise exception 'only % piece numbers left for % (up to %)',
      greatest(power(10, v_prod.code_digits)::int - 1 - v_next, 0), v_prod.code_stem,
      v_prod.code_stem || '-' || repeat('9', v_prod.code_digits)
      using errcode = '22023';
  end if;

  for i in 1..p_count loop
    insert into public.units (org_id, product_id, code)
    values (v_prod.org_id, p_product, v_prod.code_stem || '-' || lpad((v_next + i)::text, v_prod.code_digits, '0'))
    returning * into r;
    return next r;
  end loop;
end;
$$;

-- Add one unit with an exact code (schemes not settled yet, e.g. BLO-C3, or
-- registering a piece that already carries a label).
create function public.add_unit_with_code(p_product uuid, p_code text)
returns public.units
language plpgsql security definer set search_path = public as $$
declare
  v_prod public.products;
  v_code text := upper(btrim(coalesce(p_code, '')));
  r      public.units;
begin
  select * into v_prod from public.products where id = p_product;
  if v_prod.id is null or not public.is_member(v_prod.org_id) then
    raise exception 'product not found' using errcode = '42501';
  end if;
  if v_code !~ '^[A-Z0-9]+(-[A-Z0-9]+)*$' or length(v_code) not between 3 and 32 then
    raise exception 'codes use A-Z, 0-9 and single hyphens (3 to 32 characters)' using errcode = '22023';
  end if;
  begin
    insert into public.units (org_id, product_id, code)
    values (v_prod.org_id, p_product, v_code)
    returning * into r;
  exception when unique_violation then
    raise exception 'code % is already used', v_code using errcode = '23505';
  end;
  return r;
end;
$$;

-- Preview the next codes without creating anything.
create function public.next_codes(p_product uuid, p_count int default 3)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_prod public.products; v_next int;
begin
  select * into v_prod from public.products where id = p_product;
  if v_prod.id is null or not public.is_member(v_prod.org_id) then
    raise exception 'product not found' using errcode = '42501';
  end if;
  if v_prod.code_stem is null then return '[]'::jsonb; end if;
  v_next := public._max_piece(v_prod.org_id, v_prod.code_stem);
  return coalesce((
    select jsonb_agg(v_prod.code_stem || '-' || lpad((v_next + g)::text, v_prod.code_digits, '0') order by g)
    from generate_series(1, least(greatest(p_count, 1), 10)) g
    where v_next + g < power(10, v_prod.code_digits)
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.add_unit_with_code(uuid, text), public.next_codes(uuid, int) from public, anon;
grant execute on function public.add_unit_with_code(uuid, text), public.next_codes(uuid, int) to authenticated;
