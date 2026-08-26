/**
 * Rule-based outfit suggestion engine. No AI cost.
 *
 * Scores candidate outfits on colour harmony, how the colours sit against the
 * user's own colouring, and weather fit. Mirrors the scoring in
 * functions/pipeline/colors.py.
 */

import { STALE_ITEM_DAYS } from './constants';

function hueDistance(a, b) {
  const delta = Math.abs(a - b) % 360;
  return Math.min(delta, 360 - delta);
}

export function harmonyScore(hueA, hueB) {
  const delta = hueDistance(hueA, hueB);
  if (delta < 20) return 0.85;   // monochromatic
  if (delta < 50) return 0.95;   // analogous
  if (delta > 150 && delta < 210) return 0.90; // complementary
  if (delta > 100 && delta < 140) return 0.75; // triadic-ish
  return 0.45;
}

export function flattersUndertone(color, undertone) {
  if (!color) return 0.5;
  const { hue, saturation, name } = color;

  if (['black', 'white', 'grey', 'beige'].includes(name)) return 0.8;

  const warm = hue < 60 || hue > 330;
  const cool = hue > 160 && hue < 290;

  let base;
  if (undertone === 'warm') base = warm ? 0.9 : cool ? 0.5 : 0.7;
  else if (undertone === 'cool') base = cool ? 0.9 : warm ? 0.5 : 0.7;
  else base = 0.8;

  if (saturation < 15) base -= 0.1;
  return Math.max(0, Math.min(1, base));
}

/** Map current conditions onto the weather tags carried by items. */
export function weatherTagsFor({ tempC, condition }) {
  const tags = [];
  if (tempC <= 12) tags.push('warm');
  if (tempC >= 22) tags.push('light');
  if (['Rain', 'Drizzle', 'Thunderstorm'].includes(condition)) tags.push('rain-safe');
  return tags;
}

export function scoreOutfit(items, { colorProfile, weatherTags = [] } = {}) {
  if (!items.length) return 0;

  const colors = items.map((item) => item.color).filter(Boolean);

  let harmony = 0.8;
  if (colors.length >= 2) {
    const pairs = [];
    for (let i = 0; i < colors.length; i += 1) {
      for (let j = i + 1; j < colors.length; j += 1) {
        pairs.push(harmonyScore(colors[i].hue, colors[j].hue));
      }
    }
    harmony = pairs.reduce((sum, value) => sum + value, 0) / pairs.length;
  }

  const undertone = colorProfile?.undertone || 'neutral';
  const flattery = colors.length
    ? colors.reduce((sum, color) => sum + flattersUndertone(color, undertone), 0) / colors.length
    : 0.6;

  // Weather is a reordering signal, never a filter — off-season items stay
  // visible, they just rank lower.
  let weather = 0.7;
  if (weatherTags.length) {
    const matches = items.filter((item) =>
      (item.tags || []).some((tag) => weatherTags.includes(tag)),
    ).length;
    weather = 0.5 + 0.5 * (matches / items.length);
  }

  return harmony * 0.45 + flattery * 0.35 + weather * 0.2;
}

/** Pick a random-but-good outfit. Free — assembled from existing layers. */
export function surpriseMe(items, options = {}) {
  const ready = items.filter((item) => item.status === 'ready' && !item.retired);

  const byCategory = (category) => ready.filter((item) => item.category === category);

  const candidates = [];
  const attempts = 40;

  for (let i = 0; i < attempts; i += 1) {
    const useDress = Math.random() < 0.3 && byCategory('dresses').length > 0;

    const picked = [];
    if (useDress) {
      picked.push(pickRandom(byCategory('dresses')));
    } else {
      const top = pickRandom(byCategory('tops'));
      const bottom = pickRandom(byCategory('bottoms'));
      if (top) picked.push(top);
      if (bottom) picked.push(bottom);
    }

    const shoes = pickRandom(byCategory('shoes'));
    if (shoes) picked.push(shoes);

    if (Math.random() < 0.4) {
      const outer = pickRandom(byCategory('outerwear'));
      if (outer) picked.push(outer);
    }

    const outfit = picked.filter(Boolean);
    if (outfit.length < 2) continue;

    candidates.push({ items: outfit, score: scoreOutfit(outfit, options) });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  // Choose from the top few rather than always the single best, so repeated
  // taps don't return the same outfit every time.
  return pickRandom(candidates.slice(0, 5));
}

function pickRandom(list) {
  if (!list?.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/** Items untouched for 30+ days, for the nudge card. */
export function staleItems(items, days = STALE_ITEM_DAYS) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return items.filter((item) => {
    if (item.retired || item.status !== 'ready') return false;
    const lastWorn = item.lastWornAt?.toMillis?.();
    if (!lastWorn) {
      const created = item.createdAt?.toMillis?.() ?? Date.now();
      return created < cutoff;
    }
    return lastWorn < cutoff;
  });
}

/** Categories the closet is missing, for "Fill the gap". */
export function findGaps(items) {
  const essential = ['tops', 'bottoms', 'shoes', 'outerwear'];
  const present = new Set(
    items.filter((item) => item.status === 'ready' && !item.retired).map((item) => item.category),
  );
  return essential.filter((category) => !present.has(category));
}

export function costPerWear(item) {
  const price = Number(item.price) || 0;
  const wears = Number(item.wearCount) || 0;
  if (!price) return null;
  return wears === 0 ? price : price / wears;
}
