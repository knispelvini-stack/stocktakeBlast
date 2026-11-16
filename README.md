# stocktakeBlast

Multi-company inventory SaaS where **every physical unit has its own barcode label**,
driven by any USB/Bluetooth barcode scanner in keyboard (HID) mode — no drivers, no app install.

- **Check out / in** — scan units leaving (van, job, loan) and coming back, with an optional reference.
- **Stocktake** — scan everything on the shelves; live expected vs counted, with the exact list of
  missing units, units found that the system had as out/lost, and unknown codes. Finishing can
  update stock (missing → lost, found → in stock).
- **Products & labels** — create products, generate N unique unit codes, print Code 128 labels on
  A4 sheets (Avery L7159, 3 × 8) or a 50 × 25 mm thermal roll.
- **Scanner** — setup checklist, live test and speed measurement to tune detection.

Stack: React 19 + Vite, Supabase (Postgres, Auth, RLS). No router.

## Setup

1. Create a Supabase project.
2. Run `supabase/migrations/20261116000000_init.sql` (SQL editor, or `supabase db push`).
3. Auth → Providers: keep **Email** enabled. For local testing you can turn off "Confirm email".
4. `cp .env.example .env` and fill in the project URL and **anon** key.
5. `npm install && npm run dev`

The first account creates a company and becomes its owner.

## How the scanner works

A scanner in HID mode types the code very fast and presses Enter. `src/lib/scanDetector.js`
buffers keys while the gap between them stays under a threshold (default 50 ms — humans type
slower) and emits a scan on Enter/Tab. Keys typed inside form fields are ignored by the global
listener; the "Type or scan a code" field is the manual fallback (a scanner typing into it works too).

Scanner checklist: HID/keyboard mode (Bluetooth: pair as keyboard, not SPP), suffix = Enter,
scanner keyboard language = computer keyboard language, Code 128 enabled. Slow Bluetooth
scanner? Measure it on the **Scanner** tab and raise the threshold (saved per device).

Unit codes are 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O or 1/I).

## Data model and security

| Table | Purpose | Client writes |
|---|---|---|
| `orgs`, `org_members` | companies and who belongs to them | via `create_org()` only |
| `products` | product types (name, optional SKU) | insert/update by members, delete by owner |
| `units` | one row per physical item, `status`: in_stock / out / lost / retired | created via `generate_units()`; members may update (retire); owner deletes |
| `movements` | audit trail of every check out/in | **none** — only via `move_unit()` / `close_count()` |
| `count_sessions`, `count_scans` | stocktakes and each scan | session insert; scans via `record_scan()` only |

Every table has RLS keyed on `org_members` + `auth.uid()`. Composite foreign keys
(`(product_id, org_id)`, `(unit_id, org_id)`, `(session_id, org_id)`) make cross-tenant links
impossible even for a member of two companies. RPCs are `SECURITY DEFINER` and check membership
themselves; `anon` cannot execute any of them.

## Tests

```bash
npm test                     # scanner detection unit tests
PGURL=postgres://... supabase/tests/run.sh   # DB smoke + tenant-isolation test (empty throwaway DB!)
```

The DB test runs the full flow as user A and then attacks A's company as user B. The `ERROR`
lines in its output are expected — each one is a blocked attempt.

## Not in the MVP (yet)

- Inviting team members (no UI/RPC; add rows to `org_members` manually for now)
- Billing / plans
- Movement history screen and reports/export
- Camera scanning on phones
- Offline mode (scans need a connection)
- Lists over 1000 units per product are truncated in the product screen (stock counts and
  stocktake summaries are computed in SQL and are not affected)
