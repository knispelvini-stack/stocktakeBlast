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

## 3. Supabase Auth → URLs (easy to forget, breaks sign-up)

**Authentication → URL Configuration**
- **Site URL**: your production URL. Confirmation emails link here; the default is
  `http://localhost:3000`, which sends real users to a dead page.
- **Redirect URLs**: add the production URL and, if you use previews,
  `https://*-<your-vercel-team>.vercel.app/**`.

## 4. Email (blocker for real customers)

Supabase's built-in email is for testing only: it is heavily rate-limited and sends only to
members of your Supabase organisation. Customers signing up will **not** receive the
confirmation email.

Before inviting anyone: **Authentication → Emails → SMTP Settings** → custom SMTP (Resend,
Postmark, Amazon SES, …) with a domain you own (SPF/DKIM set up at your DNS provider).

For a private pilot only, you can instead turn off **Confirm email** (Authentication →
Providers → Email). Turn it back on before opening sign-ups.

## 5. Check production

1. Open the production URL → create an account → confirmation email arrives → sign in.
2. Create a company, a product, generate 3 units, print labels.
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
