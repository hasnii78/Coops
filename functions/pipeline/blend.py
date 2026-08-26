"""Layer compositing and Poisson seam blending.

The client stacks layers on a Canvas for an instant preview. That preview is
correct in position but reads as "pasted" where layers meet — a hard line at a
collar, a cuff, a waistband.

This module produces the refined version: the same stack, with the seam regions
Poisson-blended so gradients carry across the boundary. It is pure image
processing, costs no AI credits, and its output is cached by item-set hash so
each unique outfit is blended at most once.
"""

from __future__ import annotations

import hashlib
import io
import logging

import cv2
import numpy as np
from PIL import Image

log = logging.getLogger(__name__)

# Strict stacking order. Lower index paints first (further from the viewer).
Z_ORDER = [
    "bottoms",
    "dresses",
    "swimwear",
    "gym_wear",
    "tops",
    "outerwear",
    "shoes",
    "accessories",
    "undergarments",
]

# How wide a band around each layer boundary gets blended, in pixels.
SEAM_BAND_PX = 12


def z_index(category: str) -> int:
    try:
        return Z_ORDER.index(category)
    except ValueError:
        return len(Z_ORDER)


def combo_hash(item_ids: list[str]) -> str:
    """Stable identifier for a set of items, order-independent.

    Used as the cache key so re-opening a previously built outfit serves the
    saved composite instead of recomputing it.
    """
    joined = "|".join(sorted(item_ids))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:32]


def _to_rgba(image_bytes: bytes) -> np.ndarray:
    return np.array(Image.open(io.BytesIO(image_bytes)).convert("RGBA"))


def _alpha_over(base: np.ndarray, layer: np.ndarray) -> np.ndarray:
    """Standard source-over alpha composite, in float space to avoid banding."""
    base_f = base.astype(np.float32) / 255.0
    layer_f = layer.astype(np.float32) / 255.0

    base_alpha = base_f[..., 3:4]
    layer_alpha = layer_f[..., 3:4]

    out_alpha = layer_alpha + base_alpha * (1.0 - layer_alpha)
    # Guard against divide-by-zero in fully transparent regions.
    safe_alpha = np.where(out_alpha > 1e-6, out_alpha, 1.0)

    out_rgb = (
        layer_f[..., :3] * layer_alpha
        + base_f[..., :3] * base_alpha * (1.0 - layer_alpha)
    ) / safe_alpha

    result = np.concatenate([out_rgb, out_alpha], axis=-1)
    return (np.clip(result, 0.0, 1.0) * 255.0).astype(np.uint8)


def _seam_mask(lower_alpha: np.ndarray, upper_alpha: np.ndarray) -> np.ndarray:
    """Isolate the band where an upper layer's edge sits over a lower layer.

    That band — and only that band — is what needs blending. Poisson-blending
    an entire garment would wash its colour toward the background.
    """
    upper_binary = (upper_alpha > 8).astype(np.uint8)
    lower_binary = (lower_alpha > 8).astype(np.uint8)

    kernel = np.ones((3, 3), np.uint8)
    dilated = cv2.dilate(upper_binary, kernel, iterations=SEAM_BAND_PX // 3)
    eroded = cv2.erode(upper_binary, kernel, iterations=SEAM_BAND_PX // 3)

    # The boundary ring of the upper layer...
    ring = cv2.subtract(dilated, eroded)
    # ...restricted to where something exists underneath to blend into.
    return cv2.bitwise_and(ring, lower_binary) * 255


def composite(
    base_avatar: bytes,
    layers: list[tuple[str, bytes]],
    *,
    blend_seams: bool = True,
) -> bytes:
    """Stack layers onto the avatar in z-order and blend the seams.

    `layers` is a list of (category, aligned_layer_png). Order in the list is
    irrelevant — z-order is enforced here so the caller cannot get it wrong.
    """
    canvas = _to_rgba(base_avatar)
    height, width = canvas.shape[:2]

    ordered = sorted(layers, key=lambda item: z_index(item[0]))

    for category, layer_bytes in ordered:
        layer = _to_rgba(layer_bytes)

        if layer.shape[:2] != (height, width):
            layer = cv2.resize(layer, (width, height), interpolation=cv2.INTER_LANCZOS4)

        previous_alpha = canvas[..., 3].copy()
        stacked = _alpha_over(canvas, layer)

        if blend_seams:
            try:
                stacked = _blend_seam(canvas, stacked, previous_alpha, layer[..., 3])
            except cv2.error as exc:
                # seamlessClone throws if the mask touches the image border or
                # is empty. A hard-edged composite is a far better outcome than
                # a failed request, so we keep going.
                log.warning("Seam blend skipped for %s: %s", category, exc)

        canvas = stacked

    buffer = io.BytesIO()
    Image.fromarray(canvas, mode="RGBA").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _blend_seam(
    before: np.ndarray,
    after: np.ndarray,
    lower_alpha: np.ndarray,
    upper_alpha: np.ndarray,
) -> np.ndarray:
    """Poisson-blend the seam band between the pre- and post-stack images."""
    mask = _seam_mask(lower_alpha, upper_alpha)

    if not mask.any():
        return after

    # seamlessClone requires the mask to sit strictly inside the image, and
    # operates on 3-channel data.
    mask[:2, :] = 0
    mask[-2:, :] = 0
    mask[:, :2] = 0
    mask[:, -2:] = 0

    if not mask.any():
        return after

    ys, xs = np.nonzero(mask)
    center = (int((xs.min() + xs.max()) // 2), int((ys.min() + ys.max()) // 2))

    blended_rgb = cv2.seamlessClone(
        after[..., :3],
        before[..., :3],
        mask,
        center,
        cv2.NORMAL_CLONE,
    )

    result = after.copy()
    # Only overwrite RGB inside the seam band; alpha and everything outside the
    # band stay exactly as the straight composite produced them.
    band = mask > 0
    result[band, :3] = blended_rgb[band]
    return result
