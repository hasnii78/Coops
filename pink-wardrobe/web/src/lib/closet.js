/**
 * Closet data access and the client half of the garment pipeline.
 *
 * The cost model, restated because everything here depends on it: the paid
 * FASHN generation happens once per item, inside the process-garment Edge
 * Function. Every step in this file after that is free and local.
 */

import { supabase, callFunction } from '../supabase';
import { compressImage } from './images';
import { GENERATION_BLOCKED } from './constants';
import { BUCKET_LAYERS, BUCKET_WARDROBE, download, remove, upload } from './storage';
import {
  alignToMaster, checkAvatarQuality, detectLandmarks, dominantColor,
  measureBaseColor, segmentGarment,
} from './vision';

async function requireUserId() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in to continue.');
  return user.id;
}

// ---------------------------------------------------------------- avatar

/**
 * Upload and lock the master pose template.
 *
 * Quality is checked on-device before anything is stored, so a rejected photo
 * never touches the bucket. The base layer's colour is measured here too, and
 * every garment layer is later cut against it.
 *
 * Replacing an existing avatar invalidates every layer, since each is warped
 * to a pose that no longer exists. Those items are flagged rather than left to
 * stack wrongly with no explanation; the caller then offers the choice of what
 * to do about them.
 */
export async function uploadAvatar(file) {
  const userId = await requireUserId();
  const compressed = await compressImage(file, { maxEdge: 1600, quality: 0.9 });

  const { ok, problems, landmarks } = await checkAvatarQuality(compressed);

  if (!ok) {
    const error = new Error('That photo will not work as your avatar.');
    error.problems = problems;
    throw error;
  }

  const baseColor = await measureBaseColor(compressed);

  const { data: existing } = await supabase
    .from('profiles')
    .select('avatar_path, avatar_version')
    .eq('id', userId)
    .single();

  const isReplacement = Boolean(existing?.avatar_path);
  const nextVersion = (existing?.avatar_version ?? 1) + (isReplacement ? 1 : 0);

  const path = `${userId}/avatar/master-v${nextVersion}.jpg`;
  await upload(BUCKET_WARDROBE, path, compressed, 'image/jpeg');

  const { error } = await supabase
    .from('profiles')
    .update({
      avatar_path: path,
      avatar_landmarks: landmarks,
      avatar_base_color: baseColor,
      avatar_version: nextVersion,
      avatar_locked_at: new Date().toISOString(),
    })
    .eq('id', userId);

  if (error) throw error;

  let staleCount = 0;

  if (isReplacement) {
    const { data: stale } = await supabase
      .from('items')
      .update({ needs_regeneration: true })
      .eq('user_id', userId)
      .is('deleted_at', null)
      .neq('status', 'catalogued')
      .select('id');

    staleCount = stale?.length ?? 0;
  }

  return { path, baseColor, isReplacement, staleCount };
}

/** Items whose layer no longer matches the current avatar. */
export async function listStaleItems() {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('needs_regeneration', true)
    .is('deleted_at', null);

  if (error) throw error;
  return data ?? [];
}

/**
 * Regenerate every stale layer against the current avatar.
 *
 * One FASHN call per item — the saved generation shows the old body in the old
 * pose, so it cannot be reused. Sequential rather than parallel: each costs a
 * credit and holds a function instance, and a partial failure should not take
 * the rest down with it.
 */
export async function regenerateStaleItems(onProgress) {
  const stale = await listStaleItems();
  const results = [];

  for (const [index, item] of stale.entries()) {
    onProgress?.({ done: index, total: stale.length, name: item.name });

    try {
      // Clear the old generation so process-garment does not short-circuit on
      // its idempotency check and hand back the stale layer.
      await supabase
        .from('items')
        .update({ generation_path: null, layer_path: null, status: 'queued' })
        .eq('id', item.id);

      const result = await callFunction('process-garment', { itemId: item.id });

      await finishProcessing({
        ...item,
        generation_path: result.generationPath,
      });

      await supabase
        .from('items')
        .update({ needs_regeneration: false })
        .eq('id', item.id);

      results.push({ ok: true, name: item.name });
    } catch (error) {
      results.push({ ok: false, name: item.name, error: error.message });
    }
  }

  onProgress?.({ done: stale.length, total: stale.length });
  return results;
}

