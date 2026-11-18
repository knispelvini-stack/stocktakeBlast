# Deploy: Supabase + Vercel

Order matters: Supabase first (you need its URL/key for Vercel), then Vercel, then back to
Supabase to tell Auth the production URL.

## 1. Supabase project

1. New project → **region close to your users** (Australia: `ap-southeast-2` Sydney). The region
   can't be changed later.
2. Save the database password somewhere safe (not in the repo).
3. **SQL editor** → run, in order:
   - `supabase/migrations/20261116000000_init.sql`
   - `supabase/migrations/20261117000000_offline_sync.sql`
   - `supabase/migrations/20261118000000_harden_grants.sql`
   - `supabase/migrations/20261119000000_pin_access.sql`
   - `supabase/migrations/20261120000000_out_reference.sql`
   - `supabase/migrations/20261121000000_item_codes.sql`
   - `supabase/migrations/20261122000000_vehicles.sql`
   - `supabase/migrations/20261123000000_corrections.sql`
   - `supabase/migrations/20261124000000_operations.sql`

   Or with the CLI: `supabase link --project-ref <ref>` then `supabase db push`.
4. **Project Settings → API**: copy the **Project URL** and the **anon / publishable** key.
   Never put the `service_role` / secret key in the frontend or in Vercel env vars.

## 2. Vercel project

1. **Add New → Project → Import** `knispelvini-stack/stocktakeBlast`. Framework is detected as
   Vite; `vercel.json` sets build/output and the headers.
2. **Environment Variables** (Production *and* Preview):
   - `VITE_SUPABASE_URL` = Project URL
   - `VITE_SUPABASE_ANON_KEY` = anon key

   `VITE_*` values are baked into the JS at build time: after changing them, **redeploy**.
3. Deploy, note the production URL (e.g. `https://stocktakeblast.vercel.app`).

Why `vercel.json` matters: `sw.js` is served with `no-cache`. Without that, browsers keep an old
service worker and users don't get new versions of the app.

## 3. Company, owner and PIN (single company)

The app is for one company. Staff sign in with a shared **company PIN**; the owner signs in with
email + password to manage the PIN and devices.

1. **Authentication → Sign In / Providers → Anonymous sign-ins: ON.** Each staff device becomes an
   anonymous user and only gets access after the server checks the PIN. Without this, the PIN
   screen says "PIN sign-in is not enabled yet".
2. Create the owner account: **Authentication → Users → Add user** (email + password, auto-confirm).
3. Create the company and make that user its owner (SQL editor, once):

   ```sql
   select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'OWNER@EMAIL'), false);
   select public.create_org('Your Company');
   ```
4. Open the app → **Owner sign-in** → **Admin** tab → set the PIN (6–12 digits).

Rotating the PIN with "Also sign out every PIN device" is how you lock out someone who left.

## 4. Supabase Auth → URLs (easy to forget, breaks sign-up)

**Authentication → URL Configuration**
- **Site URL**: your production URL. Confirmation emails link here; the default is
  `http://localhost:3000`, which sends real users to a dead page.
- **Redirect URLs**: add the production URL and, if you use previews,
  `https://*-<your-vercel-team>.vercel.app/**`.

## 5. Email (only the owner account uses it)

Staff never receive email (PIN only). The built-in Supabase email is enough for the owner's
password reset, since it sends to members of your Supabase organisation. Add custom SMTP
(Resend, Postmark, SES…) only if other people will have email accounts.

## 6. Check production

1. On a phone: open the production URL → name + PIN → you're in.
2. Create a product, generate 3 units, print labels.
3. **Scanner** tab → scan a label.
4. Offline test: open the app once online, then disconnect (airplane mode), scan, reload the
   page, reconnect → badge goes to **Synced**, History shows the movements.

## Things to decide

- **Preview deployments use the same database as production** (same env vars). Fine for a solo
  project; once there are real customers, point Preview at a second Supabase project.
- **Backups**: the free plan has no point-in-time recovery. For customer data, use a paid plan or
  schedule `pg_dump` exports.
- **Free plan pauses** projects after a week without activity. A paying customer's warehouse
  can't hit a paused database.
