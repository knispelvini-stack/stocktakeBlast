# stocktakeBlast

Inventory app for **one company** where **every physical unit has its own barcode label**,
driven by any USB/Bluetooth barcode scanner in keyboard (HID) mode — no drivers, no app install.

- **Check out / in** — scan units leaving (van, job, loan) and coming back, with an optional reference.
- **Stocktake** — scan everything on the shelves; live expected vs counted, with the exact list of
  missing units, units found that the system had as out/lost, and unknown codes. Finishing can
  update stock (missing → lost, found → in stock).
- **Products & labels** — create products, generate N unique unit codes, print Code 128 labels on
  A4 sheets (Avery L7159, 3 × 8) or a 50 × 25 mm thermal roll.
- **History** — every movement with who/when/reference; search by product, code (or part of it),
  person, van or job; filter by unit (scan a label), direction, vehicle and dates; CSV export; scans
  waiting to sync and sync conflicts are shown on top.
- **Undo a scan / change van** — wrong item or wrong van: fix it from the scan list (see below).
- **Damaged / lost** — report damage with a note (while unloading, or from Inventory); mark a piece
  lost outside a stocktake. **Overdue** items (out longer than N days, set in Settings → Company)
  are listed on the Overview.
- **Import CSV** (owner) — create many products and their labels at once; **Codes (CSV)** export
  for a label printer's own software or a print shop.
- **Scanner** — setup checklist, live test and speed measurement to tune detection.
- **Works offline** — keep scanning with no connection; everything syncs when it's back.

Stack: React 19 + Vite, Supabase (Postgres, Auth, RLS). No router.

## Setup

Production (Supabase + Vercel): see [DEPLOY.md](DEPLOY.md).

Local:

1. Create a Supabase project.
2. Run the files in `supabase/migrations/` **in order** (SQL editor, or `supabase db push`).
3. Auth → Providers: keep **Email** enabled. For local testing you can turn off "Confirm email".
4. `cp .env.example .env` and fill in the project URL and **anon** key.
5. `npm install && npm run dev`

### Access

- **Staff**: name + shared **company PIN**, once per device (stays signed in). Each device is a
  Supabase anonymous user; the PIN is checked on the server (bcrypt) and wrong PINs are
  throttled (5 per device / 30 overall per 15 min). History shows the name each device entered.
