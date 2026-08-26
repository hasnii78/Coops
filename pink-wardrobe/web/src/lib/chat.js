/**
 * Two-way chat and outfit sharing.
 *
 * Conversation IDs are the two uids sorted and joined, which makes membership
 * verifiable from the ID alone and guarantees both participants derive the
 * same ID without a lookup.
 */

import {
  addDoc, collection, doc, getDoc, limit, onSnapshot,
  orderBy, query, serverTimestamp, setDoc, updateDoc,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';

import { db, storage } from '../firebase';

export function conversationIdFor(uidA, uidB) {
  return [uidA, uidB].sort().join('__');
}

export async function openConversation(myUid, theirUid) {
  const conversationId = conversationIdFor(myUid, theirUid);
  const conversationRef = doc(db, 'conversations', conversationId);
  const existing = await getDoc(conversationRef);

  if (!existing.exists()) {
    await setDoc(conversationRef, {
      participants: [myUid, theirUid].sort(),
      createdAt: serverTimestamp(),
      lastMessageAt: serverTimestamp(),
    });
  }

  return conversationId;
}

export function subscribeToMessages(conversationId, callback) {
  return onSnapshot(
    query(
      collection(db, 'conversations', conversationId, 'messages'),
      orderBy('createdAt', 'asc'),
      limit(300),
    ),
    (snapshot) => {
      callback(snapshot.docs.map((document) => ({ id: document.id, ...document.data() })));
    },
  );
}

export async function sendText(conversationId, senderId, text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  await addDoc(collection(db, 'conversations', conversationId, 'messages'), {
    type: 'text',
    senderId,
    text: trimmed,
    createdAt: serverTimestamp(),
  });

  await updateDoc(doc(db, 'conversations', conversationId), {
    lastMessageAt: serverTimestamp(),
    lastMessagePreview: trimmed.slice(0, 80),
  });
}

/**
 * Share an outfit into a chat.
 *
 * The composite is copied into `shared/{conversationId}/{senderId}/` rather
 * than linking the sender's private composite path — the recipient must be
 * able to see this one image without gaining read access to the sender's
 * wardrobe.
 */
export async function sendOutfit(conversationId, senderId, { blob, outfitName, message = '' }) {
  const fileName = `${Date.now()}.png`;
  const path = `shared/${conversationId}/${senderId}/${fileName}`;

  await uploadBytes(ref(storage, path), blob, { contentType: 'image/png' });

  await addDoc(collection(db, 'conversations', conversationId, 'messages'), {
    type: 'outfit',
    senderId,
    outfitName: outfitName || 'An outfit',
    imagePath: path,
    text: message.trim(),
    createdAt: serverTimestamp(),
  });

  await updateDoc(doc(db, 'conversations', conversationId), {
    lastMessageAt: serverTimestamp(),
    lastMessagePreview: `Sent an outfit: ${outfitName || 'An outfit'}`,
  });
}

export function resolveSharedImage(path) {
  return getDownloadURL(ref(storage, path));
}
