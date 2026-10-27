// Deezer adapter — implicit OAuth (response_type=token) + the public REST API.
// Deezer returns errors inside 200 responses and sometimes blocks cross-origin fetches,
// so every call goes through dz(), which validates payloads and falls back to JSONP.
import { ProviderBase, AuthError, expiresAtFrom } from './base.js';
import { http, jsonp, withQuery, ApiError } from '../http.js';
import { beginRedirectAuth, randomState, getRedirectUri } from '../oauth.js';
import { chunk } from '../util.js';
import { matchViaSearch, trackQueries, albumQueries, scoreTrack, scoreAlbum, scoreArtist, bestMatch, THRESHOLDS } from '../matching.js';

const AUTHORIZE_URL = 'https://connect.deezer.com/oauth/auth.php';
const API = 'https://api.deezer.com';
const PERMS = 'basic_access,manage_library,offline_access';

const toTrack = (track) => {
  if (!track?.id) return null;
  const title = track.title_version && track.title_short && !track.title?.includes(track.title_version) ? `${track.title_short} ${track.title_version}` : track.title || track.title_short;
  return {
    id: String(track.id),
    title,
    artists: [track.artist?.name].filter(Boolean),
    album: track.album?.title || '',
    durationMs: (track.duration || 0) * 1000,
    isrc: track.isrc || '',
    explicit: Boolean(track.explicit_lyrics),
    url: track.link || `https://www.deezer.com/track/${track.id}`,
    image: track.album?.cover_small || '',
  };
};

const toAlbum = (album) => ({
  id: String(album.id),
  title: album.title,
  artists: [album.artist?.name].filter(Boolean),
  upc: album.upc || '',
  year: (album.release_date || '').slice(0, 4),
  trackCount: album.nb_tracks || 0,
  image: album.cover_medium || album.cover || '',
  url: album.link || `https://www.deezer.com/album/${album.id}`,
});

const toArtist = (artist) => ({ id: String(artist.id), name: artist.name, image: artist.picture_medium || artist.picture || '', url: artist.link || `https://www.deezer.com/artist/${artist.id}` });

export class DeezerProvider extends ProviderBase {
  constructor(config) {
    super('deezer', config);
    this.useJsonp = false;
  }

  isConfigured() {
    return Boolean(this.config.appId);
  }

  async connect() {
    // Implicit flow by default (no secret). If a token proxy is configured, use the code flow instead.
    const useCodeFlow = Boolean(this.config.tokenEndpoint);
    return beginRedirectAuth({
      provider: this.id,
      authorizeUrl: AUTHORIZE_URL,
      params: { app_id: this.config.appId, redirect_uri: getRedirectUri(), perms: PERMS, response_type: useCodeFlow ? 'code' : 'token', state: randomState() },
    });
  }

  async finishConnect({ token, code, expiresIn }) {
    if (!token && code && this.config.tokenEndpoint) {
      const data = await http(this.config.tokenEndpoint, { method: 'POST', json: { provider: 'deezer', grant_type: 'authorization_code', code, redirect_uri: getRedirectUri() } });
      token = data?.access_token;
      expiresIn = data?.expires || data?.expires_in || 0;
    }
    if (!token) throw new Error('Deezer did not return an access token.');
    // expires=0 means a non-expiring token (offline_access).
    this.setToken({ accessToken: token, refreshToken: null, expiresAt: expiresIn ? expiresAtFrom(expiresIn) : null });
  }

  /** Deezer call with query-string auth, error unwrapping and JSONP fallback. */
  async dz(path, { query = {}, method = 'GET', signal } = {}) {
    const token = await this.ensureToken();
    const params = { ...query, access_token: token.accessToken };
    const url = API + path;
    let data;
    if (!this.useJsonp) {
      try {
        data = await http(withQuery(url, params), { method, signal, headers: {}, retries: 0 });
      } catch (error) {
        if (error instanceof ApiError && error.status === 0 && typeof document !== 'undefined') this.useJsonp = true;
        else throw error;
      }
    }
    if (this.useJsonp) {
      data = await jsonp(withQuery(url, { ...params, output: 'jsonp', request_method: method !== 'GET' ? method : undefined }));
    }
    if (data && typeof data === 'object' && data.error) {
      const { code, message, type } = data.error;
      if (code === 300 || code === 200 || /OAuthException/i.test(type || '')) {
        this.disconnect();
        throw new AuthError(this.id);
      }
      throw new ApiError(message || type || 'Deezer request failed', { status: 400, code: String(code || type || '') });
    }
    return data;
  }

