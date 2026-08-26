/** Closet categories, in the order they appear in filters and accordions. */
export const CATEGORIES = [
  { id: 'tops', label: 'Tops' },
  { id: 'bottoms', label: 'Bottoms' },
  { id: 'dresses', label: 'Dresses' },
  { id: 'outerwear', label: 'Outerwear' },
  { id: 'shoes', label: 'Shoes' },
  { id: 'accessories', label: 'Accessories' },
  { id: 'undergarments', label: 'Undergarments' },
  { id: 'gym_wear', label: 'Gym Wear' },
  { id: 'swimwear', label: 'Swimwear' },
];

export const CATEGORY_LABELS = Object.fromEntries(
  CATEGORIES.map(({ id, label }) => [id, label]),
);

/**
 * Paint order for stacked layers. Mirrors Z_ORDER in functions/pipeline/blend.py
 * — if you change one, change the other or previews will disagree with the
 * server-blended result.
 */
export const Z_ORDER = [
  'bottoms',
  'dresses',
  'swimwear',
  'gym_wear',
  'tops',
  'outerwear',
  'shoes',
  'accessories',
  'undergarments',
];

/** Categories that cannot be generated onto the avatar on their own. */
export const GENERATION_BLOCKED = ['undergarments'];

export const THEMES = [
  { id: 'pink', label: 'Pink', swatch: '#ED93B1' },
  { id: 'darkred', label: 'Dark red', swatch: '#A83232' },
  { id: 'red', label: 'Red', swatch: '#D9342A' },
  { id: 'brown', label: 'Brown', swatch: '#8B5E34' },
];

export const TEXT_SIZES = [
  { id: 'small', label: 'Small', px: 14 },
  { id: 'medium', label: 'Medium', px: 16 },
  { id: 'large', label: 'Large', px: 19 },
];

export const OCCASIONS = ['date night', 'gym', 'formal', 'lazy day'];

/** Items untouched for this long surface in the "haven't worn" nudge. */
export const STALE_ITEM_DAYS = 30;

/** How long deleted items stay restorable. */
export const RECYCLE_BIN_DAYS = 15;
