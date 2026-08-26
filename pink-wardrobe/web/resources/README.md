# App icon and splash sources

Drop two files here and the build turns them into every density Android needs.

| File | Size | Purpose |
| --- | --- | --- |
| `icon.png` | 1024×1024 | home-screen icon |
| `splash.png` | 2732×2732 | launch screen (optional) |

`@capacitor/assets` generates mdpi through xxxhdpi plus the adaptive
foreground/background layers from these. Do not hand-edit anything under
`android/app/src/main/res/` — it is regenerated on every build and your changes
would be silently overwritten.

## Designing for 48px

The home-screen icon renders at roughly 48dp. A detailed scene turns to mush at
that size — thin lines disappear, small figures become a smudge.

What survives: one bold shape, high contrast, filling most of the frame.

Android also masks icons into circles, squircles and rounded squares depending
on the launcher, so keep the subject centred with roughly 15% breathing room and
expect the corners to be cropped. Avoid transparency — some launchers render
transparent regions black.

If a source photo is busy, crop tight on the subject before dropping it here.
