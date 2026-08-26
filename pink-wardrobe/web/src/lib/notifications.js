/**
 * Firebase Cloud Messaging registration.
 *
 * Tokens are stored on the user document so the notify_on_message function can
 * reach every device the user has installed the app on.
 */

import { getToken, onMessage } from 'firebase/messaging';
import { arrayUnion, doc, updateDoc } from 'firebase/firestore';

import { db, getMessagingIfSupported } from '../firebase';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export async function registerForPush(uid) {
  if (!uid || !VAPID_KEY) return null;

  const messaging = await getMessagingIfSupported();
  if (!messaging) return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (!token) return null;

    await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayUnion(token) });
    return token;
  } catch {
    // A missing service worker or blocked notification channel should never
    // take down the app.
    return null;
  }
}

export async function onForegroundMessage(handler) {
  const messaging = await getMessagingIfSupported();
  if (!messaging) return () => {};
  return onMessage(messaging, handler);
}
