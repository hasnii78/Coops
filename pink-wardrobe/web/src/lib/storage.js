/**
 * Supabase Storage access.
 *
 * Both buckets are private. There are no public URLs anywhere in this app —
 * every read goes through a short-lived signed URL, and those are cached in
 * memory so a grid of forty items does not trigger forty signing round-trips.
 */

import { supabase } from '../supabase';

const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Re-sign a little before expiry so a URL never goes stale mid-render.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const cache = new Map();

export const BUCKET_WARDROBE = 'wardrobe';
export const BUCKET_LAYERS = 'layers';

/** Which bucket a path belongs to, inferred from its shape. */
export function bucketFor(path) {
  return path.includes('/layers/') || path.includes('/composites/')
    ? BUCKET_LAYERS
    : BUCKET_WARDROBE;
}

export async function signedUrl(path, bucket = null) {
  if (!path) return null;

  const cached = cache.get(path);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.url;
  }

  const { data, error } = await supabase.storage
    .from(bucket || bucketFor(path))
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

  if (error) throw error;

  cache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
  });

  return data.signedUrl;
}

/** Sign many paths at once, skipping nulls. */
export async function signedUrls(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  const entries = await Promise.all(
    unique.map(async (path) => [path, await signedUrl(path).catch(() => null)]),
  );
  return Object.fromEntries(entries);
}

export async function upload(bucket, path, blob, contentType) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, blob, { contentType, upsert: true });

  if (error) throw error;

  cache.delete(path);   // any signed URL now points at stale bytes
  return path;
}

export async function download(path, bucket = null) {
  const { data, error } = await supabase.storage
    .from(bucket || bucketFor(path))
    .download(path);

  if (error) throw error;
  return data;
}

export async function remove(paths) {
  const byBucket = {};

  for (const path of paths.filter(Boolean)) {
    const bucket = bucketFor(path);
    (byBucket[bucket] ||= []).push(path);
    cache.delete(path);
  }

  await Promise.all(
    Object.entries(byBucket).map(([bucket, list]) =>
      supabase.storage.from(bucket).remove(list),
    ),
  );
}
