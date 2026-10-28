// Public-link importer. Deezer's public API answers without any key or login for public
// playlists and albums, so a pasted link is enough. Links to other services explain what to
// do instead (their public pages can't be read from a browser page without an API).
import { http, jsonp, withQuery, ApiError } from '../http.js';
import { emptyResult, makeTrack, makePlaylist, splitArtists } from './text.js';

const DEEZER_API = 'https://api.deezer.com';

export function classifyLink(input = '') {
  const raw = String(input).trim();
  if (!raw) return { kind: 'empty' };
  let url;
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); } catch (_) { return { kind: 'invalid' }; }
  const host = url.hostname.replace(/^www\./, '');
  if (/(^|\.)deezer\.com$/.test(host)) {
    const match = url.pathname.match(/\/(playlist|album|artist|track)\/(\d+)/);
    if (match) return { kind: 'deezer', type: match[1], id: match[2], url: raw };
    return { kind: 'deezer-unknown' };
  }
  if (/deezer\.page\.link$|link\.deezer\.com$/.test(host)) return { kind: 'deezer-short' };
  if (/open\.spotify\.com$/.test(host)) return { kind: 'spotify' };
  if (/music\.apple\.com$/.test(host)) return { kind: 'apple' };
  if (/youtube\.com$|youtu\.be$/.test(host)) return { kind: 'youtube' };
  if (/soundcloud\.com$/.test(host)) return { kind: 'soundcloud' };
  if (/tidal\.com$/.test(host)) return { kind: 'tidal' };
  return { kind: 'unknown' };
}

export const LINK_HINTS = {
  'deezer-short': 'That is a shortened Deezer link. Open it in your browser and paste the full address (it starts with deezer.com/…/playlist/).',
  'deezer-unknown': 'Paste a link to a Deezer playlist or album, e.g. https://www.deezer.com/playlist/1234567.',
  spotify: 'Spotify pages can’t be read without logging in. Request your data at spotify.com/account/privacy (“Download your data”) and drop the ZIP here, or log in with Spotify.',
  apple: 'Apple Music pages can’t be read without logging in. In the Music app choose File → Library → Export Playlist… (XML or Plain Text) and drop the file here.',
  youtube: 'YouTube links can’t be read without logging in. Use Google Takeout (YouTube and YouTube Music → music library songs) or log in with YouTube Music.',
  soundcloud: 'SoundCloud has no export; log in with SoundCloud to transfer from it.',
  tidal: 'TIDAL has no export; log in with TIDAL to transfer from it.',
  unknown: 'Supported links: public Deezer playlists and albums. For other services, drop an exported file instead.',
  invalid: 'That doesn’t look like a web address.',
};

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
    if (code === 800 || /no data/i.test(message || '')) throw new ApiError('Deezer says this playlist or album isn’t public (or doesn’t exist). Make it public in Deezer, or log in with Deezer instead.', { status: 404, code: String(code) });
    throw new ApiError(message || 'Deezer request failed', { status: 400, code: String(code || '') });
  }
  return data;
}

const toTrack = (item) => makeTrack({
  id: item?.id ? `deezer:${item.id}` : '',
  title: item?.title,
  artists: splitArtists(item?.artist?.name || ''),
  album: item?.album?.title || '',
  durationMs: (Number(item?.duration) || 0) * 1000,
  isrc: item?.isrc || '',
  url: item?.link || '',
}, 'Deezer');

/** Fetches a public Deezer playlist/album into the import result shape. */
export async function importDeezerLink(link, { signal, onProgress } = {}) {
  const result = emptyResult();
  if (link.type === 'playlist') {
    const playlist = await deezerPublic(`/playlist/${link.id}`, {}, { signal });
    const tracks = [];
    let index = 0;
    for (;;) {
      const page = await deezerPublic(`/playlist/${link.id}/tracks`, { index, limit: 100 }, { signal });
      const items = page?.data || [];
      for (const item of items) { const track = toTrack(item); if (track) tracks.push(track); }
      onProgress?.(tracks.length, playlist.nb_tracks);
      if (!page?.next || !items.length) break;
      index += items.length;
    }
    result.playlists.push(makePlaylist(playlist.title, tracks, 'Deezer', { id: `deezer:playlist:${link.id}`, description: playlist.description || '', image: playlist.picture_medium || '', url: playlist.link || link.url, owner: playlist.creator?.name || 'Deezer' }));
    return result;
  }
  if (link.type === 'album') {
    const album = await deezerPublic(`/album/${link.id}`, {}, { signal });
    result.albums.push({ id: `deezer:${album.id}`, title: album.title, artists: splitArtists(album.artist?.name || ''), upc: album.upc || '', year: (album.release_date || '').slice(0, 4), trackCount: album.nb_tracks || 0, image: album.cover_medium || '', url: album.link || link.url });
    return result;
  }
  if (link.type === 'artist') {
    const artist = await deezerPublic(`/artist/${link.id}`, {}, { signal });
    result.artists.push({ id: `deezer:${artist.id}`, name: artist.name, image: artist.picture_medium || '', url: artist.link || link.url });
    return result;
  }
  throw new ApiError('Paste a Deezer playlist, album or artist link.', { status: 400 });
}
