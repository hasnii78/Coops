// Content boundary, enforced in code before any spend.
//
// Swimwear and gym wear are ordinary categories. Underwear may be catalogued
// in the closet but never generated onto the avatar, and an outfit must
// include at least one genuinely body-covering garment.

export const ALLOWED_CATEGORIES = new Set([
  'tops', 'bottoms', 'dresses', 'outerwear', 'shoes',
  'accessories', 'gym_wear', 'swimwear', 'undergarments',
]);

const RESTRICTED_ALONE = new Set(['undergarments']);

const BODY_COVERING = new Set([
  'tops', 'bottoms', 'dresses', 'outerwear', 'gym_wear', 'swimwear',
]);

export class ContentBlocked extends Error {}

export function validateGeneration(category: string): void {
  if (!ALLOWED_CATEGORIES.has(category)) {
    throw new ContentBlocked(`Unknown category: ${category}`);
  }

  if (RESTRICTED_ALONE.has(category)) {
    throw new ContentBlocked(
      "Underwear can be catalogued in your closet, but can't be generated " +
        'onto your avatar. Try a top, dress or swimwear instead.',
    );
  }
}

export function validateOutfit(categories: string[]): void {
  if (categories.length === 0) {
    throw new ContentBlocked('Select at least one item to build an outfit.');
  }

  for (const category of categories) {
    if (!ALLOWED_CATEGORIES.has(category)) {
      throw new ContentBlocked(`Unknown category: ${category}`);
    }
  }

  if (!categories.some((category) => BODY_COVERING.has(category))) {
    throw new ContentBlocked(
      'Add a top, bottom, dress or swimwear to build this outfit.',
    );
  }
}
