# Pink Wardrobe

A private virtual wardrobe for two people. Photograph a garment once, pay one
FASHN credit to render it onto your avatar once, and every outfit after that is
assembled from saved transparent layers at no cost. That cost model is the point
of the app, and it constrains almost every decision in it.

## Hard rule: ask the database, do not infer it

Never conclude anything about the live schema, the auth settings or a user's
data from reading code or from a screenshot. Ask the database.

This container cannot reach Supabase — the egress proxy blocks it — but the
GitHub Actions runner can, which is what `.github/workflows/doctor.yml` exists
for. It checks auth configuration, probes the endpoints the app calls, verifies
that each migration's columns exist, and runs a real end-to-end sign-up. Run it
and read the log rather than reasoning about what is probably there.

    gh workflow run doctor.yml        # or the MCP equivalent

Two bugs in this project's history came from inferring instead of asking: a
"trailing slash" diagnosis that was wrong for a day, and a migration assumed
applied that was not. Both were settled in one Doctor run once it existed.

When a check is missing, add it to the Doctor rather than reasoning around the
gap. It is cheap and it accumulates.

## Verify before shipping

The APK takes ten minutes to build and someone has to install it by hand, so a
speculative fix is expensive. Before building:

- `npm test` — the mask maths, in plain node, no browser
- `npm run test:browser` — stacking order, read back from real composited pixels
- `npm run build` — includes a scan for server secrets in the bundle

Where a bug is visual, write the failing case as a test with the actual numbers
from it. `test/mask.test.mjs` asserts, among other things, that colour alone
cannot tell a white shirt from a cream base — the bug itself, written down, so
it cannot come back quietly.

## Shape of it

    web/src/lib/mask.js       pure pixel work: arrays in, arrays out, testable
    web/src/lib/vision.js     MediaPipe: segmentation, pose, alignment
    web/src/lib/compositor.js stacking saved layers onto the avatar
    web/src/lib/closet.js     the pipeline, and everything that talks to Supabase
    supabase/functions/       the paid step, and only the paid step

Keep pure work in `mask.js`. Anything that needs a model or the DOM belongs in
`vision.js`. The split is what makes the segmentation testable at all.

## Migrations are applied by hand

There is no database password in CI, so every migration is pasted into the
Supabase SQL Editor by the user. Say so explicitly when you add one, quote the
SQL in full, and add its columns to the Doctor's schema check so the next run
proves whether it landed.
