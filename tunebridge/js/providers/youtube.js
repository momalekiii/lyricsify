// YouTube Music adapter — uses the YouTube Data API v3 with Google's browser (implicit) OAuth flow.
// Quota note: search = 100 units, insert = 50 units, list = 1 unit (10,000 units/day by default).
import { ProviderBase, expiresAtFrom, CapabilityError } from './base.js';
import { ApiError } from '../http.js';
import { beginRedirectAuth, randomState, getRedirectUri } from '../oauth.js';
import { chunk, parseIsoDuration } from '../util.js';
import { bestMatch, scoreTrack, scoreArtist, cleanChannelName, parseArtistTitle, trackQueries, primaryArtist, normalizeText, THRESHOLDS } from '../matching.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const LIKED_MUSIC_ID = 'LM';

export const quota = { used: 0, limit: 10000 };
const spend = (units) => {
  quota.used += units;
};

const isTopic = (channel) => /\s-\sTopic$/i.test(channel || '');

function videoToTrack({ videoId, title, channelTitle, durationMs = 0, thumbnail = '' }) {
  const parsed = isTopic(channelTitle) ? { artists: [cleanChannelName(channelTitle)], title } : parseArtistTitle(title, cleanChannelName(channelTitle));
  return {
    id: videoId,
    title: parsed.title,
    rawTitle: title,
    artists: parsed.artists,
    channel: channelTitle || '',
    album: '',
    durationMs,
    isrc: '',
    explicit: false,
    url: `https://music.youtube.com/watch?v=${videoId}`,
    image: thumbnail,
  };
}

export class YouTubeMusicProvider extends ProviderBase {
  constructor(config) {
    super('youtube', config);
    this.matchConcurrency = 1; // keep quota usage predictable and avoid write conflicts
  }

  isConfigured() {
    return Boolean(this.config.clientId);
  }

  async connect() {
    return beginRedirectAuth({
      provider: this.id,
      authorizeUrl: AUTHORIZE_URL,
      params: {
        client_id: this.config.clientId,
        redirect_uri: getRedirectUri(),
        response_type: 'token',
        scope: SCOPE,
        include_granted_scopes: 'true',
        prompt: 'select_account',
        state: randomState(),
      },
    });
  }

  async finishConnect({ token, expiresIn }) {
    if (!token) throw new Error('Google did not return an access token.');
    this.setToken({ accessToken: token, refreshToken: null, expiresAt: expiresAtFrom(expiresIn || 3600) });
  }

