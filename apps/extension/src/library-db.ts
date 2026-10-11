// The library in IndexedDB, one record per series, so saving progress rewrites one entry rather than
// the whole library. Pages can't watch IndexedDB, so every write also bumps LIBRARY_CHANGED_KEY in
// chrome.storage.local, which they listen to.
import type { LibraryEntry, LibraryStore } from '@onidoku/core';
import { LEGACY_LIBRARY_KEY, LIBRARY_CHANGED_KEY } from './keys';

const DB_NAME = 'onidoku';
const STORE = 'library';

let opening: Promise<IDBDatabase> | undefined;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('library write aborted'));
  });
}

function db(): Promise<IDBDatabase> {
  opening ??= (async () => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'series.id' });
    const database = await request(req);
    // Reopen next time if the browser closes it or a newer version needs it.
    database.onclose = () => (opening = undefined);
    database.onversionchange = () => {
      database.close();
      opening = undefined;
    };
    await migrate(database);
    return database;
  })();
  opening.catch(() => (opening = undefined));
  return opening;
}

/** Moves a library kept in chrome.storage.local (before IndexedDB) over, once. */
async function migrate(database: IDBDatabase): Promise<void> {
  const legacy = (await chrome.storage.local.get(LEGACY_LIBRARY_KEY))[LEGACY_LIBRARY_KEY] as Record<string, LibraryEntry> | undefined;
  if (!legacy) return;
  const tx = database.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const existing = new Set(await request(store.getAllKeys()));
  // Entries already moved win: a run cut short before the key was removed may have been followed by reading.
  for (const entry of Object.values(legacy)) if (!existing.has(entry.series.id)) store.put(entry);
  await done(tx);
  await chrome.storage.local.remove(LEGACY_LIBRARY_KEY);
}

export const libraryDb: LibraryStore = {
  async all() {
    return request((await db()).transaction(STORE).objectStore(STORE).getAll());
  },
  async get(id) {
    return request((await db()).transaction(STORE).objectStore(STORE).get(id));
  },
  async write(put, remove) {
    const tx = (await db()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const entry of put) store.put(entry);
    for (const id of remove) store.delete(id);
    await done(tx);
    await chrome.storage.local.set({ [LIBRARY_CHANGED_KEY]: crypto.randomUUID() });
  },
};
