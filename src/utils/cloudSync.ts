import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  deleteDoc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, googleProvider, isFirebaseConfigured } from './firebase';
import type { ParsedPDF } from './pdfParser';

export interface CloudBookMetadata {
  id: string;
  title: string;
  totalPages: number;
  lastReadDate: string;
  progressPercentage: number;
  lastActiveParagraphId: string | null;
  updatedAtMs: number; // Date.now() la ultima actualizare - ne spune care versiune (local/cloud) e mai recenta
}

export interface CloudUserSettings {
  name: string;
  theme: string;
  fontSize: number;
  lineSpacing: number;
  fontFamily: string;
  isBionic: boolean;
  layoutMode: 'scroll' | 'page';
}

// --------------------------------------------------------------------------
// AUTH
// --------------------------------------------------------------------------

export async function signInWithGoogle(): Promise<User | null> {
  if (!auth) return null;
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutUser(): Promise<void> {
  if (!auth) return;
  await signOut(auth);
}

export function subscribeToAuthChanges(callback: (user: User | null) => void): () => void {
  if (!auth) return () => {};
  return onAuthStateChanged(auth, callback);
}

// --------------------------------------------------------------------------
// BOOK METADATA (Firestore) - lista rapida de carti + progres
// --------------------------------------------------------------------------

export async function fetchCloudBookList(uid: string): Promise<CloudBookMetadata[]> {
  if (!db) return [];
  const snapshot = await getDocs(collection(db, 'users', uid, 'books'));
  return snapshot.docs.map(d => d.data() as CloudBookMetadata);
}

export async function saveCloudBookMetadata(uid: string, metadata: CloudBookMetadata): Promise<void> {
  if (!db) return;
  await setDoc(doc(db, 'users', uid, 'books', metadata.id), {
    ...metadata,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteCloudBookMetadata(uid: string, bookId: string): Promise<void> {
  if (!db) return;
  await deleteDoc(doc(db, 'users', uid, 'books', bookId));
}

// --------------------------------------------------------------------------
// USER SETTINGS (Firestore) - nume, tema, font, spatiere, bionic, layout
// --------------------------------------------------------------------------

export async function fetchCloudSettings(uid: string): Promise<CloudUserSettings | null> {
  if (!db) return null;
  const snap = await getDoc(doc(db, 'users', uid, 'settings', 'preferences'));
  return snap.exists() ? (snap.data() as CloudUserSettings) : null;
}

export async function saveCloudSettings(uid: string, settings: CloudUserSettings): Promise<void> {
  if (!db) return;
  await setDoc(doc(db, 'users', uid, 'settings', 'preferences'), {
    ...settings,
    updatedAt: serverTimestamp(),
  });
}

// --------------------------------------------------------------------------
// BOOK CONTENT (tot in Firestore, "taiat" in bucati) - fara Firebase Storage,
// ca sa nu fie nevoie de planul Blaze (cu card atasat). Firestore limiteaza
// fiecare document la ~1MB, deci textul complet al cartii e impartit in
// bucati mici, salvate intr-o subcolectie, si reasamblate la citire.
// --------------------------------------------------------------------------

const CHUNK_SIZE = 700_000; // caractere per bucata, sub limita de 1MiB/document
const chunkId = (i: number) => `c${String(i).padStart(5, '0')}`;

export async function uploadBookContent(uid: string, bookId: string, parsed: ParsedPDF): Promise<void> {
  if (!db) return;
  const json = JSON.stringify(parsed);
  const totalChunks = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));

  // Stergem intai bucatile vechi (daca reincarci aceeasi carte cu continut diferit,
  // ca sa nu ramana bucati "orfane" de la o versiune mai lunga anterioara).
  await deleteBookContent(uid, bookId);

  const batch = writeBatch(db);
  for (let i = 0; i < totalChunks; i++) {
    const chunkData = json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    batch.set(doc(db, 'users', uid, 'books', bookId, 'chunks', chunkId(i)), { data: chunkData });
  }
  await batch.commit();
}

export async function downloadBookContent(uid: string, bookId: string): Promise<ParsedPDF | null> {
  if (!db) return null;
  try {
    const snapshot = await getDocs(collection(db, 'users', uid, 'books', bookId, 'chunks'));
    if (snapshot.empty) return null;

    const sortedDocs = [...snapshot.docs].sort((a, b) => a.id.localeCompare(b.id));
    const json = sortedDocs.map(d => (d.data() as { data: string }).data).join('');
    return JSON.parse(json) as ParsedPDF;
  } catch (e) {
    console.warn('Cartea nu a fost gasita in cloud:', bookId, e);
    return null;
  }
}

export async function deleteBookContent(uid: string, bookId: string): Promise<void> {
  if (!db) return;
  try {
    const snapshot = await getDocs(collection(db, 'users', uid, 'books', bookId, 'chunks'));
    if (snapshot.empty) return;
    const batch = writeBatch(db);
    snapshot.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  } catch (e) {
    console.warn('Nu s-a putut sterge continutul din cloud:', bookId, e);
  }
}

// --------------------------------------------------------------------------
// COMBINED HELPERS
// --------------------------------------------------------------------------

/** Uploads both metadata + full content for a book (folosit la incarcare initiala) */
export async function uploadFullBookToCloud(
  uid: string,
  metadata: CloudBookMetadata,
  parsed: ParsedPDF
): Promise<void> {
  await uploadBookContent(uid, metadata.id, parsed);
  await saveCloudBookMetadata(uid, metadata);
}

export async function deleteFullBookFromCloud(uid: string, bookId: string): Promise<void> {
  await Promise.all([
    deleteCloudBookMetadata(uid, bookId),
    deleteBookContent(uid, bookId),
  ]);
}

export { isFirebaseConfigured };
export type { User };
