// SoundCloud adapter — OAuth 2.1 with PKCE. SoundCloud's token endpoint also expects the
// client secret, so the exchange goes through a tiny token proxy (proxy/cloudflare-worker.js)
// or, for personal use only, directly with a secret stored in this browser.
import { ProviderBase, expiresAtFrom } from './base.js';
import { http } from '../http.js';
import { beginRedirectAuth, createPkcePair, randomState, getRedirectUri } from '../oauth.js';
import { matchViaSearch, trackQueries, albumQueries, scoreTrack, scoreAlbum, scoreArtist, bestMatch, parseArtistTitle, normalizeText, THRESHOLDS } from '../matching.js';

const AUTHORIZE_URL = 'https://secure.soundcloud.com/authorize';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const API = 'https://api.soundcloud.com';
const LIKED_ID = '__soundcloud_likes__';
const ALBUM_TYPES = new Set(['album', 'ep', 'single', 'compilation']);

const ref = (item) => item?.urn || (item?.id != null ? String(item.id) : '');
const isAlbum = (playlist) => Boolean(playlist?.is_album) || ALBUM_TYPES.has(String(playlist?.playlist_type || '').toLowerCase());

function toTrack(track) {
  if (!track || !ref(track)) return null;
  const uploader = track.user?.username || '';
  const publisherArtist = track.publisher_metadata?.artist || '';
  const parsed = parseArtistTitle(track.title, publisherArtist || uploader);
  const artists = publisherArtist && !parsed.artists.length ? [publisherArtist] : parsed.artists;
  return {
    id: ref(track),
    title: parsed.title,
    rawTitle: track.title,
    artists: artists.length ? artists : [uploader].filter(Boolean),
    uploader,
    album: track.publisher_metadata?.album_title || '',
    durationMs: track.duration || 0,
    isrc: track.isrc || track.publisher_metadata?.isrc || '',
    explicit: Boolean(track.publisher_metadata?.explicit),
    url: track.permalink_url || '',
    image: track.artwork_url || '',
  };
}

function toPlaylist(playlist) {
  return {
    id: ref(playlist),
    name: playlist.title,
    description: playlist.description || '',
    trackCount: playlist.track_count ?? playlist.tracks?.length ?? null,
    image: playlist.artwork_url || '',
    url: playlist.permalink_url || '',
    owner: playlist.user?.username || '',
    isPublic: playlist.sharing === 'public',
  };
}

function toAlbum(playlist) {
  return {
    id: ref(playlist),
    title: playlist.title,
    artists: [playlist.user?.username].filter(Boolean),
    upc: playlist.ean || '',
    year: playlist.release_year ? String(playlist.release_year) : (playlist.created_at || '').slice(0, 4),
    trackCount: playlist.track_count ?? null,
    image: playlist.artwork_url || '',
    url: playlist.permalink_url || '',
  };
}

const toArtist = (user) => ({ id: ref(user), name: user.username || user.full_name || '', image: user.avatar_url || '', url: user.permalink_url || '' });

export class SoundCloudProvider extends ProviderBase {
  constructor(config) {
    super('soundcloud', config);
    this.playlistTracks = new Map(); // playlist id → track refs (SoundCloud replaces the whole list on update)
  }

  isConfigured() {
    return Boolean(this.config.clientId && (this.config.tokenEndpoint || this.config.clientSecret));
  }

  missingConfigMessage() {
    if (this.config.clientId) return 'SoundCloud also needs a token proxy URL (or, for personal use, the client secret) next to the Client ID — open Settings to add it.';
    return super.missingConfigMessage();
  }

  async connect() {
    const { verifier, challenge } = await createPkcePair();
    return beginRedirectAuth({
      provider: this.id,
      verifier,
      authorizeUrl: AUTHORIZE_URL,
      params: {
        client_id: this.config.clientId,
        redirect_uri: getRedirectUri(),
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: randomState(),
      },
    });
  }

