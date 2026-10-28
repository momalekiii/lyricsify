// YouTube / YouTube Music public playlists through the YouTube Data API v3 with a plain API key
// (free; the site owner restricts it to the site's address, which is exactly how Google intends
// browser keys to be used). Visitors don't log in to anything.
import { http, ApiError } from '../http.js';
import { emptyResult, makeTrack, makePlaylist, splitArtists } from './text.js';

const API = 'https://www.googleapis.com/youtube/v3';

const NOISE = [
  /[([]\s*[^)\]]*\b(?:official|video|audio|lyrics?|lyric|visuali[sz]er|remaster(?:ed)?|hd|hq|4k|mv|m\/v|clip|explicit|clean|full album|prod\.?|produced by|out now|free download)\b[^)\]]*[)\]]/gi,
  /\s*\|\s*(official|lyrics?|audio|video|visuali[sz]er).*$/i,
  /\s*-\s*(official\s+)?(music\s+)?(video|audio|lyrics?)\s*$/i,
  /\s*#\w+/g,
];

/** "Artist - Song (Official Video)" → { title: 'Song', artists: ['Artist'] }. */
export function cleanVideoTitle(rawTitle, channelTitle = '') {
  let text = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  for (const pattern of NOISE) text = text.replace(pattern, ' ');
  text = text.replace(/\s{2,}/g, ' ').replace(/[\s\-–—|:]+$/g, '').trim();
  const channel = String(channelTitle || '').trim();
  const topic = /\s-\sTopic$/i.test(channel);
  const channelArtist = topic ? channel.replace(/\s-\sTopic$/i, '').trim() : '';
  const separator = text.match(/\s+(?:-|–|—|–|:|\|)\s+|\s+by\s+/i);
  if (!topic && separator && separator.index > 0) {
    const left = text.slice(0, separator.index).trim().replace(/^["“”']+|["“”']+$/g, '');
    const right = text.slice(separator.index + separator[0].length).trim().replace(/^["“”']+|["“”']+$/g, '');
    if (left && right) {
      if (/\s+by\s+/i.test(separator[0])) return { title: left, artists: splitArtists(right) };
      return { title: right, artists: splitArtists(left) };
    }
  }
  const quoted = text.match(/^(.+?)\s+["“](.+)["”]$/);
  if (!topic && quoted) return { title: quoted[2].trim(), artists: splitArtists(quoted[1]) };
  const artists = channelArtist ? splitArtists(channelArtist) : channel && !/vevo$/i.test(channel) ? [] : channel ? splitArtists(channel.replace(/vevo$/i, '')) : [];
  return { title: text || String(rawTitle || '').trim(), artists };
}

function apiError(error) {
  if (!(error instanceof ApiError)) return error;
  const reason = error.body?.error?.errors?.[0]?.reason || '';
  if (error.status === 404 || reason === 'playlistNotFound') return new ApiError('YouTube couldn’t find this playlist — it’s probably private. Open it in YouTube Music → ⋮ → Edit playlist → set it to Public, then paste the link again.', { status: 404, code: 'not_public' });
  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') return new ApiError('YouTube’s daily reading quota for this site is used up — try again tomorrow or drop a Google Takeout file.', { status: 429, code: 'rate_limited' });
  if (error.status === 400 || error.status === 403) return new ApiError('Reading YouTube links isn’t set up correctly for this site (API key). You can still drop a Google Takeout file.', { status: error.status, code: 'not_configured' });
  return error;
}

/** Reads a public playlist into the import result shape. */
export async function importYouTubePlaylist(info, { apiKey, signal, onProgress } = {}) {
  if (!apiKey) throw new ApiError('No YouTube API key configured.', { status: 400, code: 'not_configured' });
  let meta;
  try {
    meta = await http(`${API}/playlists`, { query: { part: 'snippet,contentDetails', id: info.id, key: apiKey }, signal, retries: 1 });
  } catch (error) {
    throw apiError(error);
  }
  const playlist = meta?.items?.[0];
  if (!playlist) throw apiError(new ApiError('not found', { status: 404 }));
  const expected = playlist.contentDetails?.itemCount || 0;
  const tracks = [];
  let pageToken = '';
  let skipped = 0;
  do {
    let page;
    try {
      page = await http(`${API}/playlistItems`, { query: { part: 'snippet,contentDetails', maxResults: 50, playlistId: info.id, key: apiKey, pageToken: pageToken || undefined }, signal, retries: 1 });
    } catch (error) {
      throw apiError(error);
    }
    for (const item of page?.items || []) {
      const snippet = item.snippet || {};
      if (/^(private|deleted) video$/i.test(snippet.title || '')) { skipped += 1; continue; }
      const { title, artists } = cleanVideoTitle(snippet.title, snippet.videoOwnerChannelTitle);
      const videoId = item.contentDetails?.videoId || snippet.resourceId?.videoId || '';
      const track = makeTrack({ id: videoId ? `youtube:${videoId}` : '', title, artists, url: videoId ? `https://music.youtube.com/watch?v=${videoId}` : '' }, 'YouTube Music');
      if (track) tracks.push(track);
    }
    onProgress?.(tracks.length, expected);
    pageToken = page?.nextPageToken || '';
  } while (pageToken && tracks.length < 5000);

  const result = emptyResult();
  const thumbs = playlist.snippet?.thumbnails || {};
  const image = (thumbs.medium || thumbs.high || thumbs.default || {}).url || '';
  result.playlists.push(makePlaylist(playlist.snippet?.title || 'YouTube playlist', tracks, 'YouTube Music', {
    id: `youtube:playlist:${info.id}`,
    description: playlist.snippet?.description || '',
    image,
    url: `https://music.youtube.com/playlist?list=${encodeURIComponent(info.id)}`,
    owner: playlist.snippet?.channelTitle || 'YouTube',
    platform: 'youtube',
  }));
  if (skipped) result.notes.push(`${skipped} private or deleted ${skipped === 1 ? 'video was' : 'videos were'} skipped.`);
  result.notes.push('YouTube only gives video titles, so artist and song names are guessed from them — check the preview.');
  return result;
}