/**
 * Move every stale item to the recycle bin.
 *
 * Recycle bin rather than permanent deletion, so a hasty choice is reversible
 * for fifteen days. A restored item is still stale and keeps its flag.
 */
export async function discardStaleItems() {
  const { data, error } = await supabase
    .from('items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('needs_regeneration', true)
    .is('deleted_at', null)
    .select('id');

  if (error) throw error;
  return data?.length ?? 0;
}

// ----------------------------------------------------------------- items

export async function listItems({ includeDeleted = false } = {}) {
  let query = supabase.from('items').select('*').order('created_at', { ascending: false });

  query = includeDeleted ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * Run pipeline steps 4-6 on the device.
 *
 * Separated from addItem so a failed or interrupted run can be resumed from
 * the saved generation without touching FASHN again.
 */
export async function finishProcessing(item) {
  const userId = await requireUserId();

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('avatar_landmarks, avatar_base_color, avatar_version')
    .eq('id', userId)
    .single();

  if (profileError) throw profileError;

  const generationBlob = await download(item.generation_path, BUCKET_WARDROBE);

  // Step 4 — cut the garment out. Landmarks are detected on the generation
  // itself, not the avatar: the band has to follow the body in THIS image.
  let generationLandmarks = null;
  try {
    generationLandmarks = await detectLandmarks(generationBlob);
  } catch {
    // No landmarks means no band; the class and colour filters still apply.
  }

  const cutout = await segmentGarment(generationBlob, item.category, {
    landmarks: generationLandmarks,
    baseColor: profile.avatar_base_color,
  });

  // Step 5 — align it to the master template.
  const { blob: aligned, meta } = await alignToMaster({
    layerBlob: cutout,
    generationBlob,
    masterLandmarks: profile.avatar_landmarks,
  });

  // Step 6 — save the reusable layer.
  const layerPath = `${userId}/layers/${item.id}.png`;
  await upload(BUCKET_LAYERS, layerPath, aligned, 'image/png');

  const color = await dominantColor(aligned);

  const { data, error } = await supabase
    .from('items')
    .update({
      status: 'ready',
      layer_path: layerPath,
      alignment: meta,
      color,
      processed_at: new Date().toISOString(),
      needs_regeneration: false,
      avatar_version: profile.avatar_version ?? 1,
    })
    .eq('id', item.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Add one garment and take it all the way to a reusable layer.
 *
 * Steps 1-3 (moderation, FASHN, immediate persist) happen in the Edge
 * Function. Steps 4-6 happen here.
 */
export async function addItem({ file, name, category, price, tags = [] }) {
  const userId = await requireUserId();
  const compressed = await compressImage(file);

  const catalogueOnly = GENERATION_BLOCKED.includes(category);

  const { data: item, error } = await supabase
    .from('items')
    .insert({
      user_id: userId,
      name: name?.trim() || 'Untitled',
      category,
      price: Number(price) || 0,
      tags,
      status: catalogueOnly ? 'catalogued' : 'queued',
    })
    .select()
    .single();

  if (error) throw error;

  const photoPath = `${userId}/photos/${item.id}.jpg`;
  await upload(BUCKET_WARDROBE, photoPath, compressed, 'image/jpeg');
  await supabase.from('items').update({ photo_path: photoPath }).eq('id', item.id);

  if (catalogueOnly) {
    // Catalogued-only categories never reach FASHN.
    return { ...item, photo_path: photoPath };
  }

  const result = await callFunction('process-garment', { itemId: item.id });

  if (result.status === 'ready') {
    return { ...item, layer_path: result.layerPath, status: 'ready' };
  }

  return finishProcessing({ ...item, generation_path: result.generationPath, category });
}

/**
 * Bulk upload. Deliberately sequential: each item costs a credit, and firing
 * many at once risks rate limits for no user-visible gain.
 */
export async function addItemsBulk(entries, onProgress) {
  const results = [];

  for (const [index, entry] of entries.entries()) {
    try {
      const item = await addItem(entry);
      results.push({ ok: true, item, name: entry.name });
    } catch (error) {
      results.push({ ok: false, error: error.message, name: entry.name });
    }
    onProgress?.(index + 1, entries.length);
  }

  return results;
}

/** Retry a failed item. Failed FASHN generations are not billed. */
export async function retryItem(item) {
  if (item.generation_path) {
    // The paid step already succeeded — resume for free.
    return finishProcessing(item);
  }

  const result = await callFunction('process-garment', { itemId: item.id });

  if (result.status === 'ready') return item;
  return finishProcessing({ ...item, generation_path: result.generationPath });
}

async function patchItem(id, changes) {
  const { data, error } = await supabase
    .from('items').update(changes).eq('id', id).select().single();

  if (error) throw error;
  return data;
}

export const toggleLike = (id, liked) => patchItem(id, { liked });
export const togglePin = (id, pinned) => patchItem(id, { pinned });
export const setNudge = (id, nudge) => patchItem(id, { nudge });

/** Retiring keeps outfit history intact, unlike deleting. */
export const retireItem = (id, reason = 'donated') =>
  patchItem(id, { retired: true, retired_reason: reason });

export async function recordWear(id) {
  // "Worn" implies liked, per the brief.
  const { error } = await supabase.rpc('increment_wear', { item_id: id }).then(
    (result) => result,
    () => ({ error: true }),
  );

  if (error) {
    // No RPC deployed — fall back to a read-modify-write.
    const { data } = await supabase.from('items').select('wear_count').eq('id', id).single();
    await patchItem(id, {
      wear_count: (data?.wear_count ?? 0) + 1,
      last_worn_at: new Date().toISOString(),
      liked: true,
    });
  }
}

/** Move to the recycle bin. Restorable for 15 days, then purged. */
export const softDeleteItem = (id) => patchItem(id, { deleted_at: new Date().toISOString() });

export const restoreItem = (id) => patchItem(id, { deleted_at: null });

export const listRecycleBin = () => listItems({ includeDeleted: true });

// ---------------------------------------------------------------- combos

export async function saveCombo({ name, itemIds, compositePath = null, notes = '' }) {
  const userId = await requireUserId();

  const { data, error } = await supabase
    .from('combos')
    .insert({
      user_id: userId,
      name: name?.trim() || 'Untitled outfit',
      item_ids: itemIds,
      composite_path: compositePath,
      notes,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listCombos() {
  const { data, error } = await supabase
    .from('combos').select('*').order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function patchCombo(id, changes) {
  const { data, error } = await supabase
    .from('combos').update(changes).eq('id', id).select().single();

  if (error) throw error;
  return data;
}

export async function wearCombo(combo) {
  const userId = await requireUserId();

  await patchCombo(combo.id, {
    wear_count: (combo.wear_count ?? 0) + 1,
    last_worn_at: new Date().toISOString(),
    liked: true,
  });

  await Promise.all((combo.item_ids ?? []).map((id) => recordWear(id)));

  await supabase.from('wear_history').insert({
    user_id: userId,
    combo_id: combo.id,
    combo_name: combo.name,
    item_ids: combo.item_ids ?? [],
  });
}

export async function listHistory() {
  const { data, error } = await supabase
    .from('wear_history').select('*').order('worn_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function listWishlist() {
  const { data, error } = await supabase
    .from('items').select('*').eq('wishlist', true).is('deleted_at', null);

  if (error) throw error;
  return data ?? [];
}

// ------------------------------------------------------------ composites

export async function findCachedComposite(comboHash) {
  const { data } = await supabase
    .from('composites').select('composite_path').eq('combo_hash', comboHash).maybeSingle();

  return data?.composite_path ?? null;
}

export async function saveComposite({ comboHash, itemIds, blob }) {
  const userId = await requireUserId();
  const path = `${userId}/composites/${comboHash}.png`;

  await upload(BUCKET_LAYERS, path, blob, 'image/png');

  await supabase.from('composites').upsert({
    user_id: userId,
    combo_hash: comboHash,
    item_ids: itemIds,
    composite_path: path,
  });

  return path;
}

/** Delete an item's stored images. Used by the local recycle-bin flow. */
export async function purgeItemStorage(item) {
  await remove([item.photo_path, item.generation_path, item.layer_path]);
}
