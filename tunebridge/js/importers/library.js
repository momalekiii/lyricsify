// The imported library: kept in memory and persisted in IndexedDB so it survives the page
// navigation that logging in to the destination service causes. Falls back to sessionStorage
// (small libraries only) when IndexedDB is unavailable.
import { session } from '../storage.js';

const DB_NAME = 'tunebridge-import';
const STORE = 'library';
const KEY = 'current';
const SESSION_KEY = 'tunebridge.import.v1';

let current = null; // { playlists, albums, artists, sources: [], importedAt }
let loaded = false;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(null);
  });
}

function withStore(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    if (!db) { resolve(undefined); return; }
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}

export function emptyLibrary() {
  return { playlists: [], albums: [], artists: [], sources: [], importedAt: 0 };
}

/** Call once at start-up; afterwards getLibrary() is synchronous. */
export async function loadLibrary() {
  if (loaded) return current;
  loaded = true;
  try {
    current = (await withStore('readonly', (store) => store.get(KEY))) || null;
  } catch (_) {
    current = null;
  }
  if (!current) current = session.get(SESSION_KEY, null);
  return current;
}

export function getLibrary() {
  return current;
}

export function hasLibrary() {
  return Boolean(current && (current.playlists?.length || current.albums?.length || current.artists?.length));
}

async function persist() {
  if (typeof indexedDB !== 'undefined') {
    try {
      if (current) await withStore('readwrite', (store) => store.put(current, KEY));
      else await withStore('readwrite', (store) => store.delete(KEY));
      try { session.remove(SESSION_KEY); } catch (_) { /* ignore */ }
      return;
    } catch (_) {
      // IndexedDB refused (private mode, quota) — fall through to sessionStorage.
    }
  }
  // sessionStorage holds a few MB: fine for most exports; otherwise the library lives in memory only.
  try { if (current) session.set(SESSION_KEY, current); else session.remove(SESSION_KEY); } catch (_) { /* memory only */ }
}

/** Appends an import result (from importFiles/importDeezerLink) to the library and persists it. */
export async function addToLibrary(result, sourceLabel) {
  const library = current || emptyLibrary();
  const seenPlaylist = new Set(library.playlists.map((p) => p.id));
  for (const playlist of result.playlists || []) {
    if (seenPlaylist.has(playlist.id)) {
      const index = library.playlists.findIndex((p) => p.id === playlist.id);
      library.playlists[index] = playlist; // re-import replaces
    } else library.playlists.push(playlist);
  }
  const albumKey = (a) => `${a.title}\u0000${(a.artists || []).join(',')}`.toLowerCase();
  const seenAlbums = new Set(library.albums.map(albumKey));
  for (const album of result.albums || []) if (!seenAlbums.has(albumKey(album))) { seenAlbums.add(albumKey(album)); library.albums.push(album); }
  const seenArtists = new Set(library.artists.map((a) => a.name.toLowerCase()));
  for (const artist of result.artists || []) if (!seenArtists.has(artist.name.toLowerCase())) { seenArtists.add(artist.name.toLowerCase()); library.artists.push(artist); }
  if (sourceLabel && !library.sources.includes(sourceLabel)) library.sources.push(sourceLabel);
  library.importedAt = Date.now();
  current = library;
  await persist();
  return library;
}

export async function clearLibrary() {
  current = null;
  await persist();
}
