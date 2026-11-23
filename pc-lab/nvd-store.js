// Caché local de respuestas de NVD en IndexedDB. Es una base propia («vigia-nvd»): no comparte almacén ni versión
// con el historial de evaluaciones. Sólo guarda respuestas públicas de NVD, la URL consultada y la fecha de consulta.

export const NVD_DB_NAME = 'vigia-nvd';
export const NVD_DB_VERSION = 1;
const STORE = 'responses';
/** Máximo de respuestas guardadas; al superarlo se retiran las consultadas hace más tiempo. */
export const MAX_ENTRIES = 60;

const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export async function openNvdStore({ name = NVD_DB_NAME, indexedDB = globalThis.indexedDB, maxEntries = MAX_ENTRIES } = {}) {
  if (!indexedDB) throw new Error('IndexedDB no está disponible.');
  const open = indexedDB.open(name, NVD_DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'url' }).createIndex('fetchedAt', 'fetchedAt');
  };
  const db = await request(open);
  const tx = mode => db.transaction(STORE, mode).objectStore(STORE);

  async function prune() {
    const keys = await request(tx('readonly').index('fetchedAt').getAllKeys());
    const excess = keys.length - maxEntries;
    if (excess <= 0) return;
    // getAllKeys del índice devuelve las claves primarias ordenadas por fetchedAt ascendente.
    const store = tx('readwrite');
    await Promise.all(keys.slice(0, excess).map(key => request(store.delete(key))));
  }

  return {
    async get(url) { return (await request(tx('readonly').get(url))) ?? null; },
    async put(entry) { await request(tx('readwrite').put({ url: entry.url, data: entry.data, fetchedAt: entry.fetchedAt })); await prune(); },
    async clear() { await request(tx('readwrite').clear()); },
    async count() { return request(tx('readonly').count()); },
    close() { db.close(); },
  };
}
