/**
 * purge-recycle-bin — permanently removes items deleted more than 15 days ago.
 *
 * Runs the SQL purge and then deletes the orphaned storage objects, which the
 * database function cannot reach. Schedule it daily (see docs/DEPLOYMENT.md);
 * without the storage half, layer PNGs accumulate cost forever.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

import { json, preflight } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return preflight(origin);
  }

  // Scheduled invocations authenticate with a shared secret rather than a user
  // session, so this endpoint is never reachable from the app.
  const provided = req.headers.get('x-purge-secret');
  const expected = Deno.env.get('PURGE_SECRET');

  if (!expected || provided !== expected) {
    return json({ error: 'Not authorised.' }, 401, origin);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

  // Read the doomed rows first — once deleted, their paths are gone.
  const { data: expired, error } = await admin
    .from('items')
    .select('id, user_id, photo_path, generation_path, layer_path')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff);

  if (error) {
    console.error('purge query failed', error.message);
    return json({ error: 'Purge failed.' }, 500, origin);
  }

  if (!expired?.length) {
    return json({ purged: 0 }, 200, origin);
  }

  const wardrobePaths: string[] = [];
  const layerPaths: string[] = [];

  for (const item of expired) {
    if (item.photo_path) wardrobePaths.push(item.photo_path);
    if (item.generation_path) wardrobePaths.push(item.generation_path);
    if (item.layer_path) layerPaths.push(item.layer_path);
  }

  if (wardrobePaths.length) {
    const { error: removeError } = await admin.storage.from('wardrobe').remove(wardrobePaths);
    if (removeError) console.warn('wardrobe cleanup partial', removeError.message);
  }

  if (layerPaths.length) {
    const { error: removeError } = await admin.storage.from('layers').remove(layerPaths);
    if (removeError) console.warn('layer cleanup partial', removeError.message);
  }

  const { error: deleteError } = await admin
    .from('items')
    .delete()
    .in('id', expired.map((item) => item.id));

  if (deleteError) {
    console.error('purge delete failed', deleteError.message);
    return json({ error: 'Purge failed.' }, 500, origin);
  }

  return json({ purged: expired.length }, 200, origin);
});
