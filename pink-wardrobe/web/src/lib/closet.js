/**
 * Closet data access and the client half of the garment pipeline.
 */

import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, increment,
  orderBy, query, serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes, deleteObject } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';

import { db, functions, storage } from '../firebase';
import { compressImage } from './images';
import { GENERATION_BLOCKED } from './constants';

const processGarment = httpsCallable(functions, 'process_garment');
const validateAvatar = httpsCallable(functions, 'validate_avatar');
const buildOutfit = httpsCallable(functions, 'build_outfit');

/** Resolve a Storage path to an authenticated download URL. */
export async function resolveUrl(path) {
  if (!path) return null;
  return getDownloadURL(ref(storage, path));
}

// ---------------------------------------------------------------- avatar

export async function uploadAvatar(uid, file) {
  const compressed = await compressImage(file, { maxEdge: 1600, quality: 0.9 });
  const path = `users/${uid}/avatar/master.jpg`;

  await uploadBytes(ref(storage, path), compressed, { contentType: 'image/jpeg' });

  // The server decides whether this photo is good enough to become the
  // permanent master template.
  const { data } = await validateAvatar({ storagePath: path });

  if (!data.accepted) {
    await deleteObject(ref(storage, path)).catch(() => {});
    const error = new Error('That photo will not work as your avatar.');
    error.problems = data.problems;
    throw error;
  }

  return path;
}

// ----------------------------------------------------------------- items

export async function addItem(uid, { file, name, category, price, tags = [] }) {
  if (GENERATION_BLOCKED.includes(category)) {
    // Catalogue-only categories skip the paid pipeline entirely.
    const compressed = await compressImage(file);
    const itemRef = await addDoc(collection(db, 'users', uid, 'items'), {
      name: name?.trim() || 'Untitled',
      category,
      price: Number(price) || 0,
      tags,
      status: 'catalogued',
      wearCount: 0,
      liked: false,
      pinned: false,
      createdAt: serverTimestamp(),
    });
    const photoPath = `users/${uid}/photos/${itemRef.id}.jpg`;
    await uploadBytes(ref(storage, photoPath), compressed, { contentType: 'image/jpeg' });
    await updateDoc(itemRef, { photoPath });
    return itemRef.id;
  }

  const compressed = await compressImage(file);

  const itemRef = await addDoc(collection(db, 'users', uid, 'items'), {
    name: name?.trim() || 'Untitled',
    category,
    price: Number(price) || 0,
    tags,
    status: 'queued',
    wearCount: 0,
    liked: false,
    pinned: false,
    createdAt: serverTimestamp(),
  });

  const photoPath = `users/${uid}/photos/${itemRef.id}.jpg`;
  await uploadBytes(ref(storage, photoPath), compressed, { contentType: 'image/jpeg' });
  await updateDoc(itemRef, { photoPath });

  // Fire the paid pipeline. Errors are recorded on the item document by the
  // function itself, so the UI can surface them without losing the record.
  await processGarment({ itemId: itemRef.id, category, garmentPath: photoPath });

  return itemRef.id;
}

/**
 * Bulk upload. Deliberately sequential, not parallel: each item costs a FASHN
 * credit and holds a 2GB function instance, so firing ten at once risks rate
 * limits and concurrent-instance caps for no user-visible gain.
 */
export async function addItemsBulk(uid, entries, onProgress) {
  const results = [];

  for (const [index, entry] of entries.entries()) {
    try {
      const id = await addItem(uid, entry);
      results.push({ ok: true, id, name: entry.name });
    } catch (error) {
      results.push({ ok: false, error: error.message, name: entry.name });
    }
    onProgress?.(index + 1, entries.length);
  }

  return results;
}

export async function listItems(uid) {
  const snapshot = await getDocs(
    query(collection(db, 'users', uid, 'items'), orderBy('createdAt', 'desc')),
  );
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

export function toggleLike(uid, itemId, liked) {
  return updateDoc(doc(db, 'users', uid, 'items', itemId), { liked });
}

export function togglePin(uid, itemId, pinned) {
  return updateDoc(doc(db, 'users', uid, 'items', itemId), { pinned });
}

export function recordWear(uid, itemId) {
  // "Worn" implies liked, per the brief.
  return updateDoc(doc(db, 'users', uid, 'items', itemId), {
    wearCount: increment(1),
    lastWornAt: serverTimestamp(),
    liked: true,
  });
}

export function retireItem(uid, itemId, reason = 'donated') {
  // Retiring keeps outfit history intact, unlike deleting.
  return updateDoc(doc(db, 'users', uid, 'items', itemId), {
    retired: true,
    retiredReason: reason,
    retiredAt: serverTimestamp(),
  });
}

/** Move an item to the recycle bin. Restorable for 15 days, then purged. */
export async function softDeleteItem(uid, itemId) {
  const itemRef = doc(db, 'users', uid, 'items', itemId);
  const snapshot = await getDoc(itemRef);
  if (!snapshot.exists()) return;

  await setDoc(doc(db, 'users', uid, 'recycleBin', itemId), {
    ...snapshot.data(),
    deletedAt: serverTimestamp(),
  });
  await deleteDoc(itemRef);
}

export async function restoreItem(uid, itemId) {
  const binRef = doc(db, 'users', uid, 'recycleBin', itemId);
  const snapshot = await getDoc(binRef);
  if (!snapshot.exists()) return;

  const { deletedAt, ...data } = snapshot.data();
  await setDoc(doc(db, 'users', uid, 'items', itemId), data);
  await deleteDoc(binRef);
}

export async function listRecycleBin(uid) {
  const snapshot = await getDocs(collection(db, 'users', uid, 'recycleBin'));
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

/** Retry a failed generation. Failed FASHN calls are not billed. */
export function retryItem(uid, item) {
  return processGarment({
    itemId: item.id,
    category: item.category,
    garmentPath: item.photoPath,
  });
}

// ---------------------------------------------------------------- combos

export async function saveCombo(uid, { name, itemIds, compositePath, notes = '' }) {
  const comboRef = await addDoc(collection(db, 'users', uid, 'combos'), {
    name: name?.trim() || 'Untitled outfit',
    itemIds,
    compositePath,
    notes,
    wearCount: 0,
    liked: false,
    pinned: false,
    createdAt: serverTimestamp(),
  });
  return comboRef.id;
}

export async function listCombos(uid) {
  const snapshot = await getDocs(
    query(collection(db, 'users', uid, 'combos'), orderBy('createdAt', 'desc')),
  );
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

export async function wearCombo(uid, combo) {
  await updateDoc(doc(db, 'users', uid, 'combos', combo.id), {
    wearCount: increment(1),
    lastWornAt: serverTimestamp(),
    liked: true,
  });

  await Promise.all(combo.itemIds.map((itemId) => recordWear(uid, itemId)));

  await addDoc(collection(db, 'users', uid, 'history'), {
    comboId: combo.id,
    comboName: combo.name,
    itemIds: combo.itemIds,
    wornAt: serverTimestamp(),
  });
}

/** Server-side blended composite. Cached by item set, so repeats are free. */
export async function requestBlendedComposite(itemIds) {
  const { data } = await buildOutfit({ itemIds });
  return data;
}

export async function listHistory(uid) {
  const snapshot = await getDocs(
    query(collection(db, 'users', uid, 'history'), orderBy('wornAt', 'desc')),
  );
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}

export async function listWishlist(uid) {
  const snapshot = await getDocs(
    query(collection(db, 'users', uid, 'items'), where('wishlist', '==', true)),
  );
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
}
