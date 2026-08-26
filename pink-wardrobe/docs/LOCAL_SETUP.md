# Local setup

The supported route: deploy the backend with the Supabase CLI, build the APK in
Android Studio. Nothing is stored in GitHub, and you see every step.

Do it in this order. Section 2 must happen before any real photo exists.

---

## 1. Install the toolchain

| Tool | Why | Get it |
| --- | --- | --- |
| **Node.js 20+** | builds the web app, runs the CLI | nodejs.org |
| **Android Studio** | builds the APK | developer.android.com/studio |
| **JDK 17** | Gradle needs it | bundled with Android Studio |

Check Node:

```bash
node --version    # v20 or higher
```

The Supabase CLI is run through `npx`, so there is nothing to install for it —
and no global package to go stale.

```bash
npx supabase --version
```

> Do not `npm install -g supabase`. Supabase no longer supports global npm
> installs and it fails on most machines. `npx` is the current route.

---

## 2. Set up the database

Clone and enter the project:

```bash
git clone https://github.com/hasnii78/Coops
cd Coops/pink-wardrobe
```

Log in and link. `<ref>` is the `xxxx` from your `xxxx.supabase.co` URL:

```bash
npx supabase login          # opens a browser
npx supabase link --project-ref <ref>
```

Apply the schema:

```bash
npx supabase db push
```

This creates the tables, **enables RLS on every one of them**, adds the
policies, and creates both private Storage buckets.

Verify before continuing — this is the step worth checking rather than trusting:

```bash
npx supabase db execute --query \
  "select tablename, rowsecurity from pg_tables where schemaname='public';"
```

Every row must show `rowsecurity = t`. If any says `f`, stop and fix it: that
table is readable by anyone with your anon key, which ships in the app.

---

## 3. Configure the dashboard

Three things the CLI cannot do for you.

**Turn off public signup.** Authentication → Providers → Email. Leave the
provider **enabled** (it backs password login), set **Enable signup** to
**off**. Accounts are created only through the `signup` function, which enforces
the username rules; leaving the public endpoint open bypasses that entirely.

**Add the secrets.** Edge Functions → Secrets:

| Name | Value |
| --- | --- |
| `FASHN_API_KEY` | your FASHN key — already done |
| `PURGE_SECRET` | any long random string you invent |

**Schedule the purge.** Database → Extensions: enable `pg_cron` and `pg_net`.
Then in SQL Editor, substituting your ref and secret:

```sql
select cron.schedule(
  'purge-recycle-bin',
  '0 3 * * *',
  $$
  select net.http_post(
    url     := 'https://<ref>.supabase.co/functions/v1/purge-recycle-bin',
    headers := '{"x-purge-secret": "<your PURGE_SECRET>"}'::jsonb
  );
  $$
);
```

Without this, deleted items are never really deleted and their images cost you
storage forever.

---

## 4. Deploy the Edge Functions

The JWT flags matter and differ per function. Copy these exactly:

```bash
# Must be callable before the user has a session.
npx supabase functions deploy signup --no-verify-jwt

# Authenticated by its own header, not a user session.
npx supabase functions deploy purge-recycle-bin --no-verify-jwt

# Spends money — always requires a real session.
npx supabase functions deploy process-garment
```

Getting the last one wrong is the expensive mistake: deployed with
`--no-verify-jwt`, anyone who finds the URL can spend your FASHN credits.

Confirm what landed:

```bash
npx supabase functions list
```

---

## 5. Run the web app

```bash
cp ../.env.example web/.env.local
```

Fill in from Project Settings → API:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
```

Then:

```bash
cd web
npm install
npm run dev
```

Open the printed URL. Create an account, upload an avatar, add one garment.

**Get this working in the browser before touching Android Studio.** Every bug
you find here is far easier to diagnose than the same bug inside a WebView.

---

## 6. Build the APK

Only once the web app works.

```bash
cd web
npm run build          # fetches models, builds, checks for leaked secrets
npx cap add android    # first time only
npx cap sync android
npx cap open android   # launches Android Studio
```

In Android Studio: wait for Gradle to finish indexing (slow the first time,
several minutes), then **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

The APK lands at:

```
web/android/app/build/outputs/apk/debug/app-debug.apk
```

Copy it to your phone and open it to install. Android warns about unknown
sources; that is expected for a private app.

### After any code change

```bash
npm run build && npx cap sync android
```

Then rebuild in Android Studio. Skipping `cap sync` is the classic mistake —
the APK silently keeps the old web assets and you debug a change that was never
installed.

---

## Things that will bite

**`npx cap add android` fails.** Usually the Android SDK is not where Capacitor
expects. Open Android Studio → SDK Manager, install **Android SDK Platform 34**
and **Android SDK Build-Tools**, then retry.

**Gradle fails on the Java version.** Android Studio → Settings → Build →
Gradle → set Gradle JDK to **17**. Newer JDKs break the Capacitor Gradle plugin.

**The app loads but every request fails.** Almost always `web/.env.local` was
missing or wrong at `npm run build` time. The values are compiled in, so editing
the file afterwards changes nothing until you rebuild and re-sync.

**A new APK will not install over the old one.** Debug builds are signed with a
local key. If the key changes, Android refuses the upgrade — uninstall the old
app first.

**"Garment generation is not configured."** `FASHN_API_KEY` is missing or
misnamed in Edge Function secrets. Names are case-sensitive.

---

## The GitHub workflows

`.github/workflows/` still contains a Supabase deploy and an APK build. They are
**manual-dispatch only** and never run on their own, so they cannot fail in the
background. They are there if you ever want them; delete both files if you
would rather they weren't.
