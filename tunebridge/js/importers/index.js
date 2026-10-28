// Entry point for file imports: sniffs each file (ZIP, JSON, XML, CSV/TSV, TXT, M3U) and routes it
// to the right parser. Works with File objects in the browser and {name, arrayBuffer()} in tests.
import { decodeText, importDelimited, importPlainText, importM3u, emptyResult, mergeResults } from './text.js';
import { importSpotifyJson } from './spotify-export.js';
import { importApplePlist, importAppleText, looksLikePlist, looksLikeAppleText } from './apple-music.js';
import { isZip, listZipEntries, readZipEntry } from './zip.js';

export { classifyLink, importDeezerLink, LINK_HINTS } from './links.js';

const MAX_ZIP_DEPTH = 2;
const IGNORED_IN_ZIP = /(^|\/)(__MACOSX|\.DS_Store|StreamingHistory|Streaming_History|SearchQueries|Inferences|Identity|Payments|Userdata|Follow|Marquee|Wrapped|Identifiers|YourLibrary\.json\.bak)/i;
const TEXT_EXTENSIONS = /\.(csv|tsv|txt|text|m3u|m3u8|xml|json)$/i;

function extension(name = '') {
  return (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
}

/** Imports one in-memory file. Returns { playlists, albums, artists, notes }. */
export async function importBytes(name, bytes, { depth = 0 } = {}) {
  const result = emptyResult();
  const ext = extension(name);
  if (isZip(bytes)) {
    if (depth >= MAX_ZIP_DEPTH) { result.notes.push(`${name}: nested archive skipped.`); return result; }
    const entries = listZipEntries(bytes).filter((e) => !e.isDirectory && !IGNORED_IN_ZIP.test(e.name) && (TEXT_EXTENSIONS.test(e.name) || /\.zip$/i.test(e.name)));
    if (!entries.length) { result.notes.push(`${name}: no playlist files found inside the archive.`); return result; }
    let used = 0;
    for (const entry of entries) {
      if (entry.size > 200 * 1024 * 1024) { result.notes.push(`${entry.name}: too large, skipped.`); continue; }
      const data = await readZipEntry(bytes, entry);
      const sub = await importBytes(entry.name, data, { depth: depth + 1 });
      if (sub.playlists.length || sub.albums.length || sub.artists.length) used += 1;
      mergeResults(result, sub);
    }
    if (!used) result.notes.push(`${name}: nothing usable found. Spotify packages need Playlist1.json / YourLibrary.json; Takeout needs "music library songs" CSVs.`);
    return result;
  }

  const text = decodeText(bytes);
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  const label = name.replace(/^.*\//, '');

  if (ext === 'json' || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data;
    try { data = JSON.parse(trimmed); } catch (_) { result.notes.push(`${label}: not valid JSON.`); return result; }
    const spotify = importSpotifyJson(data, { fileName: label });
    if (spotify) return spotify;
    if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
      // Generic JSON array of {title/name, artist, album, …} objects → treat like a CSV
      const keys = Object.keys(data[0]);
      const rows = [keys.join('\t'), ...data.map((row) => keys.map((k) => String(row[k] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'))].join('\n');
      return importDelimited(rows, { fileName: label, origin: 'JSON' });
    }
    result.notes.push(`${label}: unrecognised JSON (expected a Spotify data export).`);
    return result;
  }
  if (ext === 'xml' || looksLikePlist(trimmed)) return importApplePlist(trimmed, { fileName: label });
  if (ext === 'm3u' || ext === 'm3u8' || /^#EXTM3U/i.test(trimmed)) return importM3u(trimmed, { fileName: label });
  if (looksLikeAppleText(trimmed)) return importAppleText(trimmed, { fileName: label });
  if (ext === 'csv' || ext === 'tsv' || /[\t,;]/.test(trimmed.split(/\r?\n/, 1)[0]) && trimmed.split(/\r?\n/).length > 1 && ext !== 'txt') {
    return importDelimited(trimmed, { fileName: label, origin: /takeout|youtube/i.test(name) ? 'YouTube Music' : 'CSV' });
  }
  return importPlainText(trimmed, { fileName: label });
}

/** Imports a list of File objects (or {name, arrayBuffer()} look-alikes). */
export async function importFiles(files, { onProgress } = {}) {
  const result = emptyResult();
  const list = Array.from(files || []);
  let done = 0;
  for (const file of list) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      mergeResults(result, await importBytes(file.name || 'file', bytes));
    } catch (error) {
      result.notes.push(`${file.name || 'file'}: ${error.message || 'could not be read'}`);
    }
    done += 1;
    onProgress?.(done, list.length);
  }
  return result;
}

export function summarize(library) {
  const parts = [];
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const trackTotal = (library?.playlists || []).reduce((sum, p) => sum + (p.tracks?.length || 0), 0);
  if (library?.playlists?.length) parts.push(`${count(library.playlists.length, 'playlist')} (${count(trackTotal, 'song')})`);
  if (library?.albums?.length) parts.push(count(library.albums.length, 'album'));
  if (library?.artists?.length) parts.push(count(library.artists.length, 'artist'));
  return parts.join(' · ');
}
