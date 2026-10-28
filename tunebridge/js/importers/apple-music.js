// Apple Music / iTunes importers: "File → Library → Export Playlist…" (XML, Plain Text, M3U)
// and "Export Library…" (Library.xml). The XML is an Apple property list; we parse it without
// DOMParser so the same code runs in node tests.
import { emptyResult, makeTrack, makePlaylist, splitArtists, importDelimited } from './text.js';

const ORIGIN = 'Apple Music';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXmlEntities(text = '') {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Minimal Apple plist (XML) → JS value. Supports dict/array/string/integer/real/true/false/date/data. */
export function parsePlist(xml) {
  const tokens = [];
  const re = /<\?[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>|([^<]+)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    if (match[2]) tokens.push({ type: match[1] ? 'close' : match[3] ? 'empty' : 'open', name: match[2].toLowerCase() });
    else if (match[4] !== undefined) tokens.push({ type: 'text', value: match[4] });
  }
  let index = 0;
  const skipText = () => { while (tokens[index]?.type === 'text') index += 1; };
  const readText = () => {
    let text = '';
    while (tokens[index] && tokens[index].type === 'text') { text += tokens[index].value; index += 1; }
    return decodeXmlEntities(text);
  };
  function readValue() {
    skipText();
    const token = tokens[index];
    if (!token) return undefined;
    index += 1;
    if (token.type === 'empty') {
      if (token.name === 'true') return true;
      if (token.name === 'false') return false;
      return token.name === 'dict' ? {} : token.name === 'array' ? [] : '';
    }
    if (token.type !== 'open') return undefined;
    switch (token.name) {
      case 'plist': { const value = readValue(); skipText(); if (tokens[index]?.type === 'close') index += 1; return value; }
      case 'dict': {
        const dict = {};
        for (;;) {
          skipText();
          const next = tokens[index];
          if (!next || (next.type === 'close' && next.name === 'dict')) { index += 1; return dict; }
          if (next.type === 'open' && next.name === 'key') {
            index += 1;
            const key = readText();
            skipText(); if (tokens[index]?.type === 'close') index += 1; // </key>
            dict[key] = readValue();
          } else index += 1; // tolerate stray nodes
        }
      }
      case 'array': {
        const array = [];
        for (;;) {
          skipText();
          const next = tokens[index];
          if (!next || (next.type === 'close' && next.name === 'array')) { index += 1; return array; }
          array.push(readValue());
        }
      }
      default: {
        const text = readText();
        skipText(); if (tokens[index]?.type === 'close') index += 1;
        if (token.name === 'integer') return Number(text);
        if (token.name === 'real') return Number(text);
        return text; // string, date, data
      }
    }
  }
  return readValue();
}

export function looksLikePlist(text = '') {
  return /<plist[\s>]/i.test(text.slice(0, 4000)) || /<key>Tracks<\/key>/.test(text.slice(0, 20000));
}

const SKIPPED_KINDS = new Set(['Podcast', 'Audiobook', 'Voice Memo']);

function toTrack(info = {}) {
  if (!info.Name) return null;
  if (info.Podcast || info['Has Video'] === true && info['Music Video'] !== true && info.Kind && /video/i.test(info.Kind) && !/music/i.test(info.Genre || '')) return null;
  if (info.Kind && SKIPPED_KINDS.has(info.Kind)) return null;
  if (info.Genre && /podcast|audiobook/i.test(info.Genre)) return null;
  return makeTrack({
    id: info['Persistent ID'] ? `apple:${info['Persistent ID']}` : '',
    title: info.Name,
    artists: splitArtists(info.Artist || info['Album Artist'] || ''),
    album: info.Album || '',
    durationMs: Number(info['Total Time']) || 0,
    isrc: info.ISRC || '',
  }, ORIGIN);
}

/** Export Playlist… (XML) or Export Library… (Library.xml). */
export function importApplePlist(xml, { fileName = 'Playlist.xml' } = {}) {
  const result = emptyResult();
  const root = parsePlist(xml);
  if (!root || typeof root !== 'object') { result.notes.push(`${fileName}: not an iTunes/Music XML export.`); return result; }
  const trackById = new Map();
  for (const [id, info] of Object.entries(root.Tracks || {})) {
    const track = toTrack(info);
    if (track) trackById.set(String(id), track);
  }
  const playlists = Array.isArray(root.Playlists) ? root.Playlists : [];
  let regular = 0;
  for (const playlist of playlists) {
    if (!playlist || playlist.Master || playlist.Folder || playlist['Distinguished Kind'] !== undefined || playlist.Name === 'Library') continue;
    const tracks = (playlist['Playlist Items'] || []).map((item) => trackById.get(String(item?.['Track ID']))).filter(Boolean);
    if (!tracks.length) continue;
    regular += 1;
    result.playlists.push(makePlaylist(playlist.Name, tracks, ORIGIN, { id: playlist['Playlist Persistent ID'] ? `apple:playlist:${playlist['Playlist Persistent ID']}` : '', description: playlist.Description || '' }));
  }
  if (!regular && trackById.size) {
    // A whole-library export without user playlists: offer every song as one special playlist.
    result.playlists.push(makePlaylist('Apple Music library (all songs)', [...trackById.values()], ORIGIN, { id: 'apple:library', special: true }));
  }
  // Saved albums: group library tracks by album when a full library was exported.
  if (root.Tracks && Object.keys(root.Tracks).length > 50 && playlists.some((p) => p?.Master)) {
    const albums = new Map();
    for (const info of Object.values(root.Tracks)) {
      if (!info?.Album || !toTrack(info)) continue;
      const key = `${info['Album Artist'] || info.Artist || ''}\u0000${info.Album}`;
      const entry = albums.get(key) || { id: `apple:album:${albums.size + 1}`, title: info.Album, artists: splitArtists(info['Album Artist'] || info.Artist || ''), upc: '', year: info.Year ? String(info.Year) : '', trackCount: 0, total: Number(info['Track Count']) || 0, image: '', url: '' };
      entry.trackCount += 1;
      albums.set(key, entry);
    }
    for (const album of albums.values()) {
      // Only albums the person has (nearly) completely — single songs from an album aren't "saved albums".
      if (album.trackCount >= 4 && (!album.total || album.trackCount >= album.total * 0.8)) result.albums.push({ ...album, trackCount: album.total || album.trackCount });
    }
    if (result.albums.length) result.notes.push(`${fileName}: ${result.albums.length} complete albums detected in the library.`);
  }
  return result;
}

/** Export Playlist… → Plain Text (tab-separated, UTF-16). */
export function importAppleText(text, options = {}) {
  return importDelimited(text, { ...options, origin: ORIGIN });
}

export function looksLikeAppleText(text = '') {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  return firstLine.includes('\t') && /^Name\tArtist\t/i.test(firstLine.replace(/^\uFEFF/, ''));
}
