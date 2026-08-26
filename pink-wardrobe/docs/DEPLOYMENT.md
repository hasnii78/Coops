# Deployment

## Verify first

The build environment had no Supabase project and no FASHN key, so parts of
this are written-and-reviewed rather than run-and-observed. Be honest with
yourself about which is which.

| Area | State |
| --- | --- |
| Web app builds | Verified — builds clean |
| No secrets in the client bundle | Verified — only the anon key is referenced |
| No Firebase references remain | Verified |
| SQL schema and RLS policies | Written, **not** applied to a live project |
| Edge Functions | Written, **never deployed or executed** |
| FASHN request shape | **Unverified** — see below |
| On-device segmentation and alignment | **Never run** |
| End-to-end pipeline | **Never run** |

### The FASHN contract is the first thing to check

`docs.fashn.ai` was blocked by the build environment's network egress, so
`supabase/functions/_shared/fashn.ts` was written against the contract
recoverable from search results: `POST /v1/run`, poll `GET /v1/status/{id}`,
response `{id, status, output[], error}`.

Confirm before spending real credits:

- Is the top-level field `model_name`, with inputs nested under `inputs`?
- Are the image keys `model_image` and `garment_image`?
- Are the `category` values `tops` / `bottoms` / `one-pieces`?
- **Are base64 data URIs accepted for images?**

That last one is load-bearing. Images are inlined as data URIs specifically so
nothing in the bucket ever needs to be publicly fetchable. If FASHN accepts only
fetchable URLs, that is a real design change — you would need signed URLs with a
short TTL, and you should decide that deliberately rather than by accident.

Everything FASHN-related is confined to that one file.

---

## What to configure in the Supabase dashboard

### 1. Create the project

**supabase.com/dashboard → New project.** Note the project ref (the
`xxxx.supabase.co` subdomain). Choose a region near you — every image upload
crosses it.

### 2. Run the migrations

Either paste them into **SQL Editor** in order:

1. `supabase/migrations/20260826000001_init.sql`
2. `supabase/migrations/20260826000002_wear_rpc.sql`

Or, with the CLI: `supabase link --project-ref <ref> && supabase db push`.

This creates the tables, enables RLS, adds every policy, and creates both
private Storage buckets. **Do this before storing a single real photo.**

### 3. Turn off public signup

**Authentication → Providers → Email.** Leave the provider enabled (it is what
backs password login) but set **Enable signup** to **off**.

Accounts are created only through the `signup` Edge Function, which enforces
username rules and the uniqueness constraint. Leaving the public endpoint open
would let anyone create an account with a raw email address, bypassing that.

You will not need any email settings: the addresses are synthetic and
undeliverable, and confirmation is disabled.

### 4. Set the Edge Function secrets

**Edge Functions → Secrets → Add new secret:**

| Name | Value |
| --- | --- |
| `FASHN_API_KEY` | your FASHN.ai key |
| `PURGE_SECRET` | any long random string you invent |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically. Do not add them.

### 5. Deploy the functions

```bash
supabase functions deploy signup
supabase functions deploy process-garment
supabase functions deploy purge-recycle-bin
```

### 6. Schedule the recycle-bin purge

**Database → Extensions**, enable `pg_cron` and `pg_net`. Then in SQL Editor:

```sql
select cron.schedule(
  'purge-recycle-bin',
  '0 3 * * *',
  $$
  select net.http_post(
    url     := 'https://<your-ref>.supabase.co/functions/v1/purge-recycle-bin',
    headers := '{"x-purge-secret": "<your PURGE_SECRET>"}'::jsonb
  );
  $$
);
```

Without this, deleted items are never actually removed and their images
accumulate storage cost forever.

---

## What to put in `.env`

Copy `.env.example` to `web/.env.local`:

```
VITE_SUPABASE_URL=https://<your-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
VITE_OPENWEATHER_API_KEY=<optional>
```

Both come from **Project Settings → API**.

**The anon key is meant to be public.** It ships in the browser bundle and in
the APK, and that is fine — RLS is what protects your data, not the secrecy of
this key.

**Never put the service role key or the FASHN key in a `VITE_` variable.**
Anything prefixed `VITE_` is compiled into the bundle and readable by anyone who
downloads the app. There is no way to hide it afterwards; the only remedy is to
rotate the key.

---

## Known risks

### The FASHN request shape

Covered above. Cheap to fix, but you'll be debugging blind if you don't know it
is the likely cause of a first-run failure.

### Edge Function timeouts

FASHN generation plus polling can take 20+ seconds. Supabase Edge Functions
have a wall-clock limit (currently 150s on paid plans, shorter on free). The
poll timeout in `fashn.ts` is 180s, which is *longer than the platform allows* —
if a generation is genuinely that slow, the function is killed first and the
credit is spent with nothing saved.

If you see that happen, the fix is to split the function: one call to submit and
store the prediction id, a second to poll and persist. The item row already has
a `prediction_id` column for exactly this.

### On-device CV performance

Segmentation and pose detection run in WASM on the phone. On a mid-range Android
device expect a few seconds each. That sits inside the 10–25s budget, but it is
the part most likely to feel slow, and it is worth measuring on your actual
phone before assuming it is fine.

### Seam blending is not Poisson

The Python version used OpenCV `seamlessClone`. There is no browser equivalent,
so seams are blended by gradient-weighted alpha feathering across the same band.
For narrow garment seams the difference is slight. If it proves visibly worse on
real garments, the honest fix is a WASM OpenCV build, not a bigger feather.

---

## Test the hard case early

**Layered garments are where alignment quality shows.** A single top or a dress
will composite cleanly almost regardless. A jacket over a t-shirt is where
per-generation pixel variance becomes visible.

Before building out bulk upload, process exactly three real items — a t-shirt, a
jacket, and trousers — and stack them. Look at the collar and the cuffs.

If alignment is not good enough:

1. `vision.js` uses a similarity transform (translate, rotate, uniform scale).
   This is deliberate — a full affine would let garments shear to force a
   landmark match, distorting the clothing itself. Try shoulder-width
   normalisation before reaching for a full affine.
2. Add the manual nudge slider. The plumbing already exists: `alignToMaster`
   returns offset, scale and rotation, `compositeToCanvas` applies a per-layer
   `nudge`, and `items.nudge` is in the schema. Only the UI control is missing.

## Android APK

The web app is the source of truth. Once it works in a mobile browser:

```bash
cd web
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Pink Wardrobe" com.pinkwardrobe.app --web-dir=dist
npx cap add android
npm run build && npx cap sync android
npx cap open android
```

Camera capture uses a plain `<input type="file" capture>`, which Android WebView
handles natively — no Capacitor camera plugin needed.

The MediaPipe models are fetched by `npm run build` into `web/public/mediapipe/`
and bundled into the APK, so segmentation works offline. If that download fails,
the build fails loudly rather than shipping an app with no working pipeline.

## Account recovery is deliberately absent

Usernames map to synthetic, undeliverable addresses, so there is no
password-reset email. For two users this is a reasonable trade. If it ever needs
to change, the options are a recovery code issued at signup, or an optional real
email stored on the profile purely for reset.
