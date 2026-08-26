/**
 * Username-only authentication on Supabase.
 *
 * Supabase Auth has no username provider — it authenticates on email, phone or
 * OAuth. A deterministic internal handle therefore stands in as the login
 * identifier. It is never shown, never typed, and never receives mail: the app
 * has exactly two fields, username and password.
 *
 * Signup goes through an Edge Function so a failed profile insert can roll the
 * auth user back. Sign-in needs no server help.
 *
 * There is no user directory. Username uniqueness is a UNIQUE constraint on
 * profiles.username, so no table exists that anyone could enumerate.
 */

import { supabase, callFunction } from '../supabase';

const INTERNAL_DOMAIN = 'pinkwardrobe.internal';
const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;

export function normaliseUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

export function validateUsername(raw) {
  const username = normaliseUsername(raw);

  if (!username) return 'Pick a username.';
  if (username.length < 3) return 'Usernames need at least 3 characters.';
  if (username.length > 20) return 'Usernames can be at most 20 characters.';
  if (!USERNAME_PATTERN.test(username)) {
    return 'Use letters, numbers, dots and underscores only.';
  }
  return null;
}

function loginHandle(username) {
  return `${username}@${INTERNAL_DOMAIN}`;
}

export async function signUp({ username: rawUsername, password, displayName }) {
  const username = normaliseUsername(rawUsername);

  const problem = validateUsername(username);
  if (problem) throw new Error(problem);

  if (!password || password.length < 8) {
    throw new Error('Passwords need at least 8 characters.');
  }

  await callFunction('signup', { username, password, displayName });

  // The function creates the account but does not return a session, so sign in
  // straight away to get one.
  return signIn({ username, password });
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
    // Deliberately vague. Distinguishing "no such user" from "wrong password"
    // would let anyone probe which usernames exist.
    if (error.message?.includes('Invalid login credentials')) {
      throw new Error('Username or password is incorrect.');
    }
    if (error.status === 429) {
      throw new Error('Too many attempts. Wait a moment and try again.');
    }
    throw error;
  }

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
