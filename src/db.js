// Armazenamento local (IndexedDB): arquivos da biblioteca + estado de cada documento
// (anotações, edições, página atual...). Nada sai do aparelho.

const DB_NAME = 'myreader';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  /** Metadados de todos os arquivos (sem o conteúdo binário). */
  listFiles: () => tx('files', 'readonly', (s) => s.getAll()).then((l) => l || []),
  getFile: (id) => tx('files', 'readonly', (s) => s.get(id)),
  putFile: (rec) => tx('files', 'readwrite', (s) => s.put(rec)),
  async updateFile(id, patch) {
    const rec = await db.getFile(id);
    if (!rec) return;
    Object.assign(rec, patch);
    await db.putFile(rec);
    return rec;
  },
  getBlob: (id) => tx('blobs', 'readonly', (s) => s.get(id)),
  putBlob: (id, blob) => tx('blobs', 'readwrite', (s) => s.put(blob, id)),
  getState: (id) => tx('state', 'readonly', (s) => s.get(id)).then((v) => v || {}),
  putState: (id, state) => tx('state', 'readwrite', (s) => s.put(state, id)),
  async deleteFile(id) {
    await tx('files', 'readwrite', (s) => s.delete(id));
    await tx('blobs', 'readwrite', (s) => s.delete(id));
    await tx('state', 'readwrite', (s) => s.delete(id));
  },
};

// Pede ao navegador para não apagar os dados em caso de pouco espaço.
navigator.storage?.persist?.().catch(() => {});
