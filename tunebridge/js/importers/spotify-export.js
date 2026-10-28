// Spotify "Download your data" importer (Account data package → Playlist1.json…, YourLibrary.json).
// No API, no login: the ZIP arrives by e-mail from spotify.com/account/privacy within a few days.
import { emptyResult, makeTrack, makePlaylist, splitArtists } from './text.js';

const ORIGIN = 'Spotify';

const uriId = (uri = '') => (String(uri).startsWith('spotify:') ? String(uri).split(':')[2] || '' : '');

export function looksLikeSpotifyPlaylists(data) {
  return Boolean(data && Array.isArray(data.playlists) && data.playlists.every((p) => p && typeof p === 'object' && ('items' in p || 'name' in p)));
}

export function looksLikeSpotifyLibrary(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return ['tracks', 'albums', 'artists'].some((key) => Array.isArray(data[key]) && data[key].some((item) => item && typeof item.uri === 'string' && item.uri.startsWith('spotify:')));
}

/** Playlist1.json, Playlist2.json, … */
export function importSpotifyPlaylists(data, { fileName = 'Playlist1.json' } = {}) {
  const result = emptyResult();
  let skipped = 0;
  for (const playlist of data.playlists || []) {
    const tracks = [];
    for (const item of playlist.items || []) {
      const track = item?.track;
      if (!track) { skipped += 1; continue; } // episodes, audiobooks, local files
      const id = uriId(track.trackUri);
      const made = makeTrack({
        id: id ? `spotify:${id}` : '',
        title: track.trackName,
        artists: splitArtists(track.artistName),
        album: track.albumName,
        url: id ? `https://open.spotify.com/track/${id}` : '',
      }, ORIGIN);
      if (made) tracks.push(made);
    }
    if (!tracks.length && !(playlist.items || []).length) continue;
    result.playlists.push(makePlaylist(playlist.name, tracks, ORIGIN, { description: playlist.description || '' }));
  }
  if (skipped) result.notes.push(`${fileName}: ${skipped} podcast episodes/audiobooks/local files were skipped (only songs can be transferred).`);
  return result;
}

/** YourLibrary.json → Liked Songs playlist + saved albums + followed artists. */
export function importSpotifyLibrary(data, { fileName = 'YourLibrary.json' } = {}) {
  const result = emptyResult();
  const liked = [];
  for (const item of data.tracks || []) {
    const id = uriId(item.uri);
    const track = makeTrack({ id: id ? `spotify:${id}` : '', title: item.track, artists: splitArtists(item.artist), album: item.album, url: id ? `https://open.spotify.com/track/${id}` : '' }, ORIGIN);
    if (track) liked.push(track);
  }
  if (liked.length) result.playlists.push(makePlaylist('Liked Songs', liked, ORIGIN, { id: 'spotify-export:liked', description: 'Your saved tracks on Spotify', special: true, url: 'https://open.spotify.com/collection/tracks' }));
  for (const item of data.albums || []) {
    if (!item?.album) continue;
    const id = uriId(item.uri);
    result.albums.push({ id: id ? `spotify:${id}` : `${ORIGIN}:album:${result.albums.length + 1}`, title: item.album, artists: splitArtists(item.artist), upc: '', year: '', trackCount: 0, image: '', url: id ? `https://open.spotify.com/album/${id}` : '' });
  }
  for (const item of data.artists || []) {
    if (!item?.name) continue;
    const id = uriId(item.uri);
    result.artists.push({ id: id ? `spotify:${id}` : `${ORIGIN}:artist:${result.artists.length + 1}`, name: item.name, image: '', url: id ? `https://open.spotify.com/artist/${id}` : '' });
  }
  const parts = [];
  if (liked.length) parts.push(`${liked.length} liked songs`);
  if (result.albums.length) parts.push(`${result.albums.length} albums`);
  if (result.artists.length) parts.push(`${result.artists.length} artists`);
  if (parts.length) result.notes.push(`${fileName}: ${parts.join(', ')}.`);
  return result;
}

/** Any JSON object from the package: dispatches to the right parser or returns null. */
export function importSpotifyJson(data, options = {}) {
  if (looksLikeSpotifyPlaylists(data)) return importSpotifyPlaylists(data, options);
  if (looksLikeSpotifyLibrary(data)) return importSpotifyLibrary(data, options);
  return null;
}
