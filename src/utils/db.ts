import type { ParsedPDF } from './pdfParser';

const DB_NAME = 'ReadPdfDB';
const STORE_NAME = 'parsed_pdfs';
const DB_VERSION = 1;

/**
 * Initializes the IndexedDB database.
 */
export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('IndexedDB failed to open:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

/**
 * Saves a parsed PDF book to IndexedDB.
 */
export async function saveParsedPDF(id: string, pdf: ParsedPDF): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ id, ...pdf });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.error('Failed to save parsed PDF to database:', error);
  }
}

/**
 * Retrieves a parsed PDF book from IndexedDB by its ID.
 */
export async function getParsedPDF(id: string): Promise<ParsedPDF | null> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (request.result) {
          const { id: _, ...pdf } = request.result;
          resolve(pdf as ParsedPDF);
        } else {
          resolve(null);
        }
      };
    });
  } catch (error) {
    console.error('Failed to get parsed PDF from database:', error);
    return null;
  }
}

/**
 * Deletes a parsed PDF book from IndexedDB.
 */
export async function deleteParsedPDF(id: string): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.error('Failed to delete parsed PDF from database:', error);
  }
}
