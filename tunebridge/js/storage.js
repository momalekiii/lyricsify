// Safe wrappers around Web Storage. Everything falls back to memory when storage
// is unavailable (private mode, blocked cookies, Node tests).

const memoryStores = { local: new Map(), session: new Map() };

function webStore(kind) {
  try {
    const store = kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
    if (!store) return null;
    const probe = '__tunebridge_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch (_) {
    return null;
  }
}

function makeStore(kind) {
  return {
    get(key, fallback = null) {
      const store = webStore(kind);
      try {
        const raw = store ? store.getItem(key) : memoryStores[kind].get(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      const store = webStore(kind);
      try {
        if (store) store.setItem(key, raw);
        else memoryStores[kind].set(key, raw);
      } catch (_) {
        memoryStores[kind].set(key, raw);
      }
    },
    remove(key) {
      const store = webStore(kind);
      try {
        if (store) store.removeItem(key);
      } catch (_) {
        /* ignore */
      }
      memoryStores[kind].delete(key);
    },
    keys(prefix = '') {
      const store = webStore(kind);
      const keys = [];
      if (store) {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key && key.startsWith(prefix)) keys.push(key);
        }
      }
      for (const key of memoryStores[kind].keys()) if (key.startsWith(prefix) && !keys.includes(key)) keys.push(key);
      return keys;
    },
  };
}

export const local = makeStore('local');
export const session = makeStore('session');
