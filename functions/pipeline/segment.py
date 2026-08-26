"""Garment segmentation via rembg.

Takes the FASHN output (avatar wearing the garment) and cuts out just the
garment as a transparent PNG, so it can be stacked as a reusable layer.
"""

from __future__ import annotations

import io
import logging

import numpy as np
from PIL import Image

log = logging.getLogger(__name__)

# rembg is imported lazily. Importing it pulls onnxruntime and, on first use,
# downloads the u2net weights (~176MB). Keeping it out of module import means
# functions that never segment don't pay the cold-start cost.
_session = None


def _get_session():
    global _session
    if _session is None:
        from rembg import new_session

        # u2net_human_seg is trained specifically on people and gives much
        # cleaner edges around hair and hands than the general u2net model.
        _session = new_session("u2net_human_seg")
    return _session


def remove_background(image_bytes: bytes) -> bytes:
    """Return a transparent PNG of the subject with the background removed."""
    from rembg import remove

    output = remove(
        image_bytes,
        session=_get_session(),
        # Alpha matting dramatically improves soft edges (knitwear, hair,
        # chiffon) at the cost of a few seconds. Since this runs exactly once
        # per garment, quality is worth far more than speed here.
        alpha_matting=True,
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=8,
    )
    return output


def isolate_garment_region(
    person_png: bytes,
    category: str,
    *,
    feather_px: int = 3,
) -> bytes:
    """Crop the background-free person down to the region a garment occupies.

    rembg gives us the whole person. For a top we only want the torso pixels,
    otherwise stacking a top over a dress would also paste the model's legs
    back over the dress.

    The bands below are fractions of body height derived from the pose
    landmarks in align.py where available; these constants are the fallback
    when landmarks are missing. They are deliberately generous — trimming too
    aggressively clips sleeves and hems, which is far more visible than
    carrying a few extra transparent pixels.
    """
    image = Image.open(io.BytesIO(person_png)).convert("RGBA")
    width, height = image.size

    bands: dict[str, tuple[float, float]] = {
        "tops": (0.05, 0.62),
        "outerwear": (0.03, 0.72),
        "gym_wear": (0.05, 0.70),
        "bottoms": (0.42, 0.95),
        "dresses": (0.05, 0.92),
        "swimwear": (0.10, 0.80),
        "shoes": (0.86, 1.00),
        "accessories": (0.00, 1.00),
        "undergarments": (0.20, 0.70),
    }

    top_frac, bottom_frac = bands.get(category, (0.0, 1.0))
    top_px = int(height * top_frac)
    bottom_px = int(height * bottom_frac)

    alpha = np.array(image.getchannel("A"), dtype=np.float32)
    mask = np.zeros_like(alpha)
    mask[top_px:bottom_px, :] = 1.0

    # Feather the horizontal cut lines so the layer boundary doesn't read as a
    # hard slice across the body.
    if feather_px > 0:
        for offset in range(feather_px):
            weight = (offset + 1) / (feather_px + 1)
            if top_px + offset < height:
                mask[top_px + offset, :] = weight
            if 0 <= bottom_px - offset - 1 < height:
                mask[bottom_px - offset - 1, :] = weight

    combined = (alpha * mask).astype(np.uint8)
    image.putalpha(Image.fromarray(combined, mode="L"))

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def trim_to_content(png_bytes: bytes) -> tuple[bytes, tuple[int, int, int, int]]:
    """Crop transparent margins away, returning the image and its bounding box.

    Storing trimmed layers plus their offset keeps files small, and the offset
    is what lets the client re-place the layer at exactly the right spot on the
    avatar without recomputing anything.
    """
    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    bbox = image.getbbox()

    if bbox is None:
        # Fully transparent — segmentation found nothing.
        return png_bytes, (0, 0, image.width, image.height)

    cropped = image.crop(bbox)
    buffer = io.BytesIO()
    cropped.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), bbox