  async *paginate(path, query = {}, { signal } = {}) {
    let index = 0;
    const limit = query.limit || 100;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.dz(path, { query: { ...query, limit, index }, signal });
      const items = page?.data || [];
      yield items;
      if (!page?.next || items.length === 0) break;
      index += items.length;
    }
  }

  async getProfile() {
    const me = await this.dz('/user/me');
    this.profile = { id: String(me.id), name: me.name || me.firstname || 'Deezer user', image: me.picture_small || '', url: me.link || 'https://www.deezer.com/profile/me', country: me.country || '' };
    return this.profile;
  }

  async listPlaylists({ signal } = {}) {
    const playlists = [];
    for await (const items of this.paginate('/user/me/playlists', {}, { signal })) {
      for (const item of items) {
        playlists.push({
          id: String(item.id),
          name: item.title,
          description: item.description || '',
          trackCount: item.nb_tracks ?? null,
          image: item.picture_medium || item.picture || '',
          url: item.link || `https://www.deezer.com/playlist/${item.id}`,
          owner: item.creator?.name || '',
          isPublic: Boolean(item.public),
          special: Boolean(item.is_loved_track),
        });
      }
    }
    return playlists;
  }

  async getPlaylistTracks(playlist, { signal, onProgress } = {}) {
    const tracks = [];
    for await (const items of this.paginate(`/playlist/${playlist.id}/tracks`, {}, { signal })) {
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
    for await (const items of this.paginate('/user/me/albums', {}, { signal })) {
      for (const item of items) albums.push(toAlbum(item));
    }
    return albums;
  }

  async listArtists({ signal } = {}) {
    const artists = [];
    for await (const items of this.paginate('/user/me/artists', {}, { signal })) {
      for (const item of items) artists.push(toArtist(item));
    }
    return artists;
  }

  async search(kind, q, { signal, limit = 10 } = {}) {
    const data = await this.dz(`/search/${kind}`, { query: { q, limit }, signal });
    return data?.data || [];
  }

  async findTrack(track, { signal } = {}) {
    if (track.isrc) {
      const data = await this.dz(`/track/isrc:${encodeURIComponent(track.isrc)}`, { signal }).catch(() => null);
      const candidate = toTrack(data);
      if (candidate) return { ...candidate, score: 1 };
    }
    const searchFn = async (query) => (await this.search('track', query, { signal })).map(toTrack).filter(Boolean);
    const artist = track.artists?.[0];
    const queries = [artist ? `artist:"${artist}" track:"${track.title}"` : null, ...trackQueries(track)].filter(Boolean);
    const match = await matchViaSearch(track, queries, searchFn, scoreTrack, THRESHOLDS.track, { maxQueries: 3 });
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findAlbum(album, { signal } = {}) {
    if (album.upc) {
      const data = await this.dz(`/album/upc:${encodeURIComponent(album.upc)}`, { signal }).catch(() => null);
      if (data?.id) return { ...toAlbum(data), score: 1 };
    }
    const searchFn = async (query) => (await this.search('album', query, { signal })).map(toAlbum);
    const artist = album.artists?.[0];
    const queries = [artist ? `artist:"${artist}" album:"${album.title}"` : null, ...albumQueries(album)].filter(Boolean);
    const match = await matchViaSearch(album, queries, searchFn, scoreAlbum, THRESHOLDS.album, { maxQueries: 2 });
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findArtist(artist, { signal } = {}) {
    const items = await this.search('artist', artist.name, { signal });
    const match = bestMatch(artist, items.map(toArtist), scoreArtist, THRESHOLDS.artist);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async createPlaylist({ name, description, isPublic }, { signal } = {}) {
    const created = await this.dz('/user/me/playlists', { method: 'POST', query: { title: name.slice(0, 100) }, signal });
    const id = created?.id;
    if (!id) throw new Error('Deezer did not return the new playlist.');
    if (description || isPublic) {
      await this.dz(`/playlist/${id}`, { method: 'POST', query: { description: (description || '').slice(0, 500), public: isPublic ? 'true' : 'false' }, signal }).catch(() => null);
    }
    return { id: String(id), url: `https://www.deezer.com/playlist/${id}` };
  }

  async addTracks(playlistId, trackIds, { signal, onProgress } = {}) {
    let added = 0;
    for (const batch of chunk(trackIds, 50)) {
      await this.dz(`/playlist/${playlistId}/tracks`, { method: 'POST', query: { songs: batch.join(',') }, signal });
      added += batch.length;
      onProgress?.(added);
    }
  }

  async saveAlbums(albumIds, { signal } = {}) {
    for (const id of albumIds) await this.dz('/user/me/albums', { method: 'POST', query: { album_id: id }, signal });
  }

  async followArtists(artistIds, { signal } = {}) {
    for (const id of artistIds) await this.dz('/user/me/artists', { method: 'POST', query: { artist_id: id }, signal });
  }
}