- **Owner**: email + password → **Admin** tab: company name, set/rotate PIN, list and remove
  devices. Setup steps in [DEPLOY.md](DEPLOY.md#3-company-owner-and-pin-single-company).

The database is still multi-tenant (every row has `org_id`, RLS per membership), so a second
company later is a data step, not a rewrite.

## Item codes and labels

Every physical piece has one label with a meaningful code:

| Type | Pattern | Example | Notes |
|---|---|---|---|
| Banner | `BAN-<THEME PREFIX><size>-NN` | `BAN-PAW45-01` = Banner, Paw Patrol, 4x5, piece 01 | A theme has exactly one prefix, used for every size. The database computes the stem. |
| Castle | `CAS-NNN` | `CAS-001` | Scheme not final. Products sharing `CAS` share one numbering. |
| Blower | entered by hand | `BLO-C3` | Scheme not final. |
| Other | `<START>-NN`, or random | `TBL-01` / `8AJLGU62` | Blank start = old random 8-character codes. |

- Piece numbers are counted per code start across the company, allocated under a lock, and
  **never reused** (a retired `-02` stays taken).
- **Lost or damaged** piece → reprint the same code (Inventory → **Labels** → Reprint, works
  offline). **Discarded** piece → **Retire** (status `retired`; rows are never deleted — there is no
  delete permission on units or products).
- Labels: Code 128 barcode (any scanner) or QR (2D scanners only), with the code printed large.
  On A4 (Avery L7159) codes up to ~13 characters scan comfortably; the app warns above that.

## Vehicles (loading and unloading vans)

The owner registers vehicles in **Settings → Vehicles** (name, optional plate). Each gets a label
`VEH-01`, `VEH-02`… — print it and stick it inside the van.

- **Loading:** on **Check out / in**, scan the van's label (or pick it), then scan the items.
  The side panel lists everything on that van right now. Works offline.
- **Unloading:** switch to **Check IN**, scan the van's label: the panel shows what is **still out
  with that van**; each scanned item disappears from it. Whatever is left didn't come back.
- **Overview → Out right now** groups by vehicle; **Activity** shows and filters by vehicle.
- Unit codes can never start with `VEH-`, so a scan is never ambiguous. Vehicles are never deleted
  (deactivate instead) and only the owner can add or edit them.

## Fixing mistakes

- **Undo** (Check out / in → the scan list): a scan not synced yet is simply taken out of the
  queue — it never reaches the server. A synced scan gets a *correcting* movement (the opposite
  direction, linked to the original by `corrects_id`); undoing a check-in puts the unit back on the
  same van/reference. Nothing is deleted: Activity shows the original as **undone** and the fix as
  **undo**. Only the device that made the scan can undo it, and only while nobody has moved the unit
  since (otherwise the undo is recorded as *not applied* and shows under Needs attention).
- **Change van**: undo + check out onto the van you pick, in one step.
- **Edit product**: name and SKU only. Category, theme, size and code scheme are fixed once
  created — make a new product instead.
- **Retire / restore / mark lost** a unit: Inventory → product → **Manage** (or scan the label on the
  Inventory screen to jump to it). Goes through `set_unit_status()` and is logged in `unit_status_log`.
- **Damaged → repaired**: `set_unit_condition()` (note required). Condition is separate from status:
  a damaged piece can be out or in the warehouse. *Available* = in stock and not damaged. Checking
  out a damaged piece is allowed but shows a warning.
- **Stocktake, wrong scan**: **Remove** in the scan list. Unsynced → dropped; synced → voided on
  the server (`count_scan_voids`, the scan row is kept). Scanning the unit again counts it again.

## Import (CSV)

Inventory → **Import CSV** (owner). Columns: `type,name,sku,theme,prefix,size,stem,digits,quantity`
(download the template in the dialog). `type`: `BAN` (theme + size; prefix only for a new theme),
`CAS`, `BLO` (quantity 0 — codes by hand), `OTHER` (optional stem, e.g. `TBL`). `quantity` labels are
generated with the normal numbering. Everything is checked again in the database and imported
**all or nothing**; an error names the row.

## Printing durable labels

Paper labels won't survive outdoor use (wet, rolled, dragged). Options: a label maker with
laminated tape (prints Code 128/QR from its own software — use **Codes (CSV)** as the data source),
a thermal-transfer printer with polyester labels and a resin ribbon, or a print shop (send them the
CSV). Avoid direct-thermal labels for anything that sits in the sun — they fade.

## How the scanner works

A scanner in HID mode types the code very fast and presses Enter. `src/lib/scanDetector.js`
buffers keys while the gap between them stays under a threshold (default 50 ms — humans type
slower) and emits a scan on Enter/Tab. Keys typed inside form fields are ignored by the global
listener; the "Type or scan a code" field is the manual fallback (a scanner typing into it works too).

Scanner checklist: HID/keyboard mode (Bluetooth: pair as keyboard, not SPP), suffix = Enter,
scanner keyboard language = computer keyboard language, Code 128 enabled. Slow Bluetooth
scanner? Measure it in **Settings → Scanner** and raise the threshold (saved per device).
Codes contain hyphens (`BAN-PAW45-01`): check the hyphen comes out right — it is the key most
affected by a keyboard-language mismatch.

Legacy random codes are 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O or 1/I).

## Offline mode

The app is **local-first**: every scan is written to the device (IndexedDB) before anything else,
and the answer on screen comes from a local copy of the company's units. A sync loop then pushes
queued scans to `sync_events()` in batches of 100.

- **Nothing is lost on a dropped connection.** Each scan has a UUID generated on the device that
  becomes the row id on the server, so a batch that is re-sent after a lost response is not duplicated.
