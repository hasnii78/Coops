/**
 * Username-only authentication.
 *
 * Supabase Auth has no username provider — it authenticates on email, phone or
 * OAuth — so a deterministic internal handle stands in as the login
 * identifier. It is never shown, never typed and never receives mail: the app
 * has two fields, username and password.
 *
 * Signup runs entirely against Supabase's own auth and REST endpoints. It used
 * to go through an Edge Function so that a taken username could delete the
 * just-created auth user, which needs the service role. That rollback was not
 * worth what it cost: the function sat on the critical path of the very first
 * thing a new user does, and every one of its failure modes — a crashed
 * preflight, an unresolvable import, a bad gateway path — surfaced in the
 * browser as the same unreadable "could not reach the server".
 *
 * Without the rollback, a conflicting username leaves an auth account with no
 * profile row. That is recoverable rather than fatal: `ensureProfile` claims a
 * username for any account that lacks one, so the next sign-in finishes the job.
 * Uniqueness is still enforced by the UNIQUE constraint on profiles.username,
 * and there is still no readable directory of users.
 */

import { supabase } from '../supabase';

const INTERNAL_DOMAIN = 'pinkwardrobe.internal';
const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;

// Postgres unique-violation SQLSTATE.
const UNIQUE_VIOLATION = '23505';

export function normaliseUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function validateUsername(raw) {
  const username = normaliseUsername(raw);

  if (!username) return 'Pick a username.';
  if (username.length < 3) return 'Usernames need at least 3 characters.';
  if (username.length > 20) return 'Usernames can be at most 20 characters.';
  if (!USERNAME_PATTERN.test(username)) {
    return 'Use lowercase letters, numbers, dots and underscores only.';
  }
  return null;
}

function loginHandle(username) {
  return `${username}@${INTERNAL_DOMAIN}`;
}

/**
 * Give the signed-in account a profile row if it has none.
 *
 * Runs after both signup and sign-in, so an account left profile-less by a
 * username collision repairs itself rather than becoming unusable.
 */
async function ensureProfile(userId, username, displayName) {
  const { data: existing, error: readError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('id', userId)
    .maybeSingle();

  if (readError) throw readError;
  if (existing) return existing;

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      id: userId,
      username,
      display_name: displayName?.trim() || username,
    })
    .select()
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const conflict = new Error('That username is taken. Pick another one.');
      conflict.usernameTaken = true;
      throw conflict;
    }
    throw error;
  }

  return data;
}

export async function signUp({ username: rawUsername, password, displayName }) {
  const username = normaliseUsername(rawUsername);

  const problem = validateUsername(username);
  if (problem) throw new Error(problem);

  if (!password || password.length < 8) {
    throw new Error('Passwords need at least 8 characters.');
  }

  const { data, error } = await supabase.auth.signUp({
    email: loginHandle(username),
    password,
    options: { data: { username } },
  });

  if (error) {
    if (/already registered|already exists/i.test(error.message)) {
      throw new Error('That username is taken.');
    }
    if (/signups not allowed|signup is disabled/i.test(error.message)) {
      throw new Error(
        'Account creation is switched off for this project. Turn on ' +
          'Authentication → Providers → Email → Enable signup.',
      );
    }
    if (/password/i.test(error.message)) {
      throw new Error('Pick a stronger password.');
    }
    throw error;
  }

  if (!data.user) {
    throw new Error('Sign-up did not return an account. Try again.');
  }

  // With a synthetic, undeliverable address there is nothing to confirm, so
  // confirmations must be off for the project. Say so plainly rather than
  // leaving an account that can never sign in.
  if (!data.session) {
    throw new Error(
      'Account created but not usable yet: email confirmation is switched on. ' +
        'Turn off Authentication → Providers → Email → Confirm email, then sign in.',
    );
  }

  await ensureProfile(data.user.id, username, displayName);

  return data.user;
}

export async function signIn({ username: rawUsername, password }) {
  const username = normaliseUsername(rawUsername);

  if (!username || !password) {
    throw new Error('Enter your username and password.');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: loginHandle(username),
    password,
  });

  if (error) {
    // Deliberately vague: distinguishing "no such user" from "wrong password"
    // would let anyone probe which usernames exist.
    if (/invalid login credentials/i.test(error.message)) {
      throw new Error('Username or password is incorrect.');
    }
    if (error.status === 429) {
      throw new Error('Too many attempts. Wait a moment and try again.');
    }
    throw error;
  }

  // Finishes signup for an account whose profile insert did not complete.
  await ensureProfile(data.user.id, username);

  return data.user;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function changePassword(newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('Passwords need at least 8 characters.');
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}
