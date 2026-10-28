// Text-based importers: CSV/TSV with header detection, plain "Artist - Title" lists and M3U.
// Pure functions — no DOM, no network — so they run in the browser and in node tests alike.

const SEPARATORS = [' - ', ' – ', ' — ', ' | '];

export function decodeText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  // Apple's "Export Playlist… → Plain Text" is UTF-16LE *without* BOM on some versions: lots of NUL bytes.
  let nulls = 0;
  const probe = Math.min(bytes.length, 2000);
  for (let i = 1; i < probe; i += 2) if (bytes[i] === 0) nulls += 1;
  if (probe > 20 && nulls > probe / 4) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/** RFC 4180-ish parser with delimiter sniffing. Returns an array of rows (arrays of strings). */
export function parseDelimited(text, delimiter = sniffDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

export function sniffDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = { '\t': 0, ',': 0, ';': 0 };
  for (const ch of head) if (ch in counts) counts[ch] += 1;
  if (counts['\t'] > 0 && counts['\t'] >= counts[','] / 2) return '\t';
  if (counts[';'] > counts[',']) return ';';
  return ',';
}

const COLUMN_PATTERNS = {
  title: [/^(track ?name|song ?title|song ?name|song|title|name|track|track ?title)$/i],
  artist: [/^artist ?name\(s\)$/i, /^artist ?names?$/i, /^artists?$/i, /^album ?artist$/i, /artist/i],
  album: [/^album ?(title|name)?$/i, /^album$/i],
  isrc: [/^isrc$/i, /isrc/i],
  duration: [/^duration \(ms\)$/i, /^duration ?\(?ms\)?$/i, /^duration$/i, /^total ?time$/i, /^time$/i, /^length$/i, /duration/i],
  playlist: [/^playlist ?(name|title)$/i, /^playlist$/i],
  videoId: [/^video ?id$/i],
  channel: [/^channel ?title$/i],
  type: [/^type$/i],
  year: [/^(year|release ?date|release ?year)$/i],
  upc: [/^upc$/i],
  trackCount: [/^(track ?count|tracks|nb ?tracks|number ?of ?tracks)$/i],
};

function mapColumns(header) {
  const map = {};
  const used = new Set();
  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    for (const pattern of patterns) {
      const index = header.findIndex((name, i) => !used.has(i) && pattern.test(name.trim()));
      if (index !== -1) { map[field] = index; used.add(index); break; }
    }
  }
  return map;
}

