// Public-link import: recognise a playlist/album link from any of the six services, then read
// it without the visitor logging in anywhere.
//
//   Deezer        → public API straight from the browser (no key).
//   YouTube Music → YouTube Data API straight from the browser when the site has a (free,
//                   referrer-restricted) API key; otherwise through the resolver.
//   everything    → the optional TuneBridge resolver (proxy/cloudflare-worker.js): a tiny
//                   worker the site owner deploys once. It reads the public page/API server-side
//                   because browsers are not allowed to read those pages cross-origin.
import { http, jsonp, withQuery, ApiError } from '../http.js';
import { emptyResult, makeTrack, makePlaylist, splitArtists } from './text.js';
import { importYouTubePlaylist } from './youtube.js';

const DEEZER_API = 'https://api.deezer.com';

export const PLATFORM_NAMES = { spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube Music', soundcloud: 'SoundCloud', tidal: 'TIDAL', deezer: 'Deezer' };

const link = (platform, type, id, url, extra = {}) => ({ kind: 'link', platform, type, id, url, ...extra });

/**
 * Classifies a pasted string. Returns { kind: 'link', platform, type, id, url } for the six
 * services (type: playlist | album | artist | track | short | unknown), or { kind: 'empty' |
 * 'invalid' | 'unknown' }.
 */
export function classifyLink(input = '') {
  const raw = String(input ?? '').trim().replace(/^<|>$/g, '');
  if (!raw) return { kind: 'empty' };
  let match = raw.match(/^spotify:(playlist|album|artist|track):([A-Za-z0-9]{22})$/);
  if (match) return link('spotify', match[1], match[2], `https://open.spotify.com/${match[1]}/${match[2]}`);
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (_) {
    return { kind: 'invalid' };
  }
  if (!/^https?:$/.test(url.protocol)) return { kind: 'invalid' };
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');

  // Spotify — open.spotify.com/playlist/{id}, /intl-de/playlist/{id}, /user/{u}/playlist/{id}
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    match = path.match(/\/(?:intl-[a-z]{2,3}(?:-[a-z]{2,4})?\/)?(?:user\/[^/]+\/|embed\/)?(playlist|album|artist|track)\/([A-Za-z0-9]{22})/i);
    if (match) return link('spotify', match[1].toLowerCase(), match[2], `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`);
    return link('spotify', 'unknown', '', raw);
  }
  if (host === 'spotify.link' || host === 'spotify.app.link') return link('spotify', 'short', '', raw);

  // Apple Music — music.apple.com/{storefront}/playlist/{slug}/pl.xxx, /album/{slug}/{id}[?i=track]
  if (/^(music|itunes|geo\.music|beta\.music)\.apple\.com$/.test(host)) {
    match = path.match(/^\/([a-z]{2})\/(playlist|album|artist|song|music-video)\/(?:[^/]+\/)?([^/?#]+)/i);
    if (match) {
      const storefront = match[1].toLowerCase();
      let type = match[2].toLowerCase();
      let id = match[3];
      if (type === 'album' && url.searchParams.get('i')) { type = 'track'; id = url.searchParams.get('i'); }
      if (type === 'song' || type === 'music-video') type = 'track';
      const canonical = type === 'track' ? raw : `https://music.apple.com/${storefront}/${type}/${type === 'playlist' ? 'playlist' : 'id'}/${id}`;
      return link('apple', type, id, canonical, { storefront });
    }
    return link('apple', 'unknown', '', raw);
  }

  // YouTube / YouTube Music — ?list=PL…, music.youtube.com/playlist?list=, youtu.be/…?list=
  if (/^(music\.)?youtube(-nocookie)?\.com$/.test(host) || host === 'youtu.be') {
    const list = url.searchParams.get('list');
    if (list && !/^(WL|LL)$/i.test(list)) return link('youtube', 'playlist', list, `https://music.youtube.com/playlist?list=${encodeURIComponent(list)}`, { music: host.startsWith('music.') });
    if (list) return link('youtube', 'private', list, raw);
    const channel = path.match(/^\/(channel\/[^/]+|@[^/]+|c\/[^/]+|user\/[^/]+)/);
    if (channel) return link('youtube', 'artist', channel[1], raw);
    const video = url.searchParams.get('v') || (host === 'youtu.be' ? path.slice(1) : '');
    if (video) return link('youtube', 'track', video, raw);
    return link('youtube', 'unknown', '', raw);
  }

  // SoundCloud — soundcloud.com/{user}/sets/{slug}
  if (host === 'soundcloud.com') {
    match = path.match(/^\/([^/]+)\/sets\/([^/?#]+)/);
    if (match) return link('soundcloud', 'playlist', `${match[1]}/sets/${match[2]}`, `https://soundcloud.com/${match[1]}/sets/${match[2]}`);
    match = path.match(/^\/([^/]+)\/([^/?#]+)$/);
    if (match && !['discover', 'search', 'you', 'stream', 'upload', 'charts'].includes(match[1])) return link('soundcloud', 'track', `${match[1]}/${match[2]}`, raw);
    match = path.match(/^\/([^/?#]+)$/);
    if (match && !['discover', 'search', 'you', 'stream', 'upload', 'charts'].includes(match[1])) return link('soundcloud', 'artist', match[1], raw);
    return link('soundcloud', 'unknown', '', raw);
  }
  if (host === 'on.soundcloud.com') return link('soundcloud', 'short', '', raw);

  // TIDAL — tidal.com/browse/playlist/{uuid}, listen.tidal.com/playlist/{uuid}, /album/{id}
  if (host === 'tidal.com' || host.endsWith('.tidal.com')) {
    match = path.match(/\/(playlist|album|artist|track|mix)\/([0-9a-fA-F-]{32,36}|\d+)/i);
    if (match) {
      const type = match[1].toLowerCase() === 'mix' ? 'playlist' : match[1].toLowerCase();
      return link('tidal', type, match[2], `https://tidal.com/browse/${match[1].toLowerCase()}/${match[2]}`);
    }
    return link('tidal', 'unknown', '', raw);
  }

  // Deezer — deezer.com/{lang}/playlist/{id}
  if (host === 'deezer.com' || host.endsWith('.deezer.com')) {
    match = path.match(/\/(playlist|album|artist|track)\/(\d+)/);
    if (match) return link('deezer', match[1], match[2], `https://www.deezer.com/${match[1]}/${match[2]}`);
    return link('deezer', 'unknown', '', raw);
  }
  if (host === 'deezer.page.link' || host === 'link.deezer.com' || host === 'dzr.page.link') return link('deezer', 'short', '', raw);

  return { kind: 'unknown', url: raw };
}

/** Human explanation for links that can't be imported as-is (null when the link is importable). */
export function linkHint(info, { resolverEnabled = false, youtubeDirect = false } = {}) {
  if (!info || info.kind === 'empty') return null;
  if (info.kind === 'invalid') return 'That doesn’t look like a web address — copy the link with the “Share” button of your music app and paste it here.';
  if (info.kind === 'unknown') return 'TuneBridge understands playlist and album links from Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer.';
  const name = PLATFORM_NAMES[info.platform];
  if (info.type === 'track') return `That’s a link to a single song — paste the link of the playlist or album it belongs to.`;
  if (info.type === 'artist') return `Artist pages can’t be copied. Paste a ${name} playlist or album link instead.`;
  if (info.type === 'private') return 'That’s your private Watch Later / Liked list — YouTube doesn’t share it by link. Use Google Takeout (see “What files work?”).';
  if (info.type === 'unknown') return `Paste a link to a ${name} playlist or album (open it in ${name} → Share → Copy link).`;
  if (info.type === 'short' && !resolverEnabled) return 'That’s a shortened link. Open it in your browser, then copy the full address from the address bar and paste that instead.';
  const readable = info.platform === 'deezer' || resolverEnabled || (info.platform === 'youtube' && youtubeDirect);
  if (!readable) return `Reading ${name} links isn’t switched on for this site yet — you can still bring the playlist over by dropping an exported file (see “What files work?”).`;
  return null;
}

export function isImportableLink(info, options) {
  return Boolean(info && info.kind === 'link' && !linkHint(info, options));
}

// ---------------------------------------------------------------------------
// Deezer: public API, no key needed.
// ---------------------------------------------------------------------------

let useJsonp = false;
async function deezerPublic(path, query = {}, { signal } = {}) {
  const url = withQuery(DEEZER_API + path, query);
  let data;
  if (!useJsonp) {
    try {
      data = await http(url, { signal, retries: 1 });
    } catch (error) {
      if (error instanceof ApiError && error.status === 0 && typeof document !== 'undefined') useJsonp = true;
      else throw error;
    }
  }
  if (useJsonp) data = await jsonp(withQuery(url, { ...query, output: 'jsonp' }));
  if (data?.error) {
    const { code, message } = data.error;
    if (code === 800 || /no data/i.test(message || '')) throw new ApiError('Deezer says this playlist or album isn’t public (or doesn’t exist). Open it in Deezer and make it public, then try again.', { status: 404, code: String(code) });
    throw new ApiError(message || 'Deezer request failed', { status: 400, code: String(code || '') });
  }
  return data;
}

const deezerTrack = (item) => makeTrack({
  id: item?.id ? `deezer:${item.id}` : '',
  title: item?.title,
  artists: splitArtists(item?.artist?.name || ''),
  album: item?.album?.title || '',
  durationMs: (Number(item?.duration) || 0) * 1000,
  isrc: item?.isrc || '',
  url: item?.link || '',
}, 'Deezer');

/** Fetches a public Deezer playlist/album/artist into the import result shape. */
export async function importDeezerLink(info, { signal, onProgress } = {}) {
  const result = emptyResult();
  if (info.type === 'playlist') {
    const playlist = await deezerPublic(`/playlist/${info.id}`, {}, { signal });
    const tracks = [];
    let index = 0;
    for (;;) {
      const page = await deezerPublic(`/playlist/${info.id}/tracks`, { index, limit: 100 }, { signal });
      const items = page?.data || [];
      for (const item of items) { const track = deezerTrack(item); if (track) tracks.push(track); }
      onProgress?.(tracks.length, playlist.nb_tracks);
      if (!page?.next || !items.length) break;
      index += items.length;
    }
    result.playlists.push(makePlaylist(playlist.title, tracks, 'Deezer', { id: `deezer:playlist:${info.id}`, description: playlist.description || '', image: playlist.picture_medium || playlist.picture || '', url: playlist.link || info.url, owner: playlist.creator?.name || 'Deezer', platform: 'deezer' }));
    return result;
  }
  if (info.type === 'album') {
    const album = await deezerPublic(`/album/${info.id}`, {}, { signal });
    const tracks = (album.tracks?.data || []).map((item) => deezerTrack({ ...item, album: { title: album.title } })).filter(Boolean);
    result.albums.push({ id: `deezer:${album.id}`, title: album.title, artists: splitArtists(album.artist?.name || ''), upc: album.upc || '', year: (album.release_date || '').slice(0, 4), trackCount: album.nb_tracks || tracks.length, image: album.cover_medium || album.cover || '', url: album.link || info.url, tracks, platform: 'deezer' });
    return result;
  }
  if (info.type === 'artist') {
    const artist = await deezerPublic(`/artist/${info.id}`, {}, { signal });
    result.artists.push({ id: `deezer:${artist.id}`, name: artist.name, image: artist.picture_medium || '', url: artist.link || info.url, platform: 'deezer' });
    return result;
  }
  throw new ApiError('Paste a Deezer playlist or album link.', { status: 400 });
}

// ---------------------------------------------------------------------------
// Resolver worker (any platform)
// ---------------------------------------------------------------------------

const RESOLVER_MESSAGES = {
  not_public: (name) => `${name} says this playlist isn’t public (or the link is wrong). Make it public in ${name}, then paste the link again.`,
  not_found: (name) => `${name} couldn’t find anything at this link. Check that it’s a public playlist or album.`,
  unsupported: (name) => `This kind of ${name} link can’t be imported — paste a playlist or album link.`,
  not_configured: (name) => `Reading ${name} links isn’t switched on for this site yet. You can still drop an exported file instead.`,
  parse_failed: (name) => `${name} changed its page layout and the playlist couldn’t be read. Try again later or drop an exported file instead.`,
  upstream_failed: (name) => `${name} didn’t answer. Try again in a minute.`,
  rate_limited: (name) => `${name} is rate-limiting requests right now. Try again in a minute.`,
};

function normalizeResolved(result, platformName) {
  const out = emptyResult();
  for (const playlist of result?.playlists || []) {
    const tracks = (playlist.tracks || []).map((t) => makeTrack({ id: t.id, title: t.title, artists: t.artists, album: t.album, durationMs: t.durationMs, isrc: t.isrc, url: t.url }, platformName)).filter(Boolean);
    out.playlists.push(makePlaylist(playlist.name, tracks, platformName, { id: playlist.id, description: playlist.description || '', image: playlist.image || '', url: playlist.url || '', owner: playlist.owner || platformName, platform: result.platform }));
  }
  for (const album of result?.albums || []) {
    const tracks = (album.tracks || []).map((t) => makeTrack({ id: t.id, title: t.title, artists: t.artists, album: album.title, durationMs: t.durationMs, isrc: t.isrc, url: t.url }, platformName)).filter(Boolean);
    out.albums.push({ id: album.id || `${platformName}:album:${album.title}`, title: album.title, artists: Array.isArray(album.artists) ? album.artists : splitArtists(album.artists), upc: album.upc || '', year: album.year || '', trackCount: album.trackCount || tracks.length, image: album.image || '', url: album.url || '', tracks, platform: result.platform });
  }
  for (const artist of result?.artists || []) out.artists.push({ id: artist.id || `${platformName}:artist:${artist.name}`, name: artist.name, image: artist.image || '', url: artist.url || '', platform: result.platform });
  out.notes.push(...(result?.notes || []));
  return out;
}

export async function importViaResolver(info, resolverUrl, { signal } = {}) {
  const name = PLATFORM_NAMES[info.platform] || 'The service';
  const endpoint = `${String(resolverUrl).replace(/\/+$/, '')}/resolve`;
  let data;
  try {
    data = await http(withQuery(endpoint, { url: info.url }), { signal, retries: 1, timeoutMs: 60000 });
  } catch (error) {
    if (error instanceof ApiError && error.body && typeof error.body === 'object' && error.body.error) data = error.body;
    else if (error instanceof ApiError && error.status === 0) throw new ApiError('The link reader for this site isn’t reachable right now. Try again in a minute, or drop an exported file instead.', { status: 0 });
    else throw error;
  }
  if (!data || data.ok === false || data.error) {
    const code = data?.error || 'upstream_failed';
    const message = (RESOLVER_MESSAGES[code] || RESOLVER_MESSAGES.upstream_failed)(name);
    throw new ApiError(data?.message && code === 'upstream_failed' ? `${message} (${data.message})` : message, { status: 400, code });
  }
  const result = normalizeResolved(data.result, name);
  if (!result.playlists.length && !result.albums.length && !result.artists.length) throw new ApiError(RESOLVER_MESSAGES.parse_failed(name), { status: 400, code: 'parse_failed' });
  return result;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Imports whatever the link points to. `config`: { resolverUrl, youtubeApiKey }.
 * Throws ApiError with a visitor-friendly message when it can't.
 */
export async function importLink(info, { signal, onProgress, config = {} } = {}) {
  const resolverEnabled = Boolean(config.resolverUrl);
  const youtubeDirect = Boolean(config.youtubeApiKey);
  const hint = linkHint(info, { resolverEnabled, youtubeDirect });
  if (hint) throw new ApiError(hint, { status: 400, code: 'unsupported' });
  if (info.platform === 'deezer' && info.type !== 'short') return importDeezerLink(info, { signal, onProgress });
  if (info.platform === 'youtube' && info.type === 'playlist' && youtubeDirect) {
    try {
      return await importYouTubePlaylist(info, { apiKey: config.youtubeApiKey, signal, onProgress });
    } catch (error) {
      if (!resolverEnabled || (error instanceof ApiError && error.status === 404)) throw error;
      // key misconfigured / quota — fall back to the resolver
    }
  }
  return importViaResolver(info, config.resolverUrl, { signal });
}

// ---------------------------------------------------------------------------
// oEmbed peek: title + cover for the preview while (or even if) the songs can't be read.
// Best effort only — some services don't allow browsers to call their oEmbed endpoint.
// ---------------------------------------------------------------------------

const OEMBED = {
  spotify: (url) => withQuery('https://open.spotify.com/oembed', { url }),
  soundcloud: (url) => withQuery('https://soundcloud.com/oembed', { format: 'json', url }),
  tidal: (url) => withQuery('https://oembed.tidal.com/', { url }),
  youtube: (url) => withQuery('https://www.youtube.com/oembed', { format: 'json', url: url.replace('music.youtube.com', 'www.youtube.com') }),
};

export async function peekLink(info, { signal } = {}) {
  const builder = OEMBED[info?.platform];
  if (!builder || !info.url) return null;
  try {
    const data = await http(builder(info.url), { signal, retries: 0, timeoutMs: 6000 });
    if (!data || !data.title) return null;
    return { title: String(data.title), image: data.thumbnail_url || '', author: data.author_name || '' };
  } catch (_) {
    return null;
  }
}
