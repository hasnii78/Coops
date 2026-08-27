/**
 * process-garment — the only paid path in the application.
 *
 * Runs steps 1-3 of the pipeline:
 *   1. Content boundary check, before any spend.
 *   2. FASHN generates the avatar wearing the garment.
 *   3. The output is downloaded and persisted IMMEDIATELY.
 *
 * Steps 4-6 (segmentation, pose alignment, layer save) run on the device via
 * MediaPipe WASM. They are free, local, and safely retryable from the file
 * saved in step 3 — which is exactly why step 3 must not be deferred.
 *
 * This function must be called once per clothing item, ever. It is guarded by
 * an idempotency check: if a layer already exists, it returns without
 * spending a second credit.
 */

// npm: is the specifier Supabase's Edge Runtime documents for this package.
import { createClient } from 'npm:@supabase/supabase-js@2';

import { json, preflight } from '../_shared/cors.ts';
import { ContentBlocked, validateGeneration } from '../_shared/moderation.ts';
import { FashnError, generate } from '../_shared/fashn.ts';

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return preflight(origin);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return json({ error: 'Sign in to continue.' }, 401, origin);
  }

  // Two clients, deliberately. The caller-scoped client resolves who is asking
  // and is subject to RLS. The admin client does the storage and table writes
  // the pipeline needs. Never use the admin client to decide identity.
  const callerClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error: authError } = await callerClient.auth.getUser();

  if (authError || !user) {
    return json({ error: 'Sign in to continue.' }, 401, origin);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  let body: { itemId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400, origin);
  }

  const { itemId } = body;
  if (!itemId) {
    return json({ error: 'itemId is required.' }, 400, origin);
  }

  // ---------------------------------------------------------------- load
  const { data: item, error: itemError } = await admin
    .from('items')
    .select('*')
    .eq('id', itemId)
    .eq('user_id', user.id)          // ownership, not just existence
    .maybeSingle();

  if (itemError || !item) {
    return json({ error: 'Item not found.' }, 404, origin);
  }

  // ------------------------------------------------- idempotency guard
  // Without this, a double-tap or a client retry spends a second credit on a
  // garment we already own a layer for.
  if (item.layer_path && item.status === 'ready') {
    return json(
      { status: 'ready', layerPath: item.layer_path, cached: true },
      200,
      origin,
    );
  }

  if (item.generation_path) {
    // The paid step already succeeded on an earlier attempt; the device can
    // resume from the saved generation for free.
    return json(
      { status: 'processing', generationPath: item.generation_path, cached: true },
      200,
      origin,
    );
  }

  // --------------------------------------- content boundary, before spend
  try {
    validateGeneration(item.category);
  } catch (error) {
    if (error instanceof ContentBlocked) {
      return json({ error: error.message }, 422, origin);
    }
    throw error;
  }

  // ------------------------------------------------------------- avatar
  const { data: profile } = await admin
    .from('profiles')
    .select('avatar_path, avatar_landmarks')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.avatar_path || !profile.avatar_landmarks) {
    return json(
      { error: 'Upload and confirm your avatar photo first.' },
      412,
      origin,
    );
  }

  const apiKey = Deno.env.get('FASHN_API_KEY');
  if (!apiKey) {
    console.error('FASHN_API_KEY is not set on this project.');
    return json({ error: 'Garment generation is not configured.' }, 500, origin);
  }

  if (!item.photo_path) {
    return json({ error: 'This item has no photo to work from.' }, 412, origin);
  }

  await admin.from('items').update({ status: 'generating', error: null }).eq('id', itemId);

  // ------------------------------------------------------ fetch inputs
  const [avatarFile, garmentFile] = await Promise.all([
    admin.storage.from('wardrobe').download(profile.avatar_path),
    admin.storage.from('wardrobe').download(item.photo_path),
  ]);

  if (avatarFile.error || !avatarFile.data) {
    await admin.from('items').update({ status: 'failed', error: 'Avatar image missing.' })
      .eq('id', itemId);
    return json({ error: 'Could not read your avatar photo.' }, 500, origin);
  }

  if (garmentFile.error || !garmentFile.data) {
    await admin.from('items').update({ status: 'failed', error: 'Garment image missing.' })
      .eq('id', itemId);
    return json({ error: 'Could not read the garment photo.' }, 500, origin);
  }

  // ------------------------------------------- step 2: the paid generation
  let result;
  try {
    result = await generate({
      apiKey,
      avatar: new Uint8Array(await avatarFile.data.arrayBuffer()),
      garment: new Uint8Array(await garmentFile.data.arrayBuffer()),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Generation failed.';
    await admin.from('items').update({ status: 'failed', error: message }).eq('id', itemId);

    const retryable = error instanceof FashnError ? error.retryable : true;
    return json({ error: message, retryable }, retryable ? 503 : 422, origin);
  }

  // --------------------------------- step 3: persist IMMEDIATELY, no delay
  // Everything below can be recomputed from this file for free. Nothing below
  // can be recovered without it.
  const generationPath = `${user.id}/generations/${itemId}.png`;

  const upload = await admin.storage
    .from('wardrobe')
    .upload(generationPath, result.bytes, {
      contentType: result.contentType,
      upsert: true,
    });

  if (upload.error) {
    // The credit is spent and the image is about to be unreachable. Log loudly.
    console.error('CRITICAL: FASHN output could not be saved', {
      itemId,
      predictionId: result.predictionId,
      error: upload.error.message,
    });
    await admin.from('items')
      .update({ status: 'failed', error: 'Could not save the generated image.' })
      .eq('id', itemId);
    return json({ error: 'Could not save the generated image.' }, 500, origin);
  }

  await admin.from('items').update({
    generation_path: generationPath,
    prediction_id: result.predictionId,
    status: 'processing',
  }).eq('id', itemId);

  return json(
    { status: 'processing', generationPath, predictionId: result.predictionId, cached: false },
    200,
    origin,
  );
});
