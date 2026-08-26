/**
 * Username-only authentication.
 *
 * Firebase Auth is email-based natively, so signup registers a synthetic
 * internal address derived from the username. The user never sees, types or
 * receives anything at that address — it exists purely to satisfy the Auth
 * API. No email field appears anywhere in the UI.
 *
 * Because the address is synthetic and undeliverable, there is no password
 * reset by email. Account recovery is a deliberate non-feature for a two-user
 * private app; see docs/DEPLOYMENT.md if that ever needs revisiting.
 */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore';

import { auth, db } from '../firebase';

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

function syntheticEmail(username) {
  return `${username}@${INTERNAL_DOMAIN}`;
}

export async function isUsernameAvailable(raw) {
  const username = normaliseUsername(raw);
  const snapshot = await getDoc(doc(db, 'usernames', username));
  return !snapshot.exists();
}

/**
 * Create an account.
 *
 * Uniqueness is enforced inside a transaction on the `usernames` document, so
 * two people racing for the same name cannot both win. The Auth account is
 * created first because the transaction needs an authenticated uid to write.
 */
export async function signUp({ username: rawUsername, password, displayName }) {
  const username = normaliseUsername(rawUsername);

  const problem = validateUsername(username);
  if (problem) throw new Error(problem);

  if (!password || password.length < 6) {
    throw new Error('Passwords need at least 6 characters.');
  }

  if (!(await isUsernameAvailable(username))) {
    throw new Error('That username is taken.');
  }

  const credential = await createUserWithEmailAndPassword(
    auth,
    syntheticEmail(username),
    password,
  ).catch((error) => {
    if (error.code === 'auth/email-already-in-use') {
      throw new Error('That username is taken.');
    }
    if (error.code === 'auth/weak-password') {
      throw new Error('Pick a stronger password.');
    }
    throw error;
  });

  const { uid } = credential.user;

  try {
    await runTransaction(db, async (transaction) => {
      const usernameRef = doc(db, 'usernames', username);
      const existing = await transaction.get(usernameRef);

      if (existing.exists()) {
        throw new Error('That username is taken.');
      }

      // The directory holds these two fields and nothing else — it is the
      // only publicly readable collection in the database.
      transaction.set(usernameRef, { username, uid });

      transaction.set(doc(db, 'users', uid), {
        username,
        displayName: displayName?.trim() || username,
        createdAt: serverTimestamp(),
        theme: 'pink',
        textSize: 'medium',
        darkMode: false,
        onboarded: false,
      });
    });
  } catch (error) {
    // The Auth account exists but has no profile — leaving it would silently
    // squat the username on the next attempt.
    await credential.user.delete().catch(() => {});
    throw error;
  }

  await updateProfile(credential.user, {
    displayName: displayName?.trim() || username,
  });

  return credential.user;
}

export async function signIn({ username: rawUsername, password }) {
  const username = normaliseUsername(rawUsername);

  if (!username || !password) {
    throw new Error('Enter your username and password.');
  }

  return signInWithEmailAndPassword(auth, syntheticEmail(username), password).catch(
    (error) => {
      // Deliberately vague: distinguishing "no such user" from "wrong
      // password" would turn the public username directory into an oracle.
      if (
        ['auth/user-not-found', 'auth/wrong-password', 'auth/invalid-credential'].includes(
          error.code,
        )
      ) {
        throw new Error('Username or password is incorrect.');
      }
      if (error.code === 'auth/too-many-requests') {
        throw new Error('Too many attempts. Wait a moment and try again.');
      }
      throw error;
    },
  );
}

export function signOut() {
  return fbSignOut(auth);
}

/** Look up another user by username, for chat and Send to. */
export async function findUserByUsername(raw) {
  const username = normaliseUsername(raw);
  if (!username) return null;

  const snapshot = await getDoc(doc(db, 'usernames', username));
  return snapshot.exists() ? snapshot.data() : null;
}
