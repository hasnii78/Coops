"""Pink Wardrobe — Cloud Functions (Python, 2nd gen).

Hosts the pipeline steps that cannot run in a browser: the FASHN call,
segmentation, pose alignment and Poisson blending.

Cost model, stated once because everything here depends on it:
  * FASHN is called EXACTLY ONCE per clothing item, in `process_garment`.
  * Every outfit thereafter is assembled from saved layers for free.
  * If `process_garment` ever runs twice for the same item, money is lost.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from firebase_admin import firestore, initialize_app, messaging, storage
from firebase_functions import firestore_fn, https_fn, options, scheduler_fn

from pipeline import align, blend, colors, fashn, moderation, segment

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pinkwardrobe")

initialize_app()

# The CV stack (onnxruntime + mediapipe + opencv) needs real memory headroom.
# 2GB is the smallest tier that reliably avoids OOM during alpha matting.
PIPELINE_OPTIONS = {
    "memory": options.MemoryOption.GB_2,
    "timeout_sec": 540,
    "region": "us-central1",
    "secrets": ["FASHN_API_KEY"],
}


def _bucket():
    return storage.bucket()


def _db():
    return firestore.client()


def _upload(path: str, data: bytes, content_type: str = "image/png") -> str:
    """Write bytes to Storage and return the object path.

    Deliberately returns a path, never a public URL. Clients resolve paths
    through the authenticated SDK; nothing in this bucket is world-readable.
    """
    blob = _bucket().blob(path)
    blob.upload_from_string(data, content_type=content_type)
    return path


def _download(path: str) -> bytes:
    return _bucket().blob(path).download_as_bytes()


def _require_auth(req: https_fn.CallableRequest) -> str:
    if req.auth is None or not req.auth.uid:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAUTHENTICATED,
            message="Sign in to continue.",
        )
    return req.auth.uid


# ---------------------------------------------------------------------------
# One-time setup: the master pose template.
# ---------------------------------------------------------------------------

@https_fn.on_call(**{k: v for k, v in PIPELINE_OPTIONS.items() if k != "secrets"})
def validate_avatar(req: https_fn.CallableRequest) -> dict:
    """Quality-check a candidate avatar and lock in its pose landmarks.

    This photo becomes permanent: every garment layer the user ever generates
    is aligned to these landmarks. A bad avatar can't be undone without
    regenerating the entire closet, so it is checked hard here.
    """
    uid = _require_auth(req)
    storage_path = req.data.get("storagePath")

    if not storage_path or not storage_path.startswith(f"users/{uid}/"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            message="Invalid avatar path.",
        )

    image_bytes = _download(storage_path)
    ok, problems = align.check_avatar_quality(image_bytes)

    if not ok:
        return {"accepted": False, "problems": problems}

    landmarks = align.detect_landmarks(image_bytes)

    _db().document(f"users/{uid}").set(
        {
            "avatar": {
                "storagePath": storage_path,
                "landmarks": landmarks.to_dict(),
                "lockedAt": firestore.SERVER_TIMESTAMP,
            }
        },
        merge=True,
    )

    log.info("Master template locked for %s", uid)
    return {"accepted": True, "problems": []}


# ---------------------------------------------------------------------------
# The only paid path in the application.
# ---------------------------------------------------------------------------

@https_fn.on_call(**PIPELINE_OPTIONS)
def process_garment(req: https_fn.CallableRequest) -> dict:
    """Run a garment through the full pipeline, producing a reusable layer.

    Steps 1-6 of the brief. Called once per clothing item, ever.
    """
    uid = _require_auth(req)
    item_id = req.data.get("itemId")
    category = req.data.get("category")
    garment_path = req.data.get("garmentPath")

    if not all([item_id, category, garment_path]):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="itemId, category and garmentPath are required.",
        )

    if not garment_path.startswith(f"users/{uid}/"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            message="Invalid garment path.",
        )

    # --- Content boundary, before any spend. --------------------------------
    try:
        moderation.validate_generation(category)
    except moderation.ContentBlocked as exc:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message=str(exc),
        ) from exc

    db = _db()
    item_ref = db.document(f"users/{uid}/items/{item_id}")
    snapshot = item_ref.get()

    if not snapshot.exists:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.NOT_FOUND,
            message="Item not found.",
        )

    # --- Idempotency guard. -------------------------------------------------
    # Without this, a double-tap or a client retry spends a second credit on a
    # garment we already own a layer for.
    existing = snapshot.to_dict() or {}
    if existing.get("layerPath") and existing.get("status") == "ready":
        log.info("Item %s already processed; returning cached layer.", item_id)
        return {"status": "ready", "layerPath": existing["layerPath"], "cached": True}

    user_doc = db.document(f"users/{uid}").get().to_dict() or {}
    avatar = user_doc.get("avatar")

    if not avatar or not avatar.get("landmarks"):
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message="Upload and confirm your avatar photo first.",
        )

    api_key = os.environ.get("FASHN_API_KEY")
    if not api_key:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INTERNAL,
            message="Garment generation is not configured.",
        )

    item_ref.update({"status": "generating", "error": firestore.DELETE_FIELD})

    avatar_bytes = _download(avatar["storagePath"])
    garment_bytes = _download(garment_path)

    # --- Step 2: the paid generation. ---------------------------------------
    try:
        result = fashn.generate(
            api_key=api_key,
            avatar_bytes=avatar_bytes,
            garment_bytes=garment_bytes,
            category=category,
        )
    except fashn.FashnError as exc:
        item_ref.update({"status": "failed", "error": str(exc)})
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.UNAVAILABLE if exc.retryable
            else https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message=str(exc),
        ) from exc

    # --- Step 3: persist IMMEDIATELY. ---------------------------------------
    # FASHN output URLs expire. Everything below can be recomputed from this
    # saved file for free; nothing below can be recovered without it.
    generation_path = _upload(
        f"users/{uid}/generations/{item_id}.png",
        result.image_bytes,
        result.content_type,
    )
    item_ref.update({"generationPath": generation_path, "status": "processing"})
    log.info("FASHN output persisted for item %s", item_id)

    # --- Steps 4-6: free, local, and safely retryable from here. -------------
    cutout = segment.remove_background(result.image_bytes)
    garment_only = segment.isolate_garment_region(cutout, category)

    master_landmarks = align.PoseLandmarks.from_dict(avatar["landmarks"])
    aligned_layer, alignment_meta = align.align_to_master(
        layer_png=garment_only,
        generation_bytes=result.image_bytes,
        master_landmarks=master_landmarks,
    )

    layer_path = _upload(f"users/{uid}/layers/{item_id}.png", aligned_layer)
    dominant = colors.dominant_color(aligned_layer)

    item_ref.update(
        {
            "status": "ready",
            "layerPath": layer_path,
            "alignment": alignment_meta,
            "color": dominant,
            "predictionId": result.prediction_id,
            "processedAt": firestore.SERVER_TIMESTAMP,
        }
    )

    log.info("Layer ready for item %s (aligned=%s)", item_id, alignment_meta["aligned"])
    return {
        "status": "ready",
        "layerPath": layer_path,
        "alignment": alignment_meta,
        "color": dominant,
        "cached": False,
    }


# ---------------------------------------------------------------------------
# Free forever: outfit compositing.
# ---------------------------------------------------------------------------

@https_fn.on_call(
    memory=options.MemoryOption.GB_1,
    timeout_sec=120,
    region="us-central1",
)
def build_outfit(req: https_fn.CallableRequest) -> dict:
    """Composite saved layers with Poisson seam blending. No AI cost.

    The client already renders an instant Canvas stack for preview; this
    returns the refined blend, cached by item-set hash so any given outfit is
    blended at most once.
    """
    uid = _require_auth(req)
    item_ids = req.data.get("itemIds") or []

    if not item_ids:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            message="Select at least one item.",
        )

    db = _db()
    cache_key = blend.combo_hash(item_ids)
    cache_ref = db.document(f"users/{uid}/composites/{cache_key}")
    cached = cache_ref.get()

    if cached.exists:
        data = cached.to_dict()
        return {"compositePath": data["compositePath"], "cached": True}

    items = []
    for item_id in item_ids:
        snapshot = db.document(f"users/{uid}/items/{item_id}").get()
        if not snapshot.exists:
            continue
        data = snapshot.to_dict()
        if data.get("layerPath"):
            items.append(data)

    if not items:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message="None of those items have a finished layer yet.",
        )

    try:
        moderation.validate_outfit([item["category"] for item in items])
    except moderation.ContentBlocked as exc:
        raise https_fn.HttpsError(
            code=https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            message=str(exc),
        ) from exc

    user_doc = db.document(f"users/{uid}").get().to_dict() or {}
    avatar_bytes = _download(user_doc["avatar"]["storagePath"])

    layers = [(item["category"], _download(item["layerPath"])) for item in items]
    composited = blend.composite(avatar_bytes, layers, blend_seams=True)

    composite_path = _upload(f"users/{uid}/composites/{cache_key}.png", composited)
    cache_ref.set(
        {
            "compositePath": composite_path,
            "itemIds": sorted(item_ids),
            "createdAt": firestore.SERVER_TIMESTAMP,
        }
    )

    return {"compositePath": composite_path, "cached": False}


# ---------------------------------------------------------------------------
# Recycle bin auto-purge.
# ---------------------------------------------------------------------------

@scheduler_fn.on_schedule(schedule="every day 03:00", region="us-central1")
def purge_recycle_bin(event: scheduler_fn.ScheduledEvent) -> None:
    """Permanently delete recycle-bin items older than 15 days.

    Deletes Storage objects as well as Firestore records — orphaned layer PNGs
    would otherwise accumulate storage cost forever.
    """
    db = _db()
    cutoff = datetime.now(timezone.utc) - timedelta(days=15)

    expired = db.collection_group("recycleBin").where("deletedAt", "<", cutoff).stream()

    purged = 0
    for doc in expired:
        data = doc.to_dict()
        for key in ("photoPath", "generationPath", "layerPath"):
            path = data.get(key)
            if not path:
                continue
            try:
                _bucket().blob(path).delete()
            except Exception as exc:  # noqa: BLE001 - best effort cleanup
                log.warning("Could not delete %s: %s", path, exc)
        doc.reference.delete()
        purged += 1

    log.info("Recycle bin purge complete: %d item(s) removed.", purged)


# ---------------------------------------------------------------------------
# Push notifications.
# ---------------------------------------------------------------------------

@firestore_fn.on_document_created(
    document="conversations/{conversationId}/messages/{messageId}",
    region="us-central1",
)
def notify_on_message(event: firestore_fn.Event[firestore_fn.DocumentSnapshot | None]) -> None:
    """Send an FCM push to the recipient when a message or outfit arrives."""
    if event.data is None:
        return

    message = event.data.to_dict() or {}
    sender_id = message.get("senderId")
    conversation_id = event.params["conversationId"]

    db = _db()
    conversation = db.document(f"conversations/{conversation_id}").get().to_dict() or {}
    participants = conversation.get("participants", [])

    recipients = [uid for uid in participants if uid != sender_id]
    if not recipients:
        return

    sender_doc = db.document(f"users/{sender_id}").get().to_dict() or {}
    sender_name = sender_doc.get("displayName") or sender_doc.get("username") or "Someone"

    if message.get("type") == "outfit":
        title = f"{sender_name} sent you an outfit"
        body = message.get("outfitName") or "Tap to take a look"
    else:
        title = sender_name
        body = (message.get("text") or "")[:120]

    for uid in recipients:
        tokens = (db.document(f"users/{uid}").get().to_dict() or {}).get("fcmTokens", [])
        for token in tokens:
            try:
                messaging.send(
                    messaging.Message(
                        token=token,
                        notification=messaging.Notification(title=title, body=body),
                        data={"conversationId": conversation_id},
                    )
                )
            except Exception as exc:  # noqa: BLE001 - a stale token must not break delivery
                log.warning("Push to token failed: %s", exc)
