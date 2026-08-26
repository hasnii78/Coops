"""Pose-landmark alignment.

Every garment layer for a user is generated in a separate FASHN call. Even
with an identical avatar input, the model introduces a few pixels of natural
variance in where the body sits. Stack three such layers unaligned and the
composite visibly shears — a collar floating off a neck, a waistband cutting
across a hip.

This module locks every layer to the user's master template by detecting body
landmarks on the generated image and warping the cutout so those landmarks land
exactly where the master's do.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

log = logging.getLogger(__name__)

# MediaPipe Pose landmark indices we anchor on. Shoulders and hips are the
# most stable points across garment changes — wrists and ankles move too much
# with sleeve and hem variation to be reliable anchors.
ANCHOR_LANDMARKS = {
    "left_shoulder": 11,
    "right_shoulder": 12,
    "left_hip": 23,
    "right_hip": 24,
}

# Below this visibility score MediaPipe is essentially guessing.
MIN_VISIBILITY = 0.5

_pose = None


def _get_pose():
    global _pose
    if _pose is None:
        import mediapipe as mp

        _pose = mp.solutions.pose.Pose(
            static_image_mode=True,
            model_complexity=2,  # highest accuracy; runs once per garment
            enable_segmentation=False,
            min_detection_confidence=0.5,
        )
    return _pose


@dataclass(frozen=True)
class PoseLandmarks:
    """Anchor landmark positions in absolute pixel coordinates."""

    points: dict[str, tuple[float, float]]
    width: int
    height: int

    def as_array(self, names: list[str]) -> np.ndarray:
        return np.array([self.points[name] for name in names], dtype=np.float32)

    @property
    def is_usable(self) -> bool:
        return len(self.points) >= 3

    def to_dict(self) -> dict:
        return {
            "points": {k: list(v) for k, v in self.points.items()},
            "width": self.width,
            "height": self.height,
        }

    @staticmethod
    def from_dict(data: dict) -> "PoseLandmarks":
        return PoseLandmarks(
            points={k: tuple(v) for k, v in data["points"].items()},
            width=data["width"],
            height=data["height"],
        )


class AlignmentError(RuntimeError):
    """Raised when landmarks cannot be established well enough to align."""


def detect_landmarks(image_bytes: bytes) -> PoseLandmarks:
    """Run MediaPipe Pose and return anchor landmarks in pixel space."""
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    width, height = image.size
    array = np.array(image)

    result = _get_pose().process(array)

    if not result.pose_landmarks:
        raise AlignmentError("No person detected in the image.")

    points: dict[str, tuple[float, float]] = {}
    for name, index in ANCHOR_LANDMARKS.items():
        landmark = result.pose_landmarks.landmark[index]
        if landmark.visibility < MIN_VISIBILITY:
            continue
        # MediaPipe returns normalised coordinates; convert to pixels.
        points[name] = (landmark.x * width, landmark.y * height)

    return PoseLandmarks(points=points, width=width, height=height)


def check_avatar_quality(image_bytes: bytes) -> tuple[bool, list[str]]:
    """Validate a candidate avatar photo before it becomes the master template.

    This photo is permanent — every layer the user ever generates is aligned to
    it. A bad avatar poisons the entire closet, so the bar here is deliberately
    high and the failure messages are specific enough to act on.
    """
    problems: list[str] = []

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    width, height = image.size
    array = np.array(image)

    if min(width, height) < 512:
        problems.append("Photo is too small — use at least 512px on the short side.")

    # Brightness and contrast: a very dark or flat photo segments badly.
    grey = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
    mean_brightness = float(grey.mean())
    contrast = float(grey.std())

    if mean_brightness < 55:
        problems.append("Photo is too dark — try again near a window or in brighter light.")
    elif mean_brightness > 215:
        problems.append("Photo is overexposed — move out of direct light.")

    if contrast < 25:
        problems.append("Lighting is very flat — stand against a simpler, contrasting background.")

    # Blur detection via variance of Laplacian.
    sharpness = float(cv2.Laplacian(grey, cv2.CV_64F).var())
    if sharpness < 60:
        problems.append("Photo looks blurry — hold the camera steady and retake.")

    # Pose: we need a clear, full-body, front-facing subject.
    try:
        landmarks = detect_landmarks(image_bytes)
    except AlignmentError:
        problems.append("No clear full-body person detected — stand back so your whole body is in frame.")
        return False, problems

    if not landmarks.is_usable:
        problems.append("Body isn't fully visible — make sure shoulders and hips are both in frame.")
        return False, problems

    if "left_shoulder" in landmarks.points and "right_shoulder" in landmarks.points:
        shoulder_span = abs(
            landmarks.points["left_shoulder"][0] - landmarks.points["right_shoulder"][0]
        )
        # A near-zero span means the subject is in profile, which try-on
        # models handle poorly.
        if shoulder_span < width * 0.08:
            problems.append("You're turned side-on — face the camera straight for the best results.")

    return len(problems) == 0, problems


def compute_transform(
    source: PoseLandmarks,
    target: PoseLandmarks,
) -> np.ndarray:
    """Compute the 2x3 similarity transform mapping source pose onto target.

    A partial affine (translation + rotation + uniform scale) is deliberate.
    A full affine or homography would let the garment shear or stretch to
    force a landmark match, distorting the clothing itself. We only want to
    slide, rotate and scale the layer into place.
    """
    shared = sorted(set(source.points) & set(target.points))

    if len(shared) < 2:
        raise AlignmentError(
            f"Only {len(shared)} shared landmark(s); need at least 2 to align."
        )

    source_points = source.as_array(shared)
    target_points = target.as_array(shared)

    matrix, _inliers = cv2.estimateAffinePartial2D(
        source_points,
        target_points,
        method=cv2.LMEDS,
        refineIters=20,
    )

    if matrix is None:
        raise AlignmentError("Could not derive a stable transform from landmarks.")

    return matrix


def warp_layer(
    layer_png: bytes,
    matrix: np.ndarray,
    output_size: tuple[int, int],
) -> bytes:
    """Apply a transform to a transparent layer, preserving its alpha channel."""
    image = Image.open(io.BytesIO(layer_png)).convert("RGBA")
    array = np.array(image)

    warped = cv2.warpAffine(
        array,
        matrix,
        output_size,
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )

    buffer = io.BytesIO()
    Image.fromarray(warped, mode="RGBA").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def align_to_master(
    *,
    layer_png: bytes,
    generation_bytes: bytes,
    master_landmarks: PoseLandmarks,
) -> tuple[bytes, dict]:
    """Align a segmented layer to the user's master template.

    `generation_bytes` is the full FASHN output the layer was cut from — pose
    is detected on that, not on the cutout, because a cropped garment has no
    detectable body.

    Returns the aligned layer and a metadata dict describing what was applied,
    which the UI surfaces if a user needs to nudge a layer manually.
    """
    try:
        generation_landmarks = detect_landmarks(generation_bytes)
        matrix = compute_transform(generation_landmarks, master_landmarks)
    except AlignmentError as exc:
        # Alignment failing is not fatal — an unaligned layer is still usable
        # for single-garment outfits and the user can nudge it by hand. Losing
        # the paid generation over a landmark miss would be much worse.
        log.warning("Alignment skipped: %s", exc)
        return layer_png, {
            "aligned": False,
            "reason": str(exc),
            "offsetX": 0,
            "offsetY": 0,
            "scale": 1.0,
            "rotationDeg": 0.0,
        }

    aligned = warp_layer(
        layer_png,
        matrix,
        (master_landmarks.width, master_landmarks.height),
    )

    # Decompose the matrix for display and for seeding the manual nudge slider.
    scale = float(np.sqrt(matrix[0, 0] ** 2 + matrix[1, 0] ** 2))
    rotation = float(np.degrees(np.arctan2(matrix[1, 0], matrix[0, 0])))

    return aligned, {
        "aligned": True,
        "offsetX": float(matrix[0, 2]),
        "offsetY": float(matrix[1, 2]),
        "scale": scale,
        "rotationDeg": rotation,
        "landmarksMatched": sorted(
            set(generation_landmarks.points) & set(master_landmarks.points)
        ),
    }