export function parseDuration(value, headerName = '') {
  if (value == null) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (raw.includes(':')) {
    const parts = raw.split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Math.round(seconds * 1000);
  }
  const number = Number(raw.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (/ms/i.test(headerName)) return Math.round(number);
  if (/sec/i.test(headerName)) return Math.round(number * 1000);
  return number >= 30000 ? Math.round(number) : Math.round(number * 1000); // seconds vs milliseconds
}

export function splitArtistTitle(line) {
  for (const separator of SEPARATORS) {
    const index = line.indexOf(separator);
    if (index > 0) return { artist: line.slice(0, index).trim(), title: line.slice(index + separator.length).trim() };
  }
  return { artist: '', title: line.trim() };
}

export function splitArtists(value) {
  return String(value || '')
    .split(/\s*(?:;|\/|,|&|\bfeat\.?\b|\bft\.?\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

let counter = 0;
export function makeTrack({ title, artists = [], album = '', durationMs = 0, isrc = '', url = '', id = '' }, origin = 'import') {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return null;
  counter += 1;
  return {
    id: id || `${origin}:${counter}`,
    title: cleanTitle,
    artists: (Array.isArray(artists) ? artists : splitArtists(artists)).map((a) => String(a).trim()).filter(Boolean),
    album: String(album || '').trim(),
    durationMs: Number(durationMs) || 0,
    isrc: String(isrc || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
    explicit: false,
    url,
    image: '',
  };
}

export function emptyResult() {
  return { playlists: [], albums: [], artists: [], notes: [] };
}

function baseName(name = '') {
  return String(name).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[-_]videos$/i, '').trim() || 'Imported playlist';
}

/**
 * Generic CSV/TSV import: Exportify, TuneMyMusic, Soundiiz, Google Takeout (YouTube Music),
 * Apple Music "Export Playlist → Plain Text", or any sheet with a title column.
 */
export function importDelimited(text, { fileName = 'playlist.csv', origin = 'CSV' } = {}) {
  const result = emptyResult();
  const rows = parseDelimited(text);
  if (rows.length === 0) return result;
  const header = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  const columns = mapColumns(header);

  // Google Takeout "subscriptions.csv" → channels ≈ artists
  if (columns.channel !== undefined && columns.title === undefined) {
    for (const row of rows.slice(1)) {
      const name = (row[columns.channel] || '').replace(/\s*-\s*Topic$/i, '').trim();
      if (name) result.artists.push({ id: `${origin}:artist:${result.artists.length + 1}`, name, image: '', url: '' });
    }
    result.notes.push(`${fileName}: ${result.artists.length} channel subscriptions imported as artists (not every channel is a musician — untick the ones you don't want).`);
    return result;
  }

  // Google Takeout playlist CSVs only carry YouTube video IDs — nothing to match on.
  if (columns.videoId !== undefined && columns.title === undefined) {
    result.notes.push(`${fileName}: this Google Takeout playlist contains only YouTube video IDs, no song titles — TuneBridge can't match it. Log in with YouTube Music instead, or export "music library songs" from Takeout.`);
    return result;
  }

  if (columns.title === undefined) {
    // Headerless file? Treat every line as "Artist - Title".
    return importPlainText(text, { fileName, origin });
  }

  const byPlaylist = new Map();
  const albums = [];
  for (const row of rows.slice(1)) {
    const cell = (field) => (columns[field] === undefined ? '' : (row[columns[field]] || '').trim());
    const type = cell('type').toLowerCase();
    if (type === 'album') {
      albums.push({ id: `${origin}:album:${albums.length + 1}`, title: cell('title'), artists: splitArtists(cell('artist')), upc: cell('upc'), year: cell('year').slice(0, 4), trackCount: Number(cell('trackCount')) || 0, image: '', url: '' });
      continue;
    }
    if (type === 'artist') {
      result.artists.push({ id: `${origin}:artist:${result.artists.length + 1}`, name: cell('title') || cell('artist'), image: '', url: '' });
      continue;
    }
    const track = makeTrack({
      title: cell('title'),
      artists: cell('artist'),
      album: cell('album'),
      durationMs: parseDuration(cell('duration'), columns.duration === undefined ? '' : header[columns.duration]),
      isrc: cell('isrc'),
    }, origin);
    if (!track) continue;
    const playlistName = cell('playlist') || baseName(fileName);
    if (!byPlaylist.has(playlistName)) byPlaylist.set(playlistName, []);
    byPlaylist.get(playlistName).push(track);
  }
  for (const [name, tracks] of byPlaylist) result.playlists.push(makePlaylist(name, tracks, origin));
  result.albums.push(...albums.filter((a) => a.title));
  return result;
}

export function makePlaylist(name, tracks, origin = 'import', extra = {}) {
  return {
    id: extra.id || `${origin}:playlist:${name}:${tracks.length}:${Math.random().toString(36).slice(2, 8)}`,
    name: String(name || 'Imported playlist').trim() || 'Imported playlist',
    description: extra.description || '',
    trackCount: tracks.length,
    image: extra.image || '',
    url: extra.url || '',
    owner: extra.owner || origin,
    isPublic: false,
    special: Boolean(extra.special),
    origin,
    platform: extra.platform || '',
    tracks,
  };
}

/** One song per line: "Artist - Title", "Artist – Title" or just "Title". Blank lines and #comments are skipped. */
export function importPlainText(text, { fileName = 'songs.txt', origin = 'Text' } = {}) {
  const result = emptyResult();
  const tracks = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*\d+[.)]\s+/, '').trim(); // "1. Artist - Title"
    if (!line || line.startsWith('#')) continue;
    const { artist, title } = splitArtistTitle(line);
    const track = makeTrack({ title, artists: artist ? [artist] : [] }, origin);
    if (track) tracks.push(track);
  }
  if (tracks.length) result.playlists.push(makePlaylist(baseName(fileName), tracks, origin));
  return result;
}

/** M3U / M3U8: "#EXTINF:257,Fleetwood Mac - Dreams" lines, falling back to "Artist - Title.mp3" file names. */
export function importM3u(text, { fileName = 'playlist.m3u', origin = 'M3U' } = {}) {
  const result = emptyResult();
  const tracks = [];
  let pending = null;
  let playlistName = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#PLAYLIST:/i.test(line)) { playlistName = line.slice(10).trim(); continue; }
    if (/^#EXTINF:/i.test(line)) {
      const match = line.match(/^#EXTINF:\s*(-?[\d.]+)[^,]*,(.*)$/i);
      if (match) {
        const seconds = Number(match[1]);
        const { artist, title } = splitArtistTitle(match[2]);
        pending = { title, artists: artist ? [artist] : [], durationMs: seconds > 0 ? Math.round(seconds * 1000) : 0 };
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!pending) {
      const { artist, title } = splitArtistTitle(decodeURIComponent(line.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')));
      pending = { title, artists: artist ? [artist] : [] };
    }
    const track = makeTrack(pending, origin);
    if (track) tracks.push(track);
    pending = null;
  }
  if (pending) { const track = makeTrack(pending, origin); if (track) tracks.push(track); }
  if (tracks.length) result.playlists.push(makePlaylist(playlistName || baseName(fileName), tracks, origin));
  return result;
}

export function mergeResults(target, ...sources) {
  for (const source of sources) {
    if (!source) continue;
    target.playlists.push(...(source.playlists || []));
    target.albums.push(...(source.albums || []));
    target.artists.push(...(source.artists || []));
    target.notes.push(...(source.notes || []));
  }
  return target;
}
