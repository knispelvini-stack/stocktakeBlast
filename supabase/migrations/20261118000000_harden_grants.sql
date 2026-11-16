-- stocktakeBlast — tighten grants to match intent on Supabase.
--
-- Supabase's default privileges grant EXECUTE on every new function in
-- `public` to anon AND authenticated, and table privileges to anon. The
-- earlier migrations only revoked from public/anon, so internal helpers were
-- still callable by any signed-in user. They check membership themselves (no
-- data leak), but the only supported entry point is sync_events().

revoke execute on function
  public._event_time(jsonb),
  public._sync_move(jsonb),
  public._sync_scan(jsonb),
  public._sync_session(jsonb),
  public.gen_unit_code()
from authenticated;

-- anon has no RLS policies (so it already sees nothing); remove the table
-- grants too, so a future policy mistake can't expose data to logged-out users.
revoke all on
  public.orgs, public.org_members, public.products, public.units,
  public.movements, public.count_sessions, public.count_scans, public.product_stock
from anon;
