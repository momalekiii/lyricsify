/**
 * TuneBridge helper worker — ONE small Cloudflare Worker (free tier is plenty) that does the two
 * things a static page cannot do by itself:
 *
 *   GET  /resolve?url=<public playlist or album link>
 *        Reads a public Spotify / Apple Music / YouTube Music / SoundCloud / TIDAL / Deezer link
 *        and answers with the playlist (name, cover, songs). Visitors paste a link, nothing else.
 *
 *   POST /token   (also POST /)
 *        OAuth token exchange for services whose token endpoint needs a client secret
 *        (SoundCloud destination login; optionally Deezer). Secrets never reach the browser.
 *
 * Deploy (≈5 minutes, see SETUP.md):
 *   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker → Edit code →
 *      replace everything with this file → Deploy.  (Or: npm create cloudflare@latest + wrangler.)
 *   2. Settings → Variables and Secrets:
 *        ALLOWED_ORIGINS        (text)   https://<you>.github.io,http://127.0.0.1:8000
 *        YOUTUBE_API_KEY        (secret) optional — YouTube Data API v3 key (free) for YouTube links
 *        SOUNDCLOUD_CLIENT_ID / SOUNDCLOUD_CLIENT_SECRET   (secrets) optional — SoundCloud links + login
 *        TIDAL_CLIENT_ID / TIDAL_CLIENT_SECRET             (secrets) optional — TIDAL links
 *        DEEZER_APP_ID / DEEZER_APP_SECRET                 (secrets) optional — only for Deezer code-flow login
 *   3. Put the worker URL into config.js → resolverUrl (and soundcloud.tokenEndpoint = <url>/token).
 *
 * Spotify and Apple Music have no key-free API, so for those the worker reads the public page
 * the same way a browser would (best effort: it can break if they redesign their pages — the
 * app then tells the visitor to drop an exported file instead).
 */

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 TuneBridge/1.0 (+https://github.com/momalekiii/tunebridge)';
const CACHE_SECONDS = 600;
const MAX_TRACKS = 2000;

// ---------------------------------------------------------------------------
// Link classification (kept in sync with js/importers/links.js)
// ---------------------------------------------------------------------------

export function classifyLink(input = '') {
  let raw = String(input ?? '').trim().replace(/^<|>$/g, '');
  if (!raw) return { kind: 'empty' };
  if (/\s/.test(raw)) {
    const embedded = raw.match(/(?:https?:\/\/[^\s<>"'()]+|spotify:(?:playlist|album|artist|track):[A-Za-z0-9]{22})/i);
    if (embedded) raw = embedded[0].replace(/[.,;:!?]+$/, '');
  }
  let match = raw.match(/^spotify:(playlist|album|artist|track):([A-Za-z0-9]{22})$/);
  if (match) return { kind: 'link', platform: 'spotify', type: match[1], id: match[2], url: `https://open.spotify.com/${match[1]}/${match[2]}` };
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch (_) { return { kind: 'invalid' }; }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  const link = (platform, type, id, canonical, extra = {}) => ({ kind: 'link', platform, type, id, url: canonical, ...extra });
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    match = path.match(/\/(?:intl-[a-z]{2,3}(?:-[a-z]{2,4})?\/)?(?:user\/[^/]+\/|embed\/)?(playlist|album|artist|track)\/([A-Za-z0-9]{22})/i);
    return match ? link('spotify', match[1].toLowerCase(), match[2], `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`) : link('spotify', 'unknown', '', raw);
  }
  if (host === 'spotify.link' || host === 'spotify.app.link') return link('spotify', 'short', '', raw);
  if (/^(music|itunes|geo\.music|beta\.music)\.apple\.com$/.test(host)) {
    match = path.match(/^\/([a-z]{2})\/(playlist|album|artist|song|music-video)\/(?:[^/]+\/)?([^/?#]+)/i);
    if (!match) return link('apple', 'unknown', '', raw);
    let type = match[2].toLowerCase();
    let id = match[3];
    if (type === 'album' && url.searchParams.get('i')) { type = 'track'; id = url.searchParams.get('i'); }
    if (type === 'song' || type === 'music-video') type = 'track';
    return link('apple', type, id, `https://music.apple.com/${match[1].toLowerCase()}/${type}/${type === 'playlist' ? 'playlist' : 'id'}/${id}`, { storefront: match[1].toLowerCase() });
  }
  if (/^(music\.)?youtube(-nocookie)?\.com$/.test(host) || host === 'youtu.be') {
    const browse = path.match(/^\/browse\/VL([A-Za-z0-9_-]+)/);
    const list = url.searchParams.get('list') || (browse ? browse[1] : null);
    if (list && !/^(WL|LL)$/i.test(list)) return link('youtube', 'playlist', list, `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`);
    return link('youtube', list ? 'private' : url.searchParams.get('v') ? 'track' : 'unknown', '', raw);
  }
  if (host === 'soundcloud.com') {
    match = path.match(/^\/([^/]+)\/sets\/([^/?#]+)/);
    if (match) return link('soundcloud', 'playlist', `${match[1]}/sets/${match[2]}`, `https://soundcloud.com/${match[1]}/sets/${match[2]}`);
    return link('soundcloud', /^\/[^/]+\/[^/]+$/.test(path) ? 'track' : 'unknown', '', raw);
  }
  if (host === 'on.soundcloud.com') return link('soundcloud', 'short', '', raw);
  if (host === 'tidal.com' || host.endsWith('.tidal.com')) {
    match = path.match(/\/(playlist|album|artist|track|mix)\/([0-9a-fA-F-]{32,36}|\d+)/i);
    if (!match) return link('tidal', 'unknown', '', raw);
    const type = match[1].toLowerCase() === 'mix' ? 'playlist' : match[1].toLowerCase();
    return link('tidal', type, match[2], `https://tidal.com/browse/${match[1].toLowerCase()}/${match[2]}`);
  }
  if (host === 'deezer.page.link' || host === 'link.deezer.com' || host === 'dzr.page.link') return link('deezer', 'short', '', raw);
  if (host === 'deezer.com' || host.endsWith('.deezer.com')) {
    match = path.match(/\/(playlist|album|artist|track)\/(\d+)/);
    return match ? link('deezer', match[1], match[2], `https://www.deezer.com/${match[1]}/${match[2]}`) : link('deezer', 'unknown', '', raw);
  }
  return { kind: 'unknown', url: raw };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export class ResolveError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export const splitArtists = (value) => (Array.isArray(value) ? value : String(value || '').split(/\s*(?:;|\/|,|&|\bfeat\.?\b|\bft\.?\b)\s*/i)).map((s) => String(s).trim()).filter(Boolean);

export function isoDurationToMs(value) {
  if (typeof value === 'number') return value > 36000 ? value : value * 1000;
  const match = String(value || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  const [, d = 0, h = 0, m = 0, s = 0] = match;
  return Math.round(((Number(d) * 24 + Number(h)) * 3600 + Number(m) * 60 + Number(s)) * 1000);
}

const decodeEntities = (text) => String(text || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

export function metaContent(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = html.match(pattern)?.[0];
  if (!tag) return '';
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1] || '';
  return decodeEntities(content).replace(/^\u200e+/, '').trim();
}

export function jsonScripts(html, { id, type } = {}) {
  const out = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = match[1];
    if (id && !new RegExp(`\\bid=["']${id}["']`, 'i').test(attrs)) continue;
    if (type && !new RegExp(`\\btype=["']${type.replace(/[+]/g, '\\+')}["']`, 'i').test(attrs)) continue;
    if (!id && !type && !/application\/(ld\+)?json/i.test(attrs)) continue;
    const body = match[2].trim();
    if (!body) continue;
    try { out.push(JSON.parse(body)); } catch (_) { /* not JSON */ }
  }
  return out;
}

/** Depth-first walk over a JSON value, calling visit(object) for every plain object. */
export function walk(value, visit, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 40) return;
  if (Array.isArray(value)) { for (const item of value) walk(item, visit, depth + 1); return; }
  if (visit(value) === false) return;
  for (const key of Object.keys(value)) walk(value[key], visit, depth + 1);
}

const pickImage = (sources = []) => {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && s.url);
  if (!list.length) return '';
  list.sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  return (list.find((s) => (Number(s.width) || 0) <= 640) || list[list.length - 1]).url;
};

async function fetchText(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...(init.headers || {}) }, redirect: 'follow' });
  if (response.status === 404) throw new ResolveError('not_found', 'not found', 404);
  if (response.status === 429) throw new ResolveError('rate_limited', 'rate limited', 429);
  if (!response.ok) throw new ResolveError('upstream_failed', `HTTP ${response.status}`, 502);
  return { text: await response.text(), url: response.url };
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers || {}) } });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (response.status === 404) throw new ResolveError('not_found', 'not found', 404);
  if (response.status === 401 || response.status === 403) throw new ResolveError('not_public', data?.error_description || data?.message || 'forbidden', 403);
  if (response.status === 429) throw new ResolveError('rate_limited', 'rate limited', 429);
  if (!response.ok) throw new ResolveError('upstream_failed', data?.error?.message || data?.message || `HTTP ${response.status}`, 502);
  return data;
}

const track = ({ id = '', title, artists = [], album = '', durationMs = 0, isrc = '', url = '' }) => {
  const clean = String(title || '').trim();
  if (!clean) return null;
  return { id, title: clean, artists: splitArtists(artists), album: String(album || '').trim(), durationMs: Number(durationMs) || 0, isrc: String(isrc || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), url };
};

const playlistResult = (platform, playlist) => ({ platform, playlists: [{ ...playlist, trackCount: playlist.tracks.length }], albums: [], artists: [], notes: [] });
const albumResult = (platform, album) => ({ platform, playlists: [], albums: [{ ...album, trackCount: album.trackCount || album.tracks.length }], artists: [], notes: [] });

// ---------------------------------------------------------------------------
// Spotify — public embed page (open.spotify.com/embed/…) carries the entity as JSON.
// ---------------------------------------------------------------------------

export function parseSpotifyEmbed(html) {
  let entity = null;
  for (const data of jsonScripts(html, { id: '__NEXT_DATA__' })) entity = data?.props?.pageProps?.state?.data?.entity || entity;
  if (!entity) {
    for (const data of jsonScripts(html)) {
      walk(data, (node) => {
        if (!entity && Array.isArray(node.trackList) && (node.name || node.title)) { entity = node; return false; }
        return true;
      });
      if (entity) break;
    }
  }
  if (!entity) throw new ResolveError('parse_failed', 'Spotify embed page did not contain the playlist data');
  const type = entity.type || String(entity.uri || '').split(':')[1] || 'playlist';
  const id = entity.id || String(entity.uri || '').split(':')[2] || '';
  const name = String(entity.name || entity.title || '').trim();
  const image = pickImage(entity.coverArt?.sources || entity.visualIdentity?.image || entity.images || []);
  const tracks = (entity.trackList || []).map((item) => track({
    id: item.uri || '',
    title: item.title || item.name,
    artists: splitArtists(item.subtitle || (item.artists || []).map((a) => a.name).join(', ')),
    album: type === 'album' ? name : '',
    durationMs: item.duration || item.durationMs || 0,
    url: /^spotify:track:/.test(item.uri || '') ? `https://open.spotify.com/track/${item.uri.split(':')[2]}` : '',
  })).filter(Boolean);
  const total = Number(entity.trackCount || entity.totalTracks || entity.tracks?.total || 0) || tracks.length;
  const notes = [];
  if (total > tracks.length) notes.push(`Spotify’s public page only lists the first ${tracks.length} of ${total} songs. For the whole playlist, drop a Spotify data export instead.`);
  const url = `https://open.spotify.com/${type}/${id}`;
  if (type === 'album') {
    return { ...albumResult('spotify', { id: `spotify:album:${id}`, title: name, artists: splitArtists(entity.subtitle || ''), upc: '', year: String(entity.releaseDate?.isoString || entity.releaseDate || '').slice(0, 4), image, url, tracks }), notes };
  }
  return { ...playlistResult('spotify', { id: `spotify:playlist:${id}`, name, description: String(entity.description || ''), image, url, owner: String(entity.subtitle || 'Spotify'), tracks }), notes };
}

async function resolveSpotify(link) {
  if (!['playlist', 'album'].includes(link.type)) throw new ResolveError('unsupported', 'playlist or album links only');
  const { text } = await fetchText(`https://open.spotify.com/embed/${link.type}/${link.id}`);
  const result = parseSpotifyEmbed(text);
  if (!result.playlists[0]?.tracks.length && !result.albums[0]?.tracks.length) throw new ResolveError('not_public', 'no tracks visible — private playlist?');
  return result;
}

// ---------------------------------------------------------------------------
// Apple Music — public page: serialized-server-data (track lockups) and/or schema.org JSON-LD.
// ---------------------------------------------------------------------------

const linkTitles = (links) => (Array.isArray(links) ? links.map((l) => (typeof l === 'string' ? l : l?.title || l?.text || '')).filter(Boolean) : []);

export function parseAppleMusicPage(html, link = {}) {
  const ld = jsonScripts(html, { type: 'application/ld+json' }).flat().find((d) => d && /^Music(Playlist|Album)$/.test(d['@type'] || ''));
  const ogTitle = metaContent(html, 'og:title');
  const headerName = String(ld?.name || ogTitle.replace(/\s*(-|–|on)\s*Apple Music.*$/i, '').replace(/\s+-\s+(Playlist|Album).*$/i, '').replace(/\s+by\s+.+$/i, '') || '').trim();
  const owner = String(ld?.author?.name || ld?.byArtist?.name || (ogTitle.match(/\bby\s+(.+?)(?:\s+on\s+Apple Music)?$/i) || [])[1] || 'Apple Music').trim();
  const image = String((typeof ld?.image === 'string' ? ld.image : ld?.image?.url) || metaContent(html, 'og:image') || '').replace(/\{w\}x\{h\}([a-z]{2})?/, '600x600').replace(/\d{3,4}x\d{3,4}(cw|bb)?\.(png|jpg)/, '600x600bb.jpg');
  const seen = new Set();
  const tracks = [];
  const push = (item) => {
    const t = track(item);
    if (!t) return;
    const key = t.id || `${t.title}|${t.artists.join(',')}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tracks.push(t);
  };
  for (const data of jsonScripts(html, { id: 'serialized-server-data' })) {
    walk(data, (node) => {
      if (typeof node.title !== 'string' || !node.title) return true;
      const artistsFrom = linkTitles(node.subtitleLinks).length ? linkTitles(node.subtitleLinks) : node.artistName ? [node.artistName] : node.artistsNames ? [node.artistsNames] : typeof node.subtitle === 'string' && node.duration ? [node.subtitle] : [];
      const looksLikeTrack = (node.duration || node.contentDescriptor || node.trackNumber || node.tertiaryLinks) && (artistsFrom.length || node.trackNumber || node.duration);
      if (!looksLikeTrack) return true;
      const adamId = node.contentDescriptor?.identifiers?.storeAdamID || node.contentDescriptor?.identifiers?.storeAdamId || node.id || '';
      push({
        id: adamId ? `apple:${adamId}` : '',
        title: node.title,
        artists: artistsFrom.length ? artistsFrom.flatMap(splitArtists) : link.type === 'album' ? splitArtists(owner) : [],
        album: linkTitles(node.tertiaryLinks)[0] || node.albumName || node.tertiaryTitle || (link.type === 'album' ? headerName : ''),
        durationMs: isoDurationToMs(node.duration || 0),
        url: node.contentDescriptor?.url || node.url || '',
      });
      return false;
    });
  }
  if (!tracks.length && Array.isArray(ld?.track)) {
    for (const item of ld.track) push({ id: '', title: item?.name, artists: splitArtists(item?.byArtist?.name || (Array.isArray(item?.byArtist) ? item.byArtist.map((a) => a.name).join(', ') : '') || (link.type === 'album' ? owner : '')), album: link.type === 'album' ? headerName : '', durationMs: isoDurationToMs(item?.duration || 0), url: item?.url || '' });
  }
  if (!headerName && !tracks.length) throw new ResolveError('parse_failed', 'Apple Music page did not contain playlist data');
  const notes = [];
  if (tracks.length && tracks.every((t) => !t.artists.length)) notes.push('Apple Music’s public page listed song titles without artists, so matches may be less precise.');
  const total = Number(ld?.numTracks || 0);
  if (total > tracks.length && tracks.length) notes.push(`Apple Music’s public page only lists the first ${tracks.length} of ${total} songs. For the whole playlist, export it from the Music app instead.`);
  if (link.type === 'album') {
    return { ...albumResult('apple', { id: `apple:album:${link.id || ''}`, title: headerName, artists: splitArtists(owner), upc: '', year: String(ld?.datePublished || '').slice(0, 4), image, url: link.url || ld?.url || '', tracks }), notes };
  }
  return { ...playlistResult('apple', { id: `apple:playlist:${link.id || headerName}`, name: headerName || 'Apple Music playlist', description: String(ld?.description || metaContent(html, 'og:description') || ''), image, url: link.url || ld?.url || '', owner, tracks }), notes };
}

async function resolveApple(link) {
  if (!['playlist', 'album'].includes(link.type)) throw new ResolveError('unsupported', 'playlist or album links only');
  const { text } = await fetchText(link.url);
  const result = parseAppleMusicPage(text, link);
  if (!(result.playlists[0]?.tracks.length || result.albums[0]?.tracks.length)) throw new ResolveError('parse_failed', 'no tracks found on the page');
  return result;
}

// ---------------------------------------------------------------------------
// YouTube — Data API with the worker's key; falls back to the public playlist page.
// ---------------------------------------------------------------------------

const YT_NOISE = [
  /[([]\s*[^)\]]*\b(?:official|video|audio|lyrics?|lyric|visuali[sz]er|remaster(?:ed)?|hd|hq|4k|mv|m\/v|clip|explicit|clean|full album|prod\.?|produced by|out now|free download)\b[^)\]]*[)\]]/gi,
  /\s*\|\s*(official|lyrics?|audio|video|visuali[sz]er).*$/i,
  /\s*-\s*(official\s+)?(music\s+)?(video|audio|lyrics?)\s*$/i,
  /\s*#\w+/g,
];

export function cleanVideoTitle(rawTitle, channelTitle = '') {
  let text = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  for (const pattern of YT_NOISE) text = text.replace(pattern, ' ');
  text = text.replace(/\s{2,}/g, ' ').replace(/[\s\-–—|:]+$/g, '').trim();
  const channel = String(channelTitle || '').trim();
  const topic = /\s-\sTopic$/i.test(channel);
  const separator = text.match(/\s+(?:-|–|—|:|\|)\s+|\s+by\s+/i);
  if (!topic && separator && separator.index > 0) {
    const left = text.slice(0, separator.index).trim().replace(/^["“”']+|["“”']+$/g, '');
    const right = text.slice(separator.index + separator[0].length).trim().replace(/^["“”']+|["“”']+$/g, '');
    if (left && right) return /\s+by\s+/i.test(separator[0]) ? { title: left, artists: splitArtists(right) } : { title: right, artists: splitArtists(left) };
  }
  const quoted = text.match(/^(.+?)\s+["“](.+)["”]$/);
  if (!topic && quoted) return { title: quoted[2].trim(), artists: splitArtists(quoted[1]) };
  const artists = topic ? splitArtists(channel.replace(/\s-\sTopic$/i, '')) : /vevo$/i.test(channel) ? splitArtists(channel.replace(/vevo$/i, '')) : [];
  return { title: text || String(rawTitle || '').trim(), artists };
}

export function parseYouTubePlaylistPage(html, link = {}) {
  const scripts = [];
  const pattern = /ytInitialData\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/g;
  let match;
  while ((match = pattern.exec(html))) { try { scripts.push(JSON.parse(match[1])); } catch (_) { /* skip */ } }
  const tracks = [];
  const seen = new Set();
  let name = '';
  let owner = '';
  for (const data of scripts) {
    walk(data, (node) => {
      const video = node.playlistVideoRenderer || node.playlistPanelVideoRenderer;
      if (video && video.videoId && !seen.has(video.videoId)) {
        seen.add(video.videoId);
        const title = (video.title?.runs || []).map((r) => r.text).join('') || video.title?.simpleText || '';
        const channel = (video.shortBylineText?.runs || []).map((r) => r.text).join('') || video.shortBylineText?.simpleText || '';
        if (!/^\[?(private|deleted) video\]?$/i.test(title)) {
          const cleaned = cleanVideoTitle(title, channel);
          const t = track({ id: `youtube:${video.videoId}`, title: cleaned.title, artists: cleaned.artists, durationMs: (Number(video.lengthSeconds) || 0) * 1000, url: `https://music.youtube.com/watch?v=${video.videoId}` });
          if (t) tracks.push(t);
        }
        return false;
      }
      if (!name && node.playlistMetadataRenderer?.title) name = node.playlistMetadataRenderer.title;
      if (!owner && node.playlistSidebarSecondaryInfoRenderer) owner = (node.playlistSidebarSecondaryInfoRenderer.videoOwner?.videoOwnerRenderer?.title?.runs || []).map((r) => r.text).join('');
      return true;
    });
  }
  name = name || metaContent(html, 'og:title') || 'YouTube playlist';
  if (!tracks.length) throw new ResolveError('parse_failed', 'YouTube page did not list any videos');
  const result = playlistResult('youtube', { id: `youtube:playlist:${link.id || ''}`, name, description: '', image: metaContent(html, 'og:image'), url: link.url || '', owner: owner || 'YouTube', tracks });
  result.notes.push('YouTube only gives video titles, so artist and song names are guessed from them — check the preview.');
  if (tracks.length >= 100) result.notes.push('Only the first 100 videos of this playlist could be read from the public page.');
  return result;
}

