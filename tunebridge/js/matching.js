// Track / album / artist matching: normalisation, similarity scoring and search helpers.
// Every provider funnels its search results through these functions so that matching
// behaves the same no matter which pair of services is involved.

const FEAT_PATTERN = /\s*[([{]\s*(?:feat\.?|ft\.?|featuring|with)\b[^)\]}]*[)\]}]/gi;
const FEAT_SUFFIX = /\s+(?:[-–—]\s+)?(?:feat\.?|ft\.?|featuring)\s+.+$/i;
const NOISE_BRACKETS = /\s*[([{][^)\]}]*\b(?:remaster(?:ed)?|version|edit|mix|mono|stereo|deluxe|bonus|live|acoustic|demo|instrumental|karaoke|cover|sped\s*up|slowed|re-?recorded|anniversary|explicit|clean|single|album|radio|original|extended|from|soundtrack|ost|official|video|audio|lyrics?|hd|4k|visuali[sz]er)\b[^)\]}]*[)\]}]/gi;
const NOISE_SUFFIX = /\s+[-–—]\s+(?:(?:\d{4}\s+)?(?:digital\s+)?remaster(?:ed)?(?:\s+\d{4})?|(?:single|album|radio|original|extended|mono|stereo|deluxe|acoustic|live|instrumental|karaoke)\s+(?:version|edit|mix)|remaster(?:ed)?\s+version|live(?:\s+(?:at|from|in)\b.*)?|remix|edit|bonus\s+track|official\s+(?:music\s+)?video|official\s+audio|lyrics?(?:\s+video)?|audio|visuali[sz]er)\b.*$/i;
const FLAG_PATTERNS = {
  live: /\b(?:live|en\s+vivo|ao\s+vivo)\b/i,
  remix: /\b(?:remix|rmx|flip|bootleg|rework|mashup|re-?edit)\b/i,
  acoustic: /\b(?:acoustic|unplugged|stripped)\b/i,
  instrumental: /\binstrumental\b/i,
  karaoke: /\b(?:karaoke|backing\s+track|in\s+the\s+style\s+of|originally\s+performed)\b/i,
  cover: /\b(?:cover|tribute|as\s+made\s+famous)\b/i,
  demo: /\bdemo\b/i,
  spedup: /\b(?:sped\s*up|nightcore|slowed(?:\s*\+?\s*reverb)?|8d\s+audio)\b/i,
};

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Removes features, remaster notes, "(Official Video)" and similar decorations. */
export function cleanTitle(title) {
  let text = String(title ?? '');
  text = text.replace(FEAT_PATTERN, ' ');
  text = text.replace(NOISE_BRACKETS, ' ');
  text = text.replace(NOISE_SUFFIX, '');
  text = text.replace(FEAT_SUFFIX, '');
  const normalized = normalizeText(text);
  return normalized || normalizeText(title);
}

