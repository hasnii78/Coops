"""Dominant colour extraction and colour-theory scoring.

Powers "Surprise me" and outfit suggestions. Entirely rule-based — no AI cost.
"""

from __future__ import annotations

import colorsys
import io

import cv2
import numpy as np
from PIL import Image


def dominant_color(image_bytes: bytes, *, clusters: int = 4) -> dict:
    """Extract the dominant colour of a garment layer.

    Only opaque pixels are sampled, so the transparent surround of a cutout
    can't drag the result toward black.
    """
    image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    array = np.array(image)

    opaque = array[array[..., 3] > 200][:, :3]
    if opaque.size == 0:
        return {"hex": "#CCCCCC", "hue": 0, "saturation": 0, "lightness": 80, "name": "unknown"}

    # Subsample for speed; colour distribution is stable well under 20k pixels.
    if len(opaque) > 20000:
        indices = np.random.default_rng(42).choice(len(opaque), 20000, replace=False)
        opaque = opaque[indices]

    samples = opaque.astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _compactness, labels, centers = cv2.kmeans(
        samples, clusters, None, criteria, 5, cv2.KMEANS_PP_CENTERS
    )

    counts = np.bincount(labels.flatten(), minlength=clusters)
    r, g, b = centers[np.argmax(counts)].astype(int)

    h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    return {
        "hex": f"#{r:02X}{g:02X}{b:02X}",
        "hue": round(h * 360),
        "saturation": round(s * 100),
        "lightness": round(l * 100),
        "name": color_name(h * 360, s * 100, l * 100),
    }


def color_name(hue: float, saturation: float, lightness: float) -> str:
    if lightness < 12:
        return "black"
    if lightness > 90 and saturation < 12:
        return "white"
    if saturation < 12:
        return "grey"
    if saturation < 30 and 20 < hue < 50:
        return "beige"

    bands = [
        (15, "red"), (45, "orange"), (65, "yellow"), (160, "green"),
        (200, "teal"), (250, "blue"), (290, "purple"), (335, "pink"), (360, "red"),
    ]
    for ceiling, name in bands:
        if hue < ceiling:
            return name
    return "red"


def harmony_score(hue_a: float, hue_b: float) -> float:
    """Score two hues against classical colour-theory relationships (0-1)."""
    delta = abs(hue_a - hue_b) % 360
    delta = min(delta, 360 - delta)

    if delta < 20:
        return 0.85   # monochromatic
    if delta < 50:
        return 0.95   # analogous — the most reliably flattering
    if 150 < delta < 210:
        return 0.90   # complementary
    if 100 < delta < 140:
        return 0.75   # triadic-ish
    return 0.45       # discordant


def flatters_undertone(color: dict, undertone: str) -> float:
    """Score a colour against the user's skin undertone (0-1)."""
    hue = color["hue"]
    saturation = color["saturation"]

    if color["name"] in ("black", "white", "grey", "beige"):
        return 0.8  # neutrals work broadly

    warm_range = hue < 60 or hue > 330
    cool_range = 160 < hue < 290

    if undertone == "warm":
        base = 0.9 if warm_range else (0.5 if cool_range else 0.7)
    elif undertone == "cool":
        base = 0.9 if cool_range else (0.5 if warm_range else 0.7)
    else:
        base = 0.8

    # Very washed-out colours flatter almost nobody.
    if saturation < 15:
        base -= 0.1

    return max(0.0, min(1.0, base))