async function resolveYouTube(link, env) {
  if (link.type !== 'playlist') throw new ResolveError('unsupported', 'playlist links only');
  if (env.YOUTUBE_API_KEY) {
    const base = 'https://www.googleapis.com/youtube/v3';
    const meta = await fetchJson(`${base}/playlists?part=snippet,contentDetails&id=${encodeURIComponent(link.id)}&key=${env.YOUTUBE_API_KEY}`);
    const playlist = meta?.items?.[0];
    if (!playlist) throw new ResolveError('not_public', 'playlist not found or private', 404);
    const tracks = [];
    let pageToken = '';
    let skipped = 0;
    do {
      const page = await fetchJson(`${base}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(link.id)}&key=${env.YOUTUBE_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const item of page?.items || []) {
        const snippet = item.snippet || {};
        if (/^(private|deleted) video$/i.test(snippet.title || '')) { skipped += 1; continue; }
        const cleaned = cleanVideoTitle(snippet.title, snippet.videoOwnerChannelTitle);
        const videoId = item.contentDetails?.videoId || '';
        const t = track({ id: videoId ? `youtube:${videoId}` : '', title: cleaned.title, artists: cleaned.artists, url: videoId ? `https://music.youtube.com/watch?v=${videoId}` : '' });
        if (t) tracks.push(t);
      }
      pageToken = page?.nextPageToken || '';
    } while (pageToken && tracks.length < MAX_TRACKS);
    const thumbs = playlist.snippet?.thumbnails || {};
    const result = playlistResult('youtube', { id: `youtube:playlist:${link.id}`, name: playlist.snippet?.title || 'YouTube playlist', description: playlist.snippet?.description || '', image: (thumbs.medium || thumbs.high || thumbs.default || {}).url || '', url: `https://music.youtube.com/playlist?list=${encodeURIComponent(link.id)}`, owner: playlist.snippet?.channelTitle || 'YouTube', tracks });
    if (skipped) result.notes.push(`${skipped} private or deleted ${skipped === 1 ? 'video was' : 'videos were'} skipped.`);
    result.notes.push('YouTube only gives video titles, so artist and song names are guessed from them — check the preview.');
    return result;
  }
  const { text } = await fetchText(`https://www.youtube.com/playlist?list=${encodeURIComponent(link.id)}&hl=en`, { headers: { Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
  return parseYouTubePlaylistPage(text, link);
}

// ---------------------------------------------------------------------------
// SoundCloud & TIDAL — official APIs with client-credentials tokens (secrets stay here).
// ---------------------------------------------------------------------------

const tokenCache = new Map();
async function clientCredentials(key, tokenUrl, clientId, clientSecret, extraHeaders = {}) {
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'User-Agent': USER_AGENT, ...extraHeaders },
    body: 'grant_type=client_credentials',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new ResolveError('not_configured', `token request failed (${response.status})`, 500);
  tokenCache.set(key, { token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

export function soundcloudTrack(item) {
  const meta = item?.publisher_metadata || {};
  let title = item?.title || '';
  let artists = meta.artist ? splitArtists(meta.artist) : [];
  if (!artists.length) {
    const split = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (split) { artists = splitArtists(split[1]); title = split[2]; } else artists = splitArtists(item?.user?.username || '');
  }
  return track({ id: item?.id ? `soundcloud:${item.id}` : '', title, artists, album: meta.release_title || meta.album_title || '', durationMs: item?.duration || 0, isrc: meta.isrc || '', url: item?.permalink_url || '' });
}

async function resolveSoundCloud(link, env) {
  if (link.type !== 'playlist') throw new ResolveError('unsupported', 'playlist (set) links only');
  if (!env.SOUNDCLOUD_CLIENT_ID || !env.SOUNDCLOUD_CLIENT_SECRET) throw new ResolveError('not_configured', 'SoundCloud credentials missing', 500);
  const token = await clientCredentials('soundcloud', 'https://secure.soundcloud.com/oauth/token', env.SOUNDCLOUD_CLIENT_ID, env.SOUNDCLOUD_CLIENT_SECRET);
  const auth = { Authorization: `OAuth ${token}` };
  const playlist = await fetchJson(`https://api.soundcloud.com/resolve?url=${encodeURIComponent(link.url)}`, { headers: auth });
  if (!playlist || playlist.kind !== 'playlist') throw new ResolveError('unsupported', 'not a playlist');
  let items = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  if (!items.length || items.some((t) => !t.title)) {
    items = [];
    let next = `https://api.soundcloud.com/playlists/${playlist.id}/tracks?limit=200&linked_partitioning=true`;
    while (next && items.length < MAX_TRACKS) {
      const page = await fetchJson(next, { headers: auth });
      items.push(...(page?.collection || (Array.isArray(page) ? page : [])));
      next = page?.next_href || '';
    }
  }
  const tracks = items.map(soundcloudTrack).filter(Boolean);
  return playlistResult('soundcloud', { id: `soundcloud:playlist:${playlist.id}`, name: playlist.title || 'SoundCloud playlist', description: playlist.description || '', image: (playlist.artwork_url || tracks.length && items.find((t) => t.artwork_url)?.artwork_url || '').replace('-large.', '-t300x300.'), url: playlist.permalink_url || link.url, owner: playlist.user?.username || 'SoundCloud', tracks });
}

export function tidalTracksFromJsonApi(data, included = []) {
  const byKey = new Map(included.map((item) => [`${item.type}:${item.id}`, item]));
  const artistNames = (item) => (item?.relationships?.artists?.data || []).map((ref) => byKey.get(`artists:${ref.id}`)?.attributes?.name).filter(Boolean);
  const tracks = [];
  for (const ref of data || []) {
    const item = ref.attributes ? ref : byKey.get(`${ref.type}:${ref.id}`);
    if (!item || item.type !== 'tracks') continue;
    const attributes = item.attributes || {};
    const album = byKey.get(`albums:${item.relationships?.albums?.data?.[0]?.id}`)?.attributes?.title || '';
    const t = track({ id: `tidal:${item.id}`, title: attributes.title, artists: artistNames(item), album, durationMs: isoDurationToMs(attributes.duration || 0), isrc: attributes.isrc || '', url: attributes.externalLinks?.[0]?.href || `https://tidal.com/browse/track/${item.id}` });
    if (t) tracks.push({ ...t, _id: item.id });
  }
  return tracks;
}

async function resolveTidal(link, env) {
  if (!['playlist', 'album'].includes(link.type)) throw new ResolveError('unsupported', 'playlist or album links only');
  if (!env.TIDAL_CLIENT_ID || !env.TIDAL_CLIENT_SECRET) throw new ResolveError('not_configured', 'TIDAL credentials missing', 500);
  const token = await clientCredentials('tidal', 'https://auth.tidal.com/v1/oauth2/token', env.TIDAL_CLIENT_ID, env.TIDAL_CLIENT_SECRET);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' };
  const country = env.TIDAL_COUNTRY || 'US';
  const base = 'https://openapi.tidal.com/v2';
  const kind = link.type === 'album' ? 'albums' : 'playlists';
  const root = await fetchJson(`${base}/${kind}/${encodeURIComponent(link.id)}?countryCode=${country}&include=items,coverArt,artists`, { headers });
  const attributes = root?.data?.attributes || {};
  const included = [...(root?.included || [])];
  const refs = [...(root?.data?.relationships?.items?.data || [])];
  let next = root?.data?.relationships?.items?.links?.next || '';
  let guard = 0;
  while (next && refs.length < MAX_TRACKS && guard < 100) {
    guard += 1;
    const page = await fetchJson(next.startsWith('http') ? next : `${base}${next}${next.includes('include=') ? '' : '&include=items'}`, { headers });
    refs.push(...(page?.data || []));
    included.push(...(page?.included || []));
    next = page?.links?.next || '';
  }
  let tracks = tidalTracksFromJsonApi(refs, included);
  const missingArtists = tracks.filter((t) => !t.artists.length).map((t) => t._id);
  for (let i = 0; i < missingArtists.length && i < 400; i += 20) {
    const ids = missingArtists.slice(i, i + 20);
    try {
      const page = await fetchJson(`${base}/tracks?countryCode=${country}&filter[id]=${ids.join(',')}&include=artists,albums`, { headers });
      const enriched = new Map(tidalTracksFromJsonApi(page?.data || [], page?.included || []).map((t) => [t._id, t]));
      tracks = tracks.map((t) => (enriched.has(t._id) ? { ...t, artists: enriched.get(t._id).artists, album: t.album || enriched.get(t._id).album } : t));
    } catch (_) { break; }
  }
  tracks = tracks.map(({ _id, ...t }) => t);
  const image = pickImage((included.find((i) => i.type === 'artworks')?.attributes?.files || attributes.imageLinks || []).map((f) => ({ url: f.href || f.url, width: f.meta?.width || f.width })));
  if (link.type === 'album') {
    const artists = (root?.data?.relationships?.artists?.data || []).map((ref) => included.find((i) => i.type === 'artists' && i.id === ref.id)?.attributes?.name).filter(Boolean);
    return albumResult('tidal', { id: `tidal:album:${link.id}`, title: attributes.title || 'TIDAL album', artists, upc: attributes.barcodeId || '', year: String(attributes.releaseDate || '').slice(0, 4), image, url: link.url, tracks, trackCount: attributes.numberOfItems || tracks.length });
  }
  return playlistResult('tidal', { id: `tidal:playlist:${link.id}`, name: attributes.name || attributes.title || 'TIDAL playlist', description: attributes.description || '', image, url: link.url, owner: 'TIDAL', tracks });
}

// ---------------------------------------------------------------------------
// Deezer — public API (the browser does this itself; here only for shortened links).
// ---------------------------------------------------------------------------

async function resolveDeezer(link) {
  const api = 'https://api.deezer.com';
  const check = (data) => {
    if (data?.error) throw new ResolveError(data.error.code === 800 ? 'not_public' : 'upstream_failed', data.error.message);
    return data;
  };
  const toTrack = (item, album = '') => track({ id: item?.id ? `deezer:${item.id}` : '', title: item?.title, artists: splitArtists(item?.artist?.name || ''), album: item?.album?.title || album, durationMs: (Number(item?.duration) || 0) * 1000, isrc: item?.isrc || '', url: item?.link || '' });
  if (link.type === 'playlist') {
    const playlist = check(await fetchJson(`${api}/playlist/${link.id}`));
    const tracks = [];
    let index = 0;
    for (;;) {
      const page = check(await fetchJson(`${api}/playlist/${link.id}/tracks?index=${index}&limit=100`));
      for (const item of page?.data || []) { const t = toTrack(item); if (t) tracks.push(t); }
      if (!page?.next || !page.data?.length || tracks.length >= MAX_TRACKS) break;
      index += page.data.length;
    }
    return playlistResult('deezer', { id: `deezer:playlist:${link.id}`, name: playlist.title, description: playlist.description || '', image: playlist.picture_medium || '', url: playlist.link || link.url, owner: playlist.creator?.name || 'Deezer', tracks });
  }
  if (link.type === 'album') {
    const album = check(await fetchJson(`${api}/album/${link.id}`));
    return albumResult('deezer', { id: `deezer:album:${link.id}`, title: album.title, artists: splitArtists(album.artist?.name || ''), upc: album.upc || '', year: String(album.release_date || '').slice(0, 4), image: album.cover_medium || '', url: album.link || link.url, tracks: (album.tracks?.data || []).map((i) => toTrack(i, album.title)).filter(Boolean), trackCount: album.nb_tracks });
  }
  throw new ResolveError('unsupported', 'playlist or album links only');
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const RESOLVERS = { spotify: resolveSpotify, apple: resolveApple, youtube: resolveYouTube, soundcloud: resolveSoundCloud, tidal: resolveTidal, deezer: resolveDeezer };

async function expandShortLink(url) {
  const response = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
  const landed = response.url && response.url !== url ? response.url : '';
  if (landed) return landed;
  const html = await response.text();
  return metaContent(html, 'og:url') || html.match(/https?:\/\/(?:open\.spotify\.com|music\.apple\.com|soundcloud\.com|tidal\.com|www\.deezer\.com)\/[^"'<\s]+/)?.[0] || '';
}

export async function resolveLink(input, env = {}) {
  let link = classifyLink(input);
  if (link.kind !== 'link') throw new ResolveError('unsupported', 'not a music link');
  if (link.type === 'short') {
    const expanded = await expandShortLink(link.url);
    link = classifyLink(expanded);
    if (link.kind !== 'link' || link.type === 'short') throw new ResolveError('not_found', 'short link did not lead to a playlist', 404);
  }
  const resolver = RESOLVERS[link.platform];
  if (!resolver) throw new ResolveError('unsupported', 'unknown platform');
  const result = await resolver(link, env);
  for (const list of [result.playlists, result.albums]) for (const item of list) if (item.tracks?.length > MAX_TRACKS) item.tracks = item.tracks.slice(0, MAX_TRACKS);
  return result;
}

// ---------------------------------------------------------------------------
// OAuth token exchange (destination logins that need a client secret)
// ---------------------------------------------------------------------------

const TOKEN_PROVIDERS = {
  soundcloud: {
    tokenUrl: 'https://secure.soundcloud.com/oauth/token',
    clientId: (env) => env.SOUNDCLOUD_CLIENT_ID,
    clientSecret: (env) => env.SOUNDCLOUD_CLIENT_SECRET,
  },
  deezer: {
    clientId: (env) => env.DEEZER_APP_ID,
    clientSecret: (env) => env.DEEZER_APP_SECRET,
    async exchange({ clientId, clientSecret, form }) {
      const url = new URL('https://connect.deezer.com/oauth/access_token.php');
      url.searchParams.set('app_id', clientId);
      url.searchParams.set('secret', clientSecret);
      url.searchParams.set('code', form.get('code') || '');
      url.searchParams.set('output', 'json');
      return fetch(url.toString());
    },
  },
};
const ALLOWED_FIELDS = new Set(['grant_type', 'code', 'code_verifier', 'redirect_uri', 'refresh_token']);

async function handleToken(request, headers, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid_json' }, 400, headers); }
  const provider = TOKEN_PROVIDERS[body.provider];
  if (!provider) return json({ error: 'unknown_provider' }, 400, headers);
  const clientId = provider.clientId(env);
  const clientSecret = provider.clientSecret(env);
  if (!clientId || !clientSecret) return json({ error: 'proxy_not_configured' }, 500, headers);
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  for (const [key, value] of Object.entries(body)) if (ALLOWED_FIELDS.has(key) && typeof value === 'string') form.set(key, value);
  if (!['authorization_code', 'refresh_token'].includes(form.get('grant_type'))) return json({ error: 'unsupported_grant_type' }, 400, headers);
  const upstream = provider.exchange
    ? await provider.exchange({ clientId, clientSecret, form })
    : await fetch(provider.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' }, body: form.toString() });
  return new Response(await upstream.text(), { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 || allowed.includes(origin) ? origin || '*' : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env = {}, ctx) {
    const origin = request.headers.get('Origin') || '';
    const headers = { ...corsHeaders(origin, env), 'Content-Type': 'application/json; charset=utf-8' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (headers['Access-Control-Allow-Origin'] === 'null') return json({ ok: false, error: 'origin_not_allowed' }, 403, headers);
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname.replace(/\/+$/, '') === '/resolve') {
      const target = url.searchParams.get('url') || '';
      const cacheKey = new Request(`${url.origin}/resolve?url=${encodeURIComponent(target)}`);
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      if (cache) {
        const hit = await cache.match(cacheKey);
        if (hit) {
          const copy = new Response(hit.body, hit);
          for (const [key, value] of Object.entries(headers)) copy.headers.set(key, value);
          copy.headers.set('X-Cache', 'HIT');
          return copy;
        }
      }
      try {
        const result = await resolveLink(target, env);
        const response = json({ ok: true, result }, 200, { ...headers, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
        if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (error) {
        const code = error instanceof ResolveError ? error.code : 'upstream_failed';
        const status = error instanceof ResolveError ? error.status : 502;
        return json({ ok: false, error: code, message: String(error.message || '').slice(0, 300) }, status >= 400 ? status : 400, headers);
      }
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return json({ ok: true, service: 'tunebridge-helper', endpoints: ['GET /resolve?url=', 'POST /token'], links: { spotify: true, apple: true, youtube: true, soundcloud: Boolean(env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET), tidal: Boolean(env.TIDAL_CLIENT_ID && env.TIDAL_CLIENT_SECRET), deezer: true } }, 200, headers);
    }

    if (request.method === 'POST' && ['/', '', '/token'].includes(url.pathname.replace(/\/+$/, '') || '/')) return handleToken(request, headers, env);
    return json({ ok: false, error: 'not_found' }, 404, headers);
  },
};
