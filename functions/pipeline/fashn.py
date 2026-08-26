"""FASHN.ai virtual try-on client.

This is the ONLY paid step in the entire application, and the only module that
talks to FASHN. Everything downstream operates on images we already own.

>>> VERIFY BEFORE FIRST PAID RUN <<<
The request field names below (`model_name`, `inputs.model_image`,
`inputs.garment_image`, `inputs.category`) follow FASHN's documented universal
`/v1/run` contract, but the docs were unreachable from the build environment.
Confirm them against https://docs.fashn.ai/api-reference and your dashboard
before spending real credits. They are deliberately confined to this file so a
correction is a single-file change.
"""

from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from typing import Literal

import requests

log = logging.getLogger(__name__)

API_BASE = "https://api.fashn.ai/v1"

# Try-On v1.6 is the cost-sensitive interactive endpoint (5-8s typical).
# "tryon-max" produces higher-fidelity output at higher cost; it is the better
# choice for us because each garment is generated exactly once and the result
# is reused forever, so quality compounds while cost does not.
DEFAULT_MODEL = "tryon-max"

# FASHN output URLs expire. We treat them as valid for minutes, not days —
# the pipeline downloads immediately and never relies on fetching them back.
POLL_INTERVAL_SECONDS = 2.0
POLL_TIMEOUT_SECONDS = 180.0

# Maps our closet categories onto FASHN's garment categories.
CATEGORY_MAP: dict[str, str] = {
    "tops": "tops",
    "bottoms": "bottoms",
    "dresses": "one-pieces",
    "outerwear": "tops",
    "swimwear": "one-pieces",
    "gym_wear": "tops",
    "shoes": "auto",
    "accessories": "auto",
    "undergarments": "auto",
}


class FashnError(RuntimeError):
    """Raised when FASHN rejects or fails a generation.

    Failed generations do not consume credits, so callers may safely retry.
    """

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass(frozen=True)
class TryOnResult:
    prediction_id: str
    image_bytes: bytes
    content_type: str


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def _to_data_uri(image_bytes: bytes, content_type: str = "image/jpeg") -> str:
    """FASHN accepts either a public URL or a base64 data URI.

    Our images are never public, so we always inline them. This also means no
    signed-URL plumbing and no window where a garment photo is world-readable.
    """
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def submit(
    *,
    api_key: str,
    avatar_bytes: bytes,
    garment_bytes: bytes,
    category: str,
    model_name: str = DEFAULT_MODEL,
    avatar_content_type: str = "image/jpeg",
    garment_content_type: str = "image/jpeg",
) -> str:
    """Submit a try-on job. Returns the prediction id to poll."""
    payload = {
        "model_name": model_name,
        "inputs": {
            "model_image": _to_data_uri(avatar_bytes, avatar_content_type),
            "garment_image": _to_data_uri(garment_bytes, garment_content_type),
            "category": CATEGORY_MAP.get(category, "auto"),
            # Deterministic output makes regeneration after a bug fix produce
            # a comparable image rather than a differently-posed one.
            "seed": 42,
            "num_samples": 1,
        },
    }

    try:
        response = requests.post(
            f"{API_BASE}/run",
            json=payload,
            headers=_headers(api_key),
            timeout=60,
        )
    except requests.RequestException as exc:
        raise FashnError(f"Could not reach FASHN: {exc}") from exc

    if response.status_code == 401:
        raise FashnError("FASHN rejected the API key.", retryable=False)
    if response.status_code == 402:
        raise FashnError("Out of FASHN credits.", retryable=False)
    if response.status_code == 429:
        raise FashnError("FASHN rate limit reached; try again shortly.")
    if not response.ok:
        raise FashnError(f"FASHN returned {response.status_code}: {response.text[:300]}")

    body = response.json()
    prediction_id = body.get("id")
    if not prediction_id:
        raise FashnError(f"FASHN response contained no prediction id: {body}")

    log.info("FASHN job submitted", extra={"prediction_id": prediction_id})
    return prediction_id


def wait_for_output_url(*, api_key: str, prediction_id: str) -> str:
    """Poll until the prediction completes; return the first output URL."""
    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        try:
            response = requests.get(
                f"{API_BASE}/status/{prediction_id}",
                headers=_headers(api_key),
                timeout=30,
            )
        except requests.RequestException as exc:
            raise FashnError(f"Could not poll FASHN: {exc}") from exc

        if not response.ok:
            raise FashnError(
                f"FASHN status check returned {response.status_code}: {response.text[:300]}"
            )

        body = response.json()
        status = body.get("status")

        if status == "completed":
            outputs = body.get("output") or []
            if not outputs:
                raise FashnError("FASHN reported completion with no output image.")
            return outputs[0]

        if status == "failed":
            # Failed generations are not billed, so this is safe to retry.
            raise FashnError(f"FASHN generation failed: {body.get('error')}")

        # starting / in_queue / processing
        time.sleep(POLL_INTERVAL_SECONDS)

    raise FashnError("FASHN generation timed out after 3 minutes.")


def download_output(url: str) -> tuple[bytes, str]:
    """Download a FASHN output image.

    CRITICAL: this must run immediately after generation. FASHN output URLs
    expire (documented at 3 days, but treat them as ephemeral). If the download
    is missed the layer is lost and the credit is spent for nothing — which
    breaks the whole generate-once cost model.
    """
    try:
        response = requests.get(url, timeout=120)
    except requests.RequestException as exc:
        raise FashnError(f"Could not download FASHN output: {exc}") from exc

    if not response.ok:
        raise FashnError(f"FASHN output download returned {response.status_code}")

    content_type = response.headers.get("Content-Type", "image/png")
    return response.content, content_type


def generate(
    *,
    api_key: str,
    avatar_bytes: bytes,
    garment_bytes: bytes,
    category: str,
    model_name: str = DEFAULT_MODEL,
) -> TryOnResult:
    """Submit, poll and download in one call.

    Returns image bytes already in hand — the caller must persist them before
    doing anything else.
    """
    prediction_id = submit(
        api_key=api_key,
        avatar_bytes=avatar_bytes,
        garment_bytes=garment_bytes,
        category=category,
        model_name=model_name,
    )
    output_url = wait_for_output_url(api_key=api_key, prediction_id=prediction_id)
    image_bytes, content_type = download_output(output_url)

    return TryOnResult(
        prediction_id=prediction_id,
        image_bytes=image_bytes,
        content_type=content_type,
    )
