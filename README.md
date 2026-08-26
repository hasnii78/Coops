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

Adding an item takes 10–25 seconds and spends one credit. Every outfit you
build from that point on is assembled from saved transparent layers: instant,
unlimited, free. A closet of 40 items costs 40 generations total, no matter how
many thousands of combinations you try.

If you take one thing from this README: **`process_garment` must never run
twice for the same item.** That is the whole cost model. It is guarded by an
idempotency check in `functions/main.py`.

## Layout

```
web/                    React PWA (Vite). Installable; wraps to APK via Capacitor.
  src/lib/              Auth, pipeline calls, Canvas compositing, suggestions.
  src/screens/          The six tabs.
functions/              Python Cloud Functions (2nd gen).
  pipeline/fashn.py     The ONLY paid call in the codebase.
  pipeline/segment.py   rembg cutout.
  pipeline/align.py     MediaPipe landmark alignment.
  pipeline/blend.py     Poisson seam blending + z-order stacking.
  pipeline/colors.py    Dominant colour + colour-theory scoring.
firestore.rules         Owner-only, deny by default.
storage.rules           No public URLs anywhere.
```

## Pipeline, step by step

**Once per user.** An avatar photo is quality-checked (lighting, sharpness,
full-body, facing camera) and its pose landmarks are stored. This becomes the
permanent master template. Every layer is aligned to it forever, which is why
the check is strict — a bad avatar can only be fixed by regenerating the whole
closet.

**Once per garment** (`process_garment`):

1. Content boundary check — before any spend.
2. FASHN generates the avatar wearing the garment.
3. **Download and save immediately.** FASHN output URLs expire. Miss this and
   the credit is spent for nothing. Everything after this step is free and
   safely retryable from the saved file.
4. `rembg` cuts the garment out to a transparent PNG.
5. MediaPipe detects landmarks; the cutout is warped so shoulders and hips land
   exactly where the master's do.
6. The aligned layer is saved and linked to the item.

**Every outfit after that** — free, twice over:

7. The client stacks layers on a Canvas in strict z-order. This is the instant
   preview, well under the 2-second target.
8. `build_outfit` returns a Poisson-blended version so seams at collars, cuffs
   and waistbands don't read as pasted. Cached by item-set hash, so any given
   outfit is blended at most once.

## Security posture

- Everything is owner-only. Firestore and Storage both deny by default.
- **No public URLs.** Every image read is authenticated.
- The `usernames` collection is the single public-read exception. It contains
  `{username, uid}` and nothing else, so users can find each other.
- Chat is readable only by the two participants.
- Sign-in failures are deliberately vague, so the public username directory
  can't be used to probe which accounts exist.
- Weather uses coordinates rounded to ~1km. Precise GPS is never sent or stored.

## Getting started

```bash
cp .env.example web/.env.local     # fill in from the Firebase console
cd web && npm install && npm run dev
```

Deploy steps, the FASHN key, and the known deployment risks are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Read the risks section before your
first deploy — the CV dependencies are the fiddly part.

## Status

Phase 1 is built: auth, security rules, avatar lock, closet CRUD, the full
pipeline, the combo builder, save/like/wear, search and filter, empty states.
Phase 2 is partly in place — colour engine, weather, surprise me, stale-item
nudge, chat, push, send-to. Phase 3 is mostly not started.

See the "Verify first" section of DEPLOYMENT.md for what has and has not been
tested against live services.
