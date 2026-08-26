# Deployment

## Verify first

The build environment had no Firebase project and no FASHN key, so parts of
this are written-and-reviewed rather than run-and-observed. Be honest with
yourself about which is which before trusting anything below.

| Area | State |
| --- | --- |
| Web app builds (`npm run build`) | Verified — builds clean |
| Python modules parse | Verified |
| Security rules | Written, **not** exercised against the emulator |
| FASHN request shape | **Unverified** — see below |
| rembg / MediaPipe in Cloud Functions | **Unverified** — see risks |
| End-to-end pipeline | **Never run** |

### The FASHN contract is the first thing to check

`docs.fashn.ai` was blocked by the build environment's network egress, so
`functions/pipeline/fashn.py` was written against the contract recoverable from
search results: `POST /v1/run`, poll `GET /v1/status/{id}`, response
`{id, status, output[], error}`.

Confirm these against the live docs before spending real credits:

- Is the top-level field `model_name`, with inputs nested under `inputs`?
- Are the image keys `model_image` and `garment_image`?
- Are the `category` values `tops` / `bottoms` / `one-pieces`?
- **Are base64 data URIs accepted for images?**

That last one is load-bearing. The client inlines images as data URIs
specifically so your photos never need a public URL. If FASHN accepts only
fetchable URLs, that is a real design change — you would need short-lived
signed URLs, which weakens the privacy model. Decide deliberately; don't let it
happen by accident.

Everything FASHN-related is confined to that one file, so corrections are local.

## Order of operations

```bash
# 1. Rules FIRST, before any real photo exists.
firebase deploy --only firestore:rules,storage:rules

# 2. The FASHN key. Typed locally; never in git, never in the bundle.
firebase functions:secrets:set FASHN_API_KEY

# 3. Functions.
firebase deploy --only functions

# 4. Web.
cp .env.example web/.env.local     # fill from Firebase console
cd web && npm install && npm run build
firebase deploy --only hosting
```

Also update the placeholder config in `web/public/firebase-messaging-sw.js` —
it cannot read Vite env vars, so its values are hardcoded. Push notifications
silently do nothing until it is filled in.

## Known deployment risks

These are the parts most likely to fight you. None are reasons not to proceed;
all are reasons not to be surprised.

### 1. The CV dependency bundle is large

`rembg` (via onnxruntime), `mediapipe` and `opencv` together land around
700MB–1GB unpacked. Gen-2 functions build on Cloud Run and can carry it, but:

- The first deploy is slow. Expect 10–15 minutes.
- Functions are set to 2GB memory in `main.py`. Below that, alpha matting OOMs.
- If the build fails on image size, drop `alpha_matting=True` in `segment.py`
  first — it is the most expensive quality setting and the cheapest to trade.

### 2. rembg downloads its model at first use

`u2net_human_seg` is ~176MB, fetched to `~/.u2net` on first call. On a cold
container that is a slow first request and a repeated download.

Two options, in order of preference:

1. **Bake the model into the image** — download it at build time and set
   `U2NET_HOME` to a path inside the deployment.
2. **Keep one instance warm** — set `min_instances=1` on `process_garment`.
   Costs a few dollars a month; removes the problem entirely.

For two users, option 2 is probably the better trade.

### 3. Cold starts are slow regardless

Importing mediapipe and onnxruntime takes several seconds. Both are imported
lazily (inside functions, not at module scope) so unrelated functions don't pay
for it — but the first garment after an idle period will feel slow. This is
inside the 10–25s budget, so it is a comfort issue, not a correctness one.

### 4. Firestore needs to exist before rules deploy

Create the database in the console first, in Native mode. `firebase deploy`
does not create it for you and the error message is not obvious.

## Test the hard case early

The brief flags this and it is right: **layered garments are where alignment
quality shows.** A single top or a dress will composite cleanly almost
regardless. A jacket over a t-shirt is where per-generation pixel variance
becomes visible.

Before building out any bulk upload flow, process exactly three real items — a
t-shirt, a jacket, and a pair of trousers — and stack them. Look at the collar
and the cuffs.

If alignment is not good enough:

1. `align.py` currently uses a partial affine (translate, rotate, uniform
   scale). This is deliberate — a full affine would let garments shear to force
   a landmark match, distorting the clothing itself. Try adding shoulder-width
   normalisation before reaching for a full affine.
2. Add the manual nudge slider. The plumbing already exists: `align_to_master`
   returns offset, scale and rotation, `compositeToCanvas` already applies a
   per-layer `nudge`, and items carry a `nudge` field. Only the UI control is
   missing.

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

Camera capture uses a plain `<input type="file" capture>`, which Android
WebView handles natively — no Capacitor camera plugin needed.

## Account recovery is deliberately absent

Usernames map to synthetic, undeliverable addresses
(`{username}@pinkwardrobe.internal`), so there is no password-reset email. For
two users this is a reasonable trade. If it ever needs to change, the options
are a recovery code issued at signup, or an optional real email stored on the
user document purely for reset.
