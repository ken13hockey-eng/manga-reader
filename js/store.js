// Small persistence helpers. Only metadata, cover thumbnails and reading
// progress are stored on the device; pages are always streamed from Drive.

export function getJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
export function setJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open('manga-reader', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => {
        r.result.createObjectStore('covers');
        r.result.createObjectStore('pages');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch(() => null);
  }
  return dbp;
}

export async function idbGet(store, key) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((res) => {
    try {
      const r = d.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    } catch { res(undefined); }
  });
}
export async function idbSet(store, key, value) {
  const d = await db();
  if (!d) return;
  return new Promise((res) => {
    try {
      const t = d.transaction(store, 'readwrite');
      t.objectStore(store).put(value, key);
      t.oncomplete = () => res();
      t.onerror = () => res();
    } catch { res(); }
  });
}
export async function idbClear(store) {
  const d = await db();
  if (!d) return;
  return new Promise((res) => {
    try {
      const t = d.transaction(store, 'readwrite');
      t.objectStore(store).clear();
      t.oncomplete = () => res();
      t.onerror = () => res();
    } catch { res(); }
  });
}

// Reading progress: { [volumeId]: { page, total, t } }
export const progress = {
  all() { return getJSON('mr.progress', {}); },
  get(id) { return this.all()[id] || null; },
  set(id, page, total) {
    const all = this.all();
    all[id] = { page, total, t: Date.now() };
    setJSON('mr.progress', all);
  },
  mark(id, done, total) {
    const all = this.all();
    if (done) all[id] = { page: Math.max(0, (total || 1) - 1), total: total || 1, t: Date.now() };
    else delete all[id];
    setJSON('mr.progress', all);
  },
};

export const settings = {
  defaults: { dir: 'rtl', spread: 'auto', coverAlone: true, sort: 'name' },
  get() { return { ...this.defaults, ...getJSON('mr.settings', {}) }; },
  set(patch) { setJSON('mr.settings', { ...this.get(), ...patch }); },
};