export function titleFlags(title) {
  const flags = new Set();
  const text = String(title ?? '');
  for (const [flag, pattern] of Object.entries(FLAG_PATTERNS)) if (pattern.test(text)) flags.add(flag);
  return flags;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function tokenDice(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

/** 0..1 similarity between two already-normalised strings. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dice = tokenDice(a, b);
  const distance = levenshtein(a, b);
  const ratio = 1 - distance / Math.max(a.length, b.length);
  let contains = 0;
  if (a.includes(b) || b.includes(a)) {
    const short = Math.min(a.length, b.length);
    const long = Math.max(a.length, b.length);
    contains = 0.6 + 0.35 * (short / long);
  }
  return Math.max(contains, 0.55 * dice + 0.45 * ratio);
}

export function splitArtists(value) {
  if (Array.isArray(value)) return value.flatMap(splitArtists).filter(Boolean);
  return String(value ?? '')
    .split(/\s*(?:,|;|\/|&|\+|\b(?:feat|ft|featuring|with|vs|x|and)\b\.?(?=\s|$))\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function artistSimilarity(sourceArtists, candidateArtists) {
  const a = splitArtists(sourceArtists).map(normalizeText).filter(Boolean);
  const b = splitArtists(candidateArtists).map(normalizeText).filter(Boolean);
  if (!a.length || !b.length) return 0.5; // unknown — neutral
  let best = 0;
  for (const x of a) for (const y of b) best = Math.max(best, similarity(x, y));
  const joinedA = a.join(' ');
  const joinedB = b.join(' ');
  best = Math.max(best, similarity(joinedA, joinedB));
  if (best < 1 && (joinedA.includes(joinedB) || joinedB.includes(joinedA))) best = Math.max(best, 0.85);
  return best;
}

function durationScore(a, b) {
  if (!a || !b) return 0.6;
  const diff = Math.abs(a - b) / 1000;
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.9;
  if (diff <= 10) return 0.7;
  if (diff <= 20) return 0.45;
  if (diff <= 45) return 0.2;
  return 0;
}

const clamp = (n) => Math.max(0, Math.min(1, n));

export function scoreTrack(source, candidate) {
  if (source.isrc && candidate.isrc && source.isrc.toUpperCase() === candidate.isrc.toUpperCase()) return 1;
  const sourceClean = cleanTitle(source.title);
  const candidateClean = cleanTitle(candidate.title);
  const title = Math.max(
    similarity(sourceClean, candidateClean),
    similarity(normalizeText(source.title), normalizeText(candidate.title)) * 0.97,
  );
  const artist = artistSimilarity(source.artists, candidate.artists);
  const duration = durationScore(source.durationMs, candidate.durationMs);
  let score = 0.5 * title + 0.35 * artist + 0.15 * duration;
  if (artist < 0.35) score -= 0.2; // same title, clearly different artist (covers, namesakes)
  const sourceFlags = titleFlags(source.title);
  const candidateFlags = titleFlags(candidate.title);
  for (const flag of candidateFlags) if (!sourceFlags.has(flag)) score -= flag === 'remix' || flag === 'live' || flag === 'karaoke' || flag === 'cover' ? 0.3 : 0.2;
  for (const flag of sourceFlags) if (!candidateFlags.has(flag)) score -= 0.12;
  if (candidate.album && source.album && normalizeText(candidate.album) === normalizeText(source.album)) score += 0.04;
  return clamp(score);
}

export function scoreAlbum(source, candidate) {
  if (source.upc && candidate.upc && String(source.upc).replace(/^0+/, '') === String(candidate.upc).replace(/^0+/, '')) return 1;
  const title = similarity(cleanTitle(source.title), cleanTitle(candidate.title));
  const artist = artistSimilarity(source.artists, candidate.artists);
  let score = 0.6 * title + 0.4 * artist;
  const sourceFlags = titleFlags(source.title);
  const candidateFlags = titleFlags(candidate.title);
  for (const flag of candidateFlags) if (!sourceFlags.has(flag)) score -= 0.2;
  if (source.trackCount && candidate.trackCount && source.trackCount === candidate.trackCount) score += 0.05;
  return clamp(score);
}

export function scoreArtist(source, candidate) {
  const a = normalizeText(source.name);
  const b = normalizeText(candidate.name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return similarity(a, b) * 0.9;
}

export const THRESHOLDS = { track: 0.62, album: 0.66, artist: 0.8 };

export function bestMatch(source, candidates, scorer, threshold) {
  let best = null;
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    const score = scorer(source, candidate);
    if (score >= threshold && (!best || score > best.score)) best = { candidate, score };
  }
  return best;
}

export function primaryArtist(artists) {
  const list = splitArtists(artists);
  return list[0] || '';
}

/** Ordered list of search strings to try for a track (deduplicated). */
export function trackQueries(track) {
  const artist = primaryArtist(track.artists);
  const clean = cleanTitle(track.title);
  const raw = normalizeText(track.title);
  const queries = [
    `${clean} ${artist}`.trim(),
    raw !== clean ? `${raw} ${artist}`.trim() : null,
    clean,
  ];
  return Array.from(new Set(queries.filter(Boolean).map((q) => q.trim())));
}

export function albumQueries(album) {
  const artist = primaryArtist(album.artists);
  const clean = cleanTitle(album.title);
  return Array.from(new Set([`${clean} ${artist}`.trim(), clean].filter(Boolean)));
}

/**
 * Generic "search then score" routine used by most providers.
 * searchFn(query) must resolve to an array of normalised candidates.
 */
export async function matchViaSearch(source, queries, searchFn, scorer, threshold, { maxQueries = queries.length, goodEnough = 0.92 } = {}) {
  let best = null;
  for (const query of queries.slice(0, maxQueries)) {
    const candidates = await searchFn(query);
    const match = bestMatch(source, candidates, scorer, threshold);
    if (match && (!best || match.score > best.score)) best = match;
    if (best && best.score >= goodEnough) break;
  }
  return best;
}

/** "Artist - Title (Official Video)" style strings → { artists, title }. */
export function parseArtistTitle(rawTitle, fallbackArtist = '') {
  const text = String(rawTitle ?? '').trim();
  const separator = text.match(/\s+[-–—|:]\s+|\s+["“]/);
  if (separator) {
    const index = separator.index;
    const left = text.slice(0, index).trim();
    const right = text.slice(index + separator[0].length).replace(/["”]+$/, '').trim();
    if (left && right && left.length < 80) return { artists: splitArtists(left), title: right };
  }
  return { artists: fallbackArtist ? [fallbackArtist] : [], title: text };
}

export function cleanChannelName(name) {
  return String(name ?? '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s*(?:official|music|tv|records|channel)$/i, '')
    .trim();
}
