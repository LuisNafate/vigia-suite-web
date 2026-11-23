// Almacenamiento del historial en IndexedDB. Sin dependencias: envuelve la API nativa en promesas.
// Esquema v1:
//   assessments      keyPath id, índice createdAt
//   wifiObservations keyPath [assessmentId, seq]
//   bleObservations  keyPath [assessmentId, seq]
// Una evaluación y sus observaciones se guardan y eliminan en una misma transacción.

export const DB_NAME = 'vigia-suite-history';
export const DB_VERSION = 1;
const ASSESSMENTS = 'assessments';
const WIFI = 'wifiObservations';
const BLE = 'bleObservations';
const ALL = [ASSESSMENTS, WIFI, BLE];

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error('La transacción del historial se canceló.'));
  // Al fallar una petición, tx.error todavía es null: el error real está en la petición que lo provocó.
  tx.onerror = event => reject(event.target?.error || tx.error || new Error('Error de almacenamiento del historial.'));
});
const rangeFor = id => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

export function openHistoryDb({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB) return Promise.reject(new Error('Este navegador no ofrece IndexedDB.'));
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(ASSESSMENTS)) db.createObjectStore(ASSESSMENTS, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains(WIFI)) db.createObjectStore(WIFI, { keyPath: ['assessmentId', 'seq'] });
      if (!db.objectStoreNames.contains(BLE)) db.createObjectStore(BLE, { keyPath: ['assessmentId', 'seq'] });
    };
    open.onsuccess = () => resolve(new HistoryStore(open.result));
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Otra pestaña de Vigía mantiene abierta una versión anterior del historial.'));
  });
}

export class HistoryStore {
  constructor(db) { this.db = db; }

  close() { this.db.close(); }

  /** Guarda una evaluación nueva con sus observaciones. Falla si el identificador ya existe. */
  async saveAssessment({ assessment, wifi = [], ble = [] }) {
    const tx = this.db.transaction(ALL, 'readwrite');
    const finished = done(tx);
    tx.objectStore(ASSESSMENTS).add(assessment);
    wifi.forEach((item, seq) => tx.objectStore(WIFI).add({ ...item, assessmentId: assessment.id, seq }));
    ble.forEach((item, seq) => tx.objectStore(BLE).add({ ...item, assessmentId: assessment.id, seq }));
    await finished;
    return assessment.id;
  }

  /** Evaluaciones de la más reciente a la más antigua (sin observaciones). */
  async listAssessments() {
    const tx = this.db.transaction(ASSESSMENTS, 'readonly');
    const items = await request(tx.objectStore(ASSESSMENTS).index('createdAt').getAll());
    return items.reverse();
  }

  async getAssessment(id) {
    const tx = this.db.transaction(ALL, 'readonly');
    const [assessment, wifi, ble] = await Promise.all([
      request(tx.objectStore(ASSESSMENTS).get(id)),
      request(tx.objectStore(WIFI).getAll(rangeFor(id))),
      request(tx.objectStore(BLE).getAll(rangeFor(id))),
    ]);
    if (!assessment) return null;
    const strip = ({ assessmentId, seq, ...item }) => item;
    return { assessment, wifi: wifi.map(strip), ble: ble.map(strip) };
  }

  async deleteAssessments(ids) {
    if (!ids.length) return;
    const tx = this.db.transaction(ALL, 'readwrite');
    const finished = done(tx);
    for (const id of ids) {
      tx.objectStore(ASSESSMENTS).delete(id);
      tx.objectStore(WIFI).delete(rangeFor(id));
      tx.objectStore(BLE).delete(rangeFor(id));
    }
    await finished;
  }

  async deleteAll() {
    const tx = this.db.transaction(ALL, 'readwrite');
    const finished = done(tx);
    ALL.forEach(name => tx.objectStore(name).clear());
    await finished;
  }

  /**
   * Importa evaluaciones históricas sin duplicar: las que ya existen se conservan intactas.
   * Después relee cada registro y compara sus campos para verificar la integridad.
   */
  async importLegacy(records) {
    const tx = this.db.transaction(ASSESSMENTS, 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore(ASSESSMENTS);
    let imported = 0;
    let existing = 0;
    for (const record of records) {
      // get y add en la misma transacción readwrite: ninguna otra escritura puede intercalarse.
      const current = await request(store.get(record.id));
      if (current) existing += 1; else { store.add(record); imported += 1; }
    }
    await finished;
    const verifyTx = this.db.transaction(ASSESSMENTS, 'readonly');
    const stored = await Promise.all(records.map(record => request(verifyTx.objectStore(ASSESSMENTS).get(record.id))));
    const mismatched = records.filter((record, index) => !sameRecord(record, stored[index])).map(record => record.id);
    return { imported, existing, mismatched };
  }
}

function sameRecord(expected, actual) {
  if (!actual) return false;
  return ['id', 'createdAt', 'score', 'level', 'wifiCount', 'bleCount', 'source'].every(key => expected[key] === actual[key]);
}