  async exchange(form) {
    if (this.config.tokenEndpoint) {
      return http(this.config.tokenEndpoint, { method: 'POST', json: { provider: 'soundcloud', ...form } });
    }
    return http(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json; charset=utf-8' },
      form: { client_id: this.config.clientId, client_secret: this.config.clientSecret, ...form },
    });
  }

  async finishConnect({ code, verifier }) {
    const data = await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: getRedirectUri(), code_verifier: verifier });
    if (!data?.access_token) throw new Error('SoundCloud did not return an access token.');
    this.setToken({ accessToken: data.access_token, refreshToken: data.refresh_token || null, expiresAt: expiresAtFrom(data.expires_in) });
  }

  async refresh(token) {
    const data = await this.exchange({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
    return { accessToken: data.access_token, refreshToken: data.refresh_token || token.refreshToken, expiresAt: expiresAtFrom(data.expires_in) };
  }

  authHeaders(token) {
    return { Authorization: `OAuth ${token.accessToken}`, Accept: 'application/json; charset=utf-8' };
  }

  api(path, options = {}) {
    return this.authedFetch(path.startsWith('http') ? path : API + path, options);
  }

  async *paginate(path, query = {}, { signal } = {}) {
    let url = path;
    let first = true;
    while (url) {
      const page = await this.api(url, { query: first ? { linked_partitioning: 'true', limit: 50, ...query } : undefined, signal });
      first = false;
      if (Array.isArray(page)) {
        yield page;
        return;
      }
      yield page?.collection || [];
      url = page?.next_href || null;
    }
  }

  async getProfile() {
    const me = await this.api('/me');
    this.profile = { id: ref(me), name: me.username || me.full_name || 'SoundCloud user', image: me.avatar_url || '', url: me.permalink_url || 'https://soundcloud.com/you' };
    return this.profile;
  }

  async listPlaylists({ signal } = {}) {
    const playlists = [
      { id: LIKED_ID, name: 'Liked tracks', description: 'Tracks you liked on SoundCloud', trackCount: null, image: '', url: 'https://soundcloud.com/you/likes', owner: 'You', isPublic: false, special: true },
    ];
    for await (const items of this.paginate('/me/playlists', { show_tracks: 'false' }, { signal })) {
      for (const item of items) if (item && !isAlbum(item)) playlists.push(toPlaylist(item));
    }
    return playlists;
  }

  async getPlaylistTracks(playlist, { signal, onProgress } = {}) {
    const tracks = [];
    const path = playlist.id === LIKED_ID ? '/me/likes/tracks' : `/playlists/${encodeURIComponent(playlist.id)}/tracks`;
    for await (const items of this.paginate(path, { limit: 200, access: 'playable,preview,blocked' }, { signal })) {
      for (const item of items) {
        const track = toTrack(item);
        if (track) tracks.push(track);
      }
      onProgress?.(tracks.length);
    }
    return tracks;
  }

  async listAlbums({ signal } = {}) {
    const albums = [];
    for await (const items of this.paginate('/me/likes/playlists', {}, { signal })) {
      for (const item of items) if (item && isAlbum(item)) albums.push(toAlbum(item));
    }
    return albums;
  }

  async listArtists({ signal } = {}) {
    const artists = [];
    for await (const items of this.paginate('/me/followings', { limit: 200 }, { signal })) {
      for (const item of items) if (item) artists.push(toArtist(item));
    }
    return artists;
  }

  async search(path, q, { signal, limit = 10, extra = {} } = {}) {
    const data = await this.api(path, { query: { q, limit, linked_partitioning: 'true', ...extra }, signal });
    return Array.isArray(data) ? data : data?.collection || [];
  }

  async findTrack(track, { signal } = {}) {
    const searchFn = async (query) => (await this.search('/tracks', query, { signal, extra: { access: 'playable,preview' } })).map(toTrack).filter(Boolean);
    const scorer = (source, candidate) => {
      let score = scoreTrack(source, candidate);
      const artist = normalizeText(source.artists?.[0] || '');
      if (artist && normalizeText(candidate.uploader).includes(artist)) score += 0.06;
      return Math.min(1, score);
    };
    const match = await matchViaSearch(track, trackQueries(track), searchFn, scorer, THRESHOLDS.track, { maxQueries: 2 });
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findAlbum(album, { signal } = {}) {
    const searchFn = async (query) => (await this.search('/playlists', query, { signal, extra: { show_tracks: 'false' } })).map((p) => ({ ...toAlbum(p), isAlbum: isAlbum(p) }));
    const scorer = (source, candidate) => Math.min(1, scoreAlbum(source, candidate) + (candidate.isAlbum ? 0.06 : -0.1));
    const match = await matchViaSearch(album, albumQueries(album), searchFn, scorer, THRESHOLDS.album);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findArtist(artist, { signal } = {}) {
    const users = await this.search('/users', artist.name, { signal });
    const candidates = users.map((user) => ({ ...toArtist(user), fullName: user.full_name || '', verified: Boolean(user.verified), followers: user.followers_count || 0 }));
    const scorer = (source, candidate) => {
      const byName = scoreArtist(source, candidate);
      const byFullName = candidate.fullName ? scoreArtist(source, { name: candidate.fullName }) : 0;
      let score = Math.max(byName, byFullName);
      if (candidate.verified) score += 0.05;
      if (candidate.followers > 10000) score += 0.03;
      return Math.min(1, score);
    };
    const match = bestMatch(artist, candidates, scorer, THRESHOLDS.artist);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async createPlaylist({ name, description, isPublic }, { signal } = {}) {
    const created = await this.api('/playlists', {
      method: 'POST',
      json: { playlist: { title: name.slice(0, 100), description: (description || '').slice(0, 1000), sharing: isPublic ? 'public' : 'private', tracks: [] } },
      signal,
    });
    const id = ref(created);
    if (!id) throw new Error('SoundCloud did not return the new playlist.');
    this.playlistTracks.set(id, []);
    return { id, url: created.permalink_url || 'https://soundcloud.com/you/sets' };
  }

  async addTracks(playlistId, trackIds, { signal, onProgress } = {}) {
    // SoundCloud playlists hold at most 500 tracks and are updated by sending the full list.
    const existing = this.playlistTracks.get(playlistId) || [];
    const all = Array.from(new Set([...existing, ...trackIds])).slice(0, 500);
    await this.api(`/playlists/${encodeURIComponent(playlistId)}`, {
      method: 'PUT',
      json: { playlist: { tracks: all.map((id) => (/^soundcloud:/.test(id) ? { urn: id } : { id: Number(id) || id })) } },
      signal,
    });
    this.playlistTracks.set(playlistId, all);
    onProgress?.(trackIds.length);
  }

  async saveAlbums(playlistIds, { signal } = {}) {
    for (const id of playlistIds) {
      await this.api(`/likes/playlists/${encodeURIComponent(id)}`, { method: 'POST', signal, parse: 'none' });
    }
  }

  async followArtists(userIds, { signal } = {}) {
    for (const id of userIds) {
      await this.api(`/me/followings/${encodeURIComponent(id)}`, { method: 'PUT', signal, parse: 'none' });
    }
  }
}
