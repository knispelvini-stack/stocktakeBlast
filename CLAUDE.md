# stocktakeBlast

Standalone multi-tenant inventory SaaS (unrelated to lobase). One barcode label per physical unit,
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
- No React Router — tab state in `App.jsx`.
- After clicking buttons on scan screens, blur them, so a scanner's Enter can't re-trigger them.
