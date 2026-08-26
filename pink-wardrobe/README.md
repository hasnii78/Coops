# Pink Wardrobe

A private virtual wardrobe. Upload photos of clothes you actually own, and see
them on your own avatar before you get dressed.

## The one idea everything else follows from

AI generation is expensive. So it happens **exactly once per garment**.

```
Add an item  →  FASHN generates it on your avatar  →  cut out  →  align  →  saved layer
                        (costs a credit, once)                              ↓
Build an outfit  ←  stack saved layers  ←  ────────────────────────────────┘
                        (costs nothing, forever)
```

Adding an item takes 10–25 seconds and spends one credit. Every outfit built
from that point on is assembled from saved transparent layers: instant,
unlimited, free. A closet of 40 items costs 40 generations total, no matter how
many thousands of combinations you try.

If you take one thing from this README: **`process-garment` must never run
twice for the same item.** That is the whole cost model. It is guarded by an
idempotency check in `supabase/functions/process-garment/index.ts`.

## Stack

| Concern | Where it lives |
| --- | --- |
| App | React PWA (Vite), installable, wraps to APK via Capacitor |
| Auth | Supabase Auth |
| Data | Supabase Postgres, RLS on every table |
| Images | Supabase Storage, private buckets, signed URLs only |
| Paid pipeline | Supabase Edge Function (Deno) |
| Segmentation, pose, blending | On-device, MediaPipe WASM + Canvas |

## Layout

```
web/                          React PWA
  src/supabase.js             client + Edge Function invoker
  src/lib/auth.js             username-only auth
  src/lib/closet.js           data access + client half of the pipeline
  src/lib/vision.js           segmentation, pose alignment, colour
  src/lib/compositor.js       z-ordered stacking + seam blending
  src/screens/                the five tabs
  scripts/fetch-models.mjs    downloads MediaPipe assets at build time
supabase/
  migrations/                 schema, RLS policies, buckets
  functions/process-garment/  the ONLY paid call
  functions/signup/           username signup (needs service role)
  functions/purge-recycle-bin/
```

## Pipeline, step by step

**Once per user.** An avatar photo is quality-checked on-device (lighting,
sharpness, full-body, facing camera) and its pose landmarks are stored. This
becomes the permanent master template. Every layer is aligned to it forever,
which is why the check is strict — a bad avatar can only be fixed by
regenerating the whole closet.

**Once per garment.** Steps 1–3 run in the `process-garment` Edge Function,
because they need the FASHN key:

1. Content boundary check — before any spend.
2. FASHN generates the avatar wearing the garment.
3. **Download and save immediately.** FASHN output URLs expire. Miss this and
   the credit is spent for nothing.

Steps 4–6 run on the device, because Edge Functions are Deno and cannot host
`rembg` or MediaPipe-Python. They are free and safely retryable from the file
saved in step 3:

4. MediaPipe segments the clothing class out to a transparent PNG.
5. Pose landmarks are detected on the generation and the cutout is warped so
   shoulders and hips land exactly where the master's do.
6. The aligned layer is saved and linked to the item.

**Every outfit after that** — free, on-device, instant:

7. Layers stack onto the avatar in strict z-order.
8. Seams at collars, cuffs and waistbands are blended so the composite doesn't
   read as pasted together.
9. The result is cached by item-set hash, so any given outfit is rendered once.

## Security posture

- **RLS on every table**, every policy keyed to `auth.uid()`.
- **No public URLs.** Both Storage buckets are private; images are served via
  short-lived signed URLs.
- **No user directory.** Username uniqueness is a `UNIQUE` constraint, not a
  readable table. There is nothing anyone can query to enumerate users.
- The **service role key** and **FASHN key** exist only in Edge Function
  secrets. Only the anon key reaches the client, which is what it is for.
- Sign-in failures are deliberately vague, so login can't be used to probe
  which usernames exist.
- Weather uses coordinates rounded to ~1km. Precise GPS is never sent or stored.

## Getting started

```bash
cp .env.example web/.env.local     # fill in URL + anon key
cd web && npm install && npm run dev
```

**Setting up for the first time?** Follow
[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) start to finish — it covers the
database, the Edge Functions and the APK build in the order they need doing.

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers the known risks and what has
and has not been verified. Read it before your first real garment.

## Status

Built: username auth, RLS schema, avatar lock, closet CRUD, the full pipeline,
combo builder with seam blending, save/like/wear/pin, remix, search and filter,
empty states, colour engine, weather suggestions, surprise me, stale-item
nudge, recycle bin, themes, text sizing, dark mode.

Removed by request: chat, send-to-username, push notifications, user directory.

Not yet verified against live services — see the "Verify first" table in
DEPLOYMENT.md before trusting anything.