  async api(path, { cost = 1, ...options } = {}) {
    spend(cost);
    try {
      return await this.authedFetch(path.startsWith('http') ? path : API + path, options);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && /quota/i.test(error.code || error.message)) {
        throw new ApiError('YouTube API quota exceeded for today. Google resets quotas at midnight Pacific time; you can also request a higher quota in the Google Cloud console.', { status: 403, code: 'quotaExceeded' });
      }
      throw error;
    }
  }

  async *paginate(path, query, { signal } = {}) {
    let pageToken;
    do {
      const page = await this.api(path, { query: { ...query, maxResults: 50, pageToken }, signal });
      yield page.items || [];
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  async getProfile() {
    const data = await this.api('/channels', { query: { part: 'snippet', mine: 'true' } });
    const channel = data.items?.[0];
    this.profile = {
      id: channel?.id || 'me',
      name: channel?.snippet?.title || 'YouTube account',
      image: channel?.snippet?.thumbnails?.default?.url || '',
      url: channel ? `https://music.youtube.com/channel/${channel.id}` : 'https://music.youtube.com',
    };
    return this.profile;
  }

  async listPlaylists({ signal } = {}) {
    const playlists = [
      { id: LIKED_MUSIC_ID, name: 'Liked Music', description: 'Songs you liked on YouTube Music', trackCount: null, image: '', url: 'https://music.youtube.com/playlist?list=LM', owner: 'You', isPublic: false, special: true },
    ];
    for await (const items of this.paginate('/playlists', { part: 'snippet,contentDetails,status', mine: 'true' }, { signal })) {
      for (const item of items) {
        playlists.push({
          id: item.id,
          name: item.snippet?.title || 'Untitled',
          description: item.snippet?.description || '',
          trackCount: item.contentDetails?.itemCount ?? null,
          image: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
          url: `https://music.youtube.com/playlist?list=${item.id}`,
          owner: 'You',
          isPublic: item.status?.privacyStatus === 'public',
        });
      }
    }
    return playlists;
  }

  async getPlaylistTracks(playlist, { signal, onProgress } = {}) {
    const raw = [];
    for await (const items of this.paginate('/playlistItems', { part: 'snippet,contentDetails', playlistId: playlist.id }, { signal })) {
      for (const item of items) {
        const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
        const title = item.snippet?.title || '';
        if (!videoId || /^(private|deleted) video$/i.test(title)) continue;
        raw.push({ videoId, title, channelTitle: item.snippet?.videoOwnerChannelTitle || '', thumbnail: item.snippet?.thumbnails?.default?.url || '' });
      }
      onProgress?.(raw.length);
    }
    // Durations (and better channel names) come from videos.list — 1 unit per 50 videos.
    const durations = new Map();
    const channels = new Map();
    for (const batch of chunk(raw, 50)) {
      const data = await this.api('/videos', { query: { part: 'contentDetails,snippet', id: batch.map((v) => v.videoId).join(',') }, signal }).catch(() => null);
      for (const video of data?.items || []) {
        durations.set(video.id, parseIsoDuration(video.contentDetails?.duration));
        if (video.snippet?.channelTitle) channels.set(video.id, video.snippet.channelTitle);
      }
    }
    return raw.map((video) => videoToTrack({ ...video, channelTitle: channels.get(video.videoId) || video.channelTitle, durationMs: durations.get(video.videoId) || 0 }));
  }

  async listAlbums() {
    throw new CapabilityError('The YouTube Data API does not expose saved albums.');
  }

  async listArtists({ signal } = {}) {
    const artists = [];
    for await (const items of this.paginate('/subscriptions', { part: 'snippet', mine: 'true' }, { signal })) {
      for (const item of items) {
        const channelId = item.snippet?.resourceId?.channelId;
        if (!channelId) continue;
        artists.push({ id: channelId, name: cleanChannelName(item.snippet?.title || ''), image: item.snippet?.thumbnails?.default?.url || '', url: `https://music.youtube.com/channel/${channelId}` });
      }
    }
    return artists;
  }

  async searchVideos(query, { signal } = {}) {
    const data = await this.api('/search', { cost: 100, query: { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: 6, q: query }, signal });
    const items = (data.items || []).filter((item) => item.id?.videoId);
    if (!items.length) return [];
    const details = await this.api('/videos', { query: { part: 'contentDetails', id: items.map((i) => i.id.videoId).join(',') }, signal }).catch(() => null);
    const durations = new Map((details?.items || []).map((v) => [v.id, parseIsoDuration(v.contentDetails?.duration)]));
    return items.map((item) => videoToTrack({
      videoId: item.id.videoId,
      title: item.snippet?.title || '',
      channelTitle: item.snippet?.channelTitle || '',
      durationMs: durations.get(item.id.videoId) || 0,
      thumbnail: item.snippet?.thumbnails?.default?.url || '',
    }));
  }

  async findTrack(track, { signal } = {}) {
    // One search per track keeps quota usage predictable (100 units + 1 for durations).
    const query = trackQueries(track)[0];
    const candidates = await this.searchVideos(query, { signal });
    const scorer = (source, candidate) => {
      let score = scoreTrack(source, candidate);
      if (isTopic(candidate.channel)) score += 0.08; // "Artist - Topic" uploads are the actual songs on YouTube Music
      const artist = normalizeText(primaryArtist(source.artists));
      if (artist && normalizeText(candidate.channel).includes(artist)) score += 0.05;
      return Math.min(1, score);
    };
    const match = bestMatch(track, candidates, scorer, THRESHOLDS.track);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findAlbum() {
    throw new CapabilityError('YouTube Music albums cannot be saved through the YouTube Data API.');
  }

  async findArtist(artist, { signal } = {}) {
    const data = await this.api('/search', { cost: 100, query: { part: 'snippet', type: 'channel', maxResults: 6, q: `${artist.name} official` }, signal });
    const candidates = (data.items || []).map((item) => ({
      id: item.id?.channelId || item.snippet?.channelId,
      name: cleanChannelName(item.snippet?.channelTitle || item.snippet?.title || ''),
      image: item.snippet?.thumbnails?.default?.url || '',
      url: `https://music.youtube.com/channel/${item.id?.channelId || item.snippet?.channelId}`,
      topic: isTopic(item.snippet?.channelTitle || item.snippet?.title),
    })).filter((c) => c.id);
    const scorer = (source, candidate) => scoreArtist(source, candidate) - (candidate.topic ? 0.02 : 0);
    const match = bestMatch(artist, candidates, scorer, THRESHOLDS.artist - 0.05);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async createPlaylist({ name, description, isPublic }, { signal } = {}) {
    const created = await this.api('/playlists', {
      cost: 50,
      method: 'POST',
      query: { part: 'snippet,status' },
      json: { snippet: { title: name.slice(0, 150), description: (description || '').slice(0, 5000) }, status: { privacyStatus: isPublic ? 'public' : 'private' } },
      signal,
    });
    return { id: created.id, url: `https://music.youtube.com/playlist?list=${created.id}` };
  }

  async addTracks(playlistId, videoIds, { signal, onProgress } = {}) {
    let added = 0;
    for (const videoId of videoIds) {
      await this.api('/playlistItems', {
        cost: 50,
        method: 'POST',
        query: { part: 'snippet' },
        json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
        signal,
      });
      added += 1;
      onProgress?.(added);
    }
  }

  async followArtists(channelIds, { signal } = {}) {
    for (const channelId of channelIds) {
      try {
        await this.api('/subscriptions', { cost: 50, method: 'POST', query: { part: 'snippet' }, json: { snippet: { resourceId: { kind: 'youtube#channel', channelId } } }, signal });
      } catch (error) {
        if (error instanceof ApiError && /subscriptionDuplicate/i.test(error.code || '')) continue;
        throw error;
      }
    }
  }
}
