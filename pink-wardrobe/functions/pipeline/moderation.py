"""Content boundary enforcement.

Enforced in code before any FASHN call, not as a policy note. Swimwear and
gym wear are ordinary categories; underwear-only outfits and nudity are not.
"""

from __future__ import annotations

# Categories permitted as a garment layer over a clothed avatar.
ALLOWED_CATEGORIES = {
    "tops",
    "bottoms",
    "dresses",
    "outerwear",
    "shoes",
    "accessories",
    "gym_wear",
    "swimwear",
    "undergarments",
}

# Undergarments may be stored and catalogued in the closet, but may not be
# generated or composited as the only body-covering layer.
RESTRICTED_ALONE = {"undergarments"}

BODY_COVERING = {"tops", "bottoms", "dresses", "outerwear", "gym_wear", "swimwear"}


class ContentBlocked(ValueError):
    """Raised when a request crosses the content boundary."""


def validate_category(category: str) -> None:
    if category not in ALLOWED_CATEGORIES:
        raise ContentBlocked(f"Unknown category: {category}")


def validate_generation(category: str) -> None:
    """Gate a single-garment FASHN generation."""
    validate_category(category)

    if category in RESTRICTED_ALONE:
        raise ContentBlocked(
            "Underwear can be catalogued in your closet, but can't be generated "
            "onto your avatar. Try a top, dress or swimwear instead."
        )


def validate_outfit(categories: list[str]) -> None:
    """Gate a composited outfit.

    An outfit must include at least one genuinely body-covering garment. This
    blocks underwear-only combinations without banning the category outright.
    """
    for category in categories:
        validate_category(category)

    if not categories:
        raise ContentBlocked("Select at least one item to build an outfit.")

    if not any(category in BODY_COVERING for category in categories):
        raise ContentBlocked(
            "Add a top, bottom, dress or swimwear to build this outfit."
        )
