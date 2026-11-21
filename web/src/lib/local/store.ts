// Where a local account lives: one record in this browser's IndexedDB. Nothing here is sent
// anywhere; it leaves the device only when the person moves it online (migrate.ts).
//
// Every change reads the record fresh, changes it and writes it back, one change at a time, so two
// open tabs don't overwrite each other's drinks with stale copies.

import { isLocalData, type LocalData } from "./core.ts";

const DB_NAME = "kili-local";
const STORE = "account";
const KEY = "me";

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  }).catch((e) => {
    opening = null;
    throw e;
  }));
}

function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = op(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB failed"));
      }),
  );
}

/** Whether this browser can keep a local account at all (not in some private modes). */
export async function localStorageWorks(): Promise<boolean> {
  try {
    await db();
    return true;
  } catch {
    return false;
  }
}

/** The local account, or null when there is none (or storage doesn't work here). */
export async function loadLocal(): Promise<LocalData | null> {
  try {
    const v = await run("readonly", (s) => s.get(KEY));
    return isLocalData(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveLocal(data: LocalData): Promise<unknown> {
  return run("readwrite", (s) => s.put(data, KEY));
}

export async function clearLocal(): Promise<void> {
  await run("readwrite", (s) => s.delete(KEY)).catch(() => {});
}

let queue: Promise<unknown> = Promise.resolve();

/** Changes the stored account with `change` and saves it; changes run one after another. */
export function mutate<T>(change: (data: LocalData) => T | Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const data = await loadLocal();
    if (!data) throw new Error("no local account");
    const result = await change(data);
    await saveLocal(data);
    return result;
  });
  queue = next.catch(() => {});
  return next;
}

/**
 * Asks the browser not to clear this site's storage when space runs low. Browsers decide by
 * themselves (an installed app usually gets it); the answer only changes what Settings says.
 */
export async function askToPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
