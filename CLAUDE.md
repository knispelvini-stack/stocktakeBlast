# stocktakeBlast

Single-company inventory app (unrelated to lobase), on a multi-tenant schema. One barcode label per physical unit,
read by keyboard-wedge (HID) USB/Bluetooth scanners. See README.md for the full picture.

## Rules

- Tenancy is enforced in the database (RLS on `org_members` + `auth.uid()`, composite FKs on
  `org_id`). Never add a policy with `using (true)` / `with check (true)`, and never rely on
  client-side `org_id` filtering for security.
- `movements` and `count_scans` are an audit trail: written only by SECURITY DEFINER RPCs.
  New RPCs must check `is_member()` and be granted to `authenticated` only (revoke from anon/public).
- Schema changes go in a new file in `supabase/migrations/`; extend `supabase/tests/smoke.sql`
  with both the happy path and a cross-tenant attempt, and run `supabase/tests/run.sh`.
- Scanner detection logic stays pure in `src/lib/scanDetector.js` (unit-tested with `npm test`);
  `useScanner` only wires it to the DOM.
- Offline-first: scans go through the sync engine (`src/lib/sync.js`) → IndexedDB outbox →
  `sync_events()`. Never call the server directly from a scan handler. Every event's client UUID is
  the server row id (idempotency) — keep it that way. Conflicts resolve by `scanned_at`.
- Changes to sync behaviour need tests in `src/lib/sync.test.js` and, for SQL, `smoke.sql`;
  run `npm run test:e2e` before shipping.
- Staff devices are Supabase **anonymous users** (role `authenticated`) that joined via
  `join_with_pin()`. So `authenticated` means "anyone who can reach the API": every RPC must check
  `is_member()` (or `_require_owner()` for admin actions); never grant something to
  `authenticated` assuming it implies a real account.
- No React Router — tab state in `App.jsx`. Navigation (`NAV` in App.jsx): Overview, Check out / in,
  Stocktake, Inventory, Activity; everything else lives in Settings (gear). Add screens there, not
  as new top-level tabs.
- UI: use the primitives in `src/components/ui/` (PageHeader, Section, Stat, EmptyState, Modal,
  Badge, Icon) and `useUI()` for `toast()` / `confirm()`. Never `window.alert` / `window.confirm`.
- Every screen must pass the responsive audit (320–1440px, no page-level horizontal scroll,
  ≥40px tap targets on touch layouts).
- After clicking buttons on scan screens, blur them, so a scanner's Enter can't re-trigger them.