- **Conflicts: the latest scan time wins**, not the latest arrival. A scan made offline at 10:00 that
  reaches the server after another device moved the same unit at 11:00 is stored in history as
  *not applied* and listed under **History → Needs attention**.
- **The app opens offline** (service worker caches the app shell; production build only) and you stay
  signed in.
- **Top bar badge** always shows the truth: *Synced* / *N waiting to sync* / *Offline · N saved on device*.
- A code the device doesn't know (e.g. labels printed on another device since the last refresh) is
  still saved and decided by the server on sync.
- Starting and counting a stocktake works offline. **Finishing** one needs a connection and all of
  this device's scans for it synced, so the result includes every device.

Limits worth knowing:

- Sync runs only while the app is open. Queued scans survive closing the browser and are sent the
  next time it's opened.
- Conflict resolution trusts the device clock. Clocks ahead are clamped to the server time; a clock
  that is *behind* will lose conflicts it should win. Keep devices on automatic time.
- **iPhone/iPad (Safari):** Safari may delete website storage after ~7 days without use. Add the app
  to the Home Screen there, and don't leave scans unsynced for days.
- Creating products, generating codes and printing labels need a connection.
- Signing out deletes this device's local data (shared devices). If scans are still queued, the app
  warns first.
- The whole unit list of the company is cached on each device (fine up to tens of thousands).

## Data model and security

| Table | Purpose | Client writes |
|---|---|---|
| `orgs`, `org_members` | the company and its members (owner + PIN devices, with display name) | via `join_with_pin()` / owner RPCs; `create_org()` is SQL-only |
| `org_pins`, `pin_attempts` | bcrypt PIN hash, attempt log for throttling | **none** (no client access) |
| `products` | product types (name, optional SKU, code scheme) | insert by members; update of **name and SKU only**; never deleted |
| `units` | one row per physical item, `status`: in_stock / out / lost / retired | **none** — created via `generate_units()`, status via moves / `close_count()` / `set_unit_status()`; never deleted |
| `movements` | audit trail of every check out/in (`scanned_at`, `applied`, `vehicle_id`, `corrects_id`) | **none** — only via `sync_events()` / `close_count()` |
| `unit_status_log` | who retired / restored / lost / damaged / repaired which unit | **none** — only via `set_unit_status()` / `set_unit_condition()` |
| `count_scan_voids` | stocktake scans removed as wrong (lifted when re-scanned) | **none** — only via `sync_events()` |
| `count_sessions`, `count_scans` | stocktakes and each scan | via `sync_events()` (session insert also allowed) |

Read RPCs used by the offline cache and History: `my_orgs`, `pull_units`, `pull_sessions`,
`pull_scans`, `pull_vehicles`, `activity_feed` (keyset-paginated; `movement_history` is the older version kept for app versions still in use).

Every table has RLS keyed on `org_members` + `auth.uid()`. Composite foreign keys
(`(product_id, org_id)`, `(unit_id, org_id)`, `(session_id, org_id)`) make cross-tenant links
impossible even for a member of two companies. RPCs are `SECURITY DEFINER` and check membership
themselves; `anon` cannot execute any of them.

## Tests

```bash
npm test                                     # scanner detection + sync engine (fake IndexedDB)
PGURL=postgres://... npm run test:db         # SQL: sync rules, conflicts, tenant isolation (throwaway DB!)
PGHOST=... PGUSER=... npm run test:e2e       # real browser goes offline/online against the real SQL
```

The e2e test needs Postgres 15+ and Playwright with Chromium. It mocks only the Supabase HTTP layer
(`e2e/mock.cjs` calls the real SQL functions as role `authenticated`); it goes offline, scans,
reloads the page offline, creates a stocktake, comes back online and checks the database.

## Not in the MVP (yet)

- Inviting team members (no UI/RPC; add rows to `org_members` manually for now)
- Billing / plans
- Reports beyond the movement history / CSV
- Camera scanning on phones
- Lists over 1000 units per product are truncated in the product screen (stock counts and
  stocktake summaries are computed in SQL and are not affected)
