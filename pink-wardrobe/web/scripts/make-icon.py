#!/usr/bin/env python3
"""
Build the Android icon and splash from resources/icon-source.png.

@capacitor/assets wants a 1024x1024 icon and a 2732x2732 splash; this produces
both. The icon is cropped around the figure rather than using the full frame:
the home-screen icon renders at roughly 48dp, and in the uncropped image the
subject occupies so little of the frame that she disappears at that size.

Run: python3 scripts/make-icon.py
"""

from pathlib import Path
from PIL import Image, ImageFilter

RESOURCES = Path(__file__).resolve().parent.parent / "resources"
SOURCE = RESOURCES / "icon-source.png"

# Fractions of the source frame to keep for the icon. Tuned to run from just
# above the head to just below the hem.
CROP_TOP = 0.22
CROP_BOTTOM = 0.88

ICON_PX = 1024
SPLASH_PX = 2732

# Splash background, sampled from the artwork's sky so the launch screen and
# the icon read as one thing.
SPLASH_BG = (238, 190, 205)


def build_icon(src: Image.Image) -> None:
    width, height = src.size

    top = int(height * CROP_TOP)
    bottom = int(height * CROP_BOTTOM)
    half = (bottom - top) // 2
    centre = width // 2

    cropped = src.crop((centre - half, top, centre + half, bottom))
    cropped.resize((ICON_PX, ICON_PX), Image.LANCZOS).save(
        RESOURCES / "icon.png", optimize=True
    )
    print(f"icon.png      {ICON_PX}x{ICON_PX}  (cropped {CROP_TOP:.0%}-{CROP_BOTTOM:.0%})")


def build_splash(src: Image.Image) -> None:
    """The splash uses the full frame, which has room to breathe at that size.

    The artwork is square and the splash canvas is square, but phones are not:
    Capacitor centre-crops it to the screen. Insetting the artwork and filling
    the surround means the edges of the composition survive on tall screens.
    """
    canvas = Image.new("RGB", (SPLASH_PX, SPLASH_PX), SPLASH_BG)

    art_px = int(SPLASH_PX * 0.62)
    art = src.resize((art_px, art_px), Image.LANCZOS)

    # A blurred, enlarged copy behind the artwork avoids a hard rectangle edge
    # against the flat background.
    backdrop = src.resize((SPLASH_PX, SPLASH_PX), Image.LANCZOS).filter(
        ImageFilter.GaussianBlur(120)
    )
    canvas.paste(backdrop, (0, 0))

    offset = (SPLASH_PX - art_px) // 2
    canvas.paste(art, (offset, offset))

    canvas.save(RESOURCES / "splash.png", optimize=True)
    print(f"splash.png    {SPLASH_PX}x{SPLASH_PX}")


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing {SOURCE}. Add the source artwork there first.")

    # The file is named .png but is actually a JPEG; Pillow sniffs the real
    # format from the header, so the extension does not matter.
    with Image.open(SOURCE) as handle:
        src = handle.convert("RGB")
        build_icon(src)
        build_splash(src)


if __name__ == "__main__":
    main()
