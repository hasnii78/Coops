/**
 * signup — creates a username-only account.
 *
 * Supabase Auth has no username provider; it authenticates on email, phone or
 * OAuth. So a deterministic internal handle stands in as the login identifier.
 * The user never sees, types or receives anything at that address — the app
 * has two fields, username and password.
 *
 * This runs server-side for one reason that matters: if the username turns out
 * to be taken, the auth user must be deleted again, and only the service role
 * can do that. Doing it from the browser would leave orphaned auth users
 * squatting usernames on every failed attempt.
 *
 * Uniqueness is enforced by the UNIQUE constraint on profiles.username, not by
 * a readable directory — there is no table anyone can query to enumerate users.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

import { json } from '../_shared/cors.ts';

const INTERNAL_DOMAIN = 'pinkwardrobe.internal';
const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;

// Postgres unique-violation SQLSTATE.
const UNIQUE_VIOLATION = '23505';

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');

  if (req.method === 'OPTIONS') {
    return json({}, 204, origin);
  }

  let body: { username?: string; password?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400, origin);
  }

  const username = String(body.username ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const displayName = String(body.displayName ?? '').trim();

  if (!USERNAME_PATTERN.test(username)) {
    return json(
      { error: 'Usernames are 3-20 characters: letters, numbers, dots and underscores.' },
      400,
      origin,
    );
  }

  if (password.length < 8) {
    return json({ error: 'Passwords need at least 8 characters.' }, 400, origin);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Create the auth user first — the profile row needs its id.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: `${username}@${INTERNAL_DOMAIN}`,
    password,
    // The address is synthetic and undeliverable, so there is nothing to
    // confirm. Without this the account would be stuck unconfirmed forever.
    email_confirm: true,
    user_metadata: { username },
  });

  if (createError || !created.user) {
    const message = createError?.message ?? '';
    if (message.includes('already been registered')) {
      return json({ error: 'That username is taken.' }, 409, origin);
    }
    console.error('createUser failed', message);
    return json({ error: 'Could not create the account.' }, 500, origin);
  }

  const { error: profileError } = await admin.from('profiles').insert({
    id: created.user.id,
    username,
    display_name: displayName || username,
  });

  if (profileError) {
    // Roll the auth user back so the username is not silently squatted.
    await admin.auth.admin.deleteUser(created.user.id);

    if (profileError.code === UNIQUE_VIOLATION) {
      return json({ error: 'That username is taken.' }, 409, origin);
    }

    console.error('profile insert failed', profileError.message);
    return json({ error: 'Could not create the account.' }, 500, origin);
  }

  return json({ ok: true, username }, 200, origin);
});
