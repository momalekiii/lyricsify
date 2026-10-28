// Spotify Web API adapter — Authorization Code with PKCE (no secret needed in the browser).
import { ProviderBase, AuthError, expiresAtFrom } from './base.js';
import { http, ApiError } from '../http.js';
import { beginRedirectAuth, createPkcePair, randomState, getRedirectUri } from '../oauth.js';
import { chunk, unique } from '../util.js';
import { matchViaSearch, trackQueries, albumQueries, scoreTrack, scoreAlbum, scoreArtist, bestMatch, THRESHOLDS } from '../matching.js';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'user-follow-modify',
  'user-read-private',
].join(' ');
const LIKED_ID = '__spotify_liked__';

const toTrack = (track) => {
  if (!track || track.type !== 'track' || track.is_local || !track.id) return null;
  return {
    id: track.id,
    uri: track.uri,
    title: track.name,
    artists: (track.artists || []).map((a) => a.name).filter(Boolean),
    album: track.album?.name || '',
    durationMs: track.duration_ms || 0,
    isrc: track.external_ids?.isrc || '',
    explicit: Boolean(track.explicit),
    url: track.external_urls?.spotify || '',
    image: track.album?.images?.[track.album.images.length - 1]?.url || '',
  };
};

const toAlbum = (album) => ({
  id: album.id,
  title: album.name,
  artists: (album.artists || []).map((a) => a.name),
  upc: album.external_ids?.upc || '',
  year: (album.release_date || '').slice(0, 4),
  trackCount: album.total_tracks || 0,
  image: album.images?.[1]?.url || album.images?.[0]?.url || '',
  url: album.external_urls?.spotify || '',
});

const toArtist = (artist) => ({
  id: artist.id,
  name: artist.name,
  image: artist.images?.[1]?.url || artist.images?.[0]?.url || '',
  url: artist.external_urls?.spotify || '',
});

export class SpotifyProvider extends ProviderBase {
  constructor(config) {
    super('spotify', config);
    this.matchConcurrency = 4;
  }

  isConfigured() {
    return Boolean(this.config.clientId);
  }

  async connect() {
    const { verifier, challenge } = await createPkcePair();
    return beginRedirectAuth({
      provider: this.id,
      verifier,
      authorizeUrl: AUTHORIZE_URL,
      params: {
        client_id: this.config.clientId,
        response_type: 'code',
        redirect_uri: getRedirectUri(),
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state: randomState(),
      },
    });
  }

  async finishConnect({ code, verifier }) {
    const data = await http(TOKEN_URL, {
      method: 'POST',
      form: { grant_type: 'authorization_code', code, redirect_uri: getRedirectUri(), client_id: this.config.clientId, code_verifier: verifier },
    });
    this.setToken({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: expiresAtFrom(data.expires_in),
      scope: data.scope || SCOPES,
    });
  }

  async refresh(token) {
    const data = await http(TOKEN_URL, {
      method: 'POST',
      form: { grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: this.config.clientId },
    });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || token.refreshToken,
      expiresAt: expiresAtFrom(data.expires_in),
      scope: data.scope || token.scope,
    };
  }

  api(path, options = {}) {
    return this.authedFetch(path.startsWith('http') ? path : API + path, options);
  }

  async *paginate(path, query, { signal } = {}) {
    let url = path;
    let first = true;
    while (url) {
      const page = await this.api(url, { query: first ? query : undefined, signal });
      first = false;
      const container = page.items ? page : page.artists || page;
      yield container;
      url = container.next || null;
    }
  }

  async getProfile() {
    let me;
    try {
      me = await this.api('/me');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        // Development-mode Spotify apps only admit users the app owner has allow-listed.
        throw new AuthError(this.id, 'Spotify let you log in but won’t let this site read your account: the Spotify app behind this site is in development mode, which only admits up to 25 people the site owner has allow-listed. Ask the owner to add the e-mail of your Spotify account under “User Management”, or use your own Spotify app via Advanced settings.');
      }
      throw error;
    }
    this.profile = { id: me.id, name: me.display_name || me.id, image: me.images?.[0]?.url || '', url: me.external_urls?.spotify || '', country: me.country || '' };
    return this.profile;
  }

  async userId() {
    if (!this.profile) await this.getProfile();
    return this.profile.id;
  }

  async listPlaylists({ signal } = {}) {
    const playlists = [
      { id: LIKED_ID, name: 'Liked Songs', description: 'Your saved tracks on Spotify', trackCount: null, image: '', url: 'https://open.spotify.com/collection/tracks', owner: 'You', isPublic: false, special: true },
    ];
    for await (const page of this.paginate('/me/playlists', { limit: 50 }, { signal })) {
      for (const item of page.items || []) {
        if (!item) continue;
        playlists.push({
          id: item.id,
          name: item.name,
          description: item.description || '',
          trackCount: item.tracks?.total ?? null,
          image: item.images?.[0]?.url || '',
          url: item.external_urls?.spotify || '',
          owner: item.owner?.display_name || item.owner?.id || '',
          isPublic: Boolean(item.public),
        });
      }
    }
    return playlists;
  }

  async getPlaylistTracks(playlist, { signal, onProgress } = {}) {
    const tracks = [];
    if (playlist.id === LIKED_ID) {
      for await (const page of this.paginate('/me/tracks', { limit: 50 }, { signal })) {
        for (const item of page.items || []) {
          const track = toTrack(item?.track);
          if (track) tracks.push(track);
        }
        onProgress?.(tracks.length);
      }
      return tracks;
    }
    const fields = 'next,items(track(id,uri,name,type,is_local,duration_ms,explicit,external_ids(isrc),external_urls(spotify),artists(name),album(name,images)))';
    for await (const page of this.paginate(`/playlists/${playlist.id}/tracks`, { limit: 50, fields, additional_types: 'track' }, { signal })) {
      for (const item of page.items || []) {
        const track = toTrack(item?.track);
        if (track) tracks.push(track);
      }
      onProgress?.(tracks.length);
    }
    return tracks;
  }

  async listAlbums({ signal } = {}) {
    const albums = [];
    for await (const page of this.paginate('/me/albums', { limit: 50 }, { signal })) {
      for (const item of page.items || []) if (item?.album) albums.push(toAlbum(item.album));
    }
    return albums;
  }

  async listArtists({ signal } = {}) {
    const artists = [];
    for await (const page of this.paginate('/me/following', { type: 'artist', limit: 50 }, { signal })) {
      for (const item of page.items || []) if (item) artists.push(toArtist(item));
    }
    return artists;
  }

  async search(query, type, { signal, limit = 10 } = {}) {
    const data = await this.api('/search', { query: { q: query, type, limit, market: 'from_token' }, signal });
    return data?.[`${type}s`]?.items || [];
  }

  async findTrack(track, { signal } = {}) {
    if (track.isrc) {
      const items = await this.search(`isrc:${track.isrc}`, 'track', { signal, limit: 5 }).catch(() => []);
      const candidates = items.map(toTrack).filter(Boolean);
      const exact = bestMatch(track, candidates, scoreTrack, 0.5);
      if (exact) return { ...exact.candidate, score: 1 };
    }
    const searchFn = async (query) => (await this.search(query, 'track', { signal })).map(toTrack).filter(Boolean);
    const artist = track.artists?.[0];
    const queries = unique([artist ? `track:${track.title} artist:${artist}` : null, ...trackQueries(track)].filter(Boolean));
    const match = await matchViaSearch(track, queries, searchFn, scoreTrack, THRESHOLDS.track, { maxQueries: 3 });
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findAlbum(album, { signal } = {}) {
    if (album.upc) {
      const items = await this.search(`upc:${album.upc}`, 'album', { signal, limit: 5 }).catch(() => []);
      if (items.length) return { ...toAlbum(items[0]), score: 1 };
    }
    const searchFn = async (query) => (await this.search(query, 'album', { signal })).map(toAlbum);
    const artist = album.artists?.[0];
    const queries = unique([artist ? `album:${album.title} artist:${artist}` : null, ...albumQueries(album)].filter(Boolean));
    const match = await matchViaSearch(album, queries, searchFn, scoreAlbum, THRESHOLDS.album, { maxQueries: 2 });
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findArtist(artist, { signal } = {}) {
    const items = await this.search(artist.name, 'artist', { signal, limit: 10 });
    const match = bestMatch(artist, items.map(toArtist), scoreArtist, THRESHOLDS.artist);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async createPlaylist({ name, description, isPublic }, { signal } = {}) {
    const userId = await this.userId();
    const created = await this.api(`/users/${encodeURIComponent(userId)}/playlists`, {
      method: 'POST',
      json: { name: name.slice(0, 100), description: (description || '').slice(0, 300), public: Boolean(isPublic) },
      signal,
    });
    return { id: created.id, url: created.external_urls?.spotify || `https://open.spotify.com/playlist/${created.id}` };
  }

  async addTracks(playlistId, trackIds, { signal, onProgress } = {}) {
    let added = 0;
    for (const batch of chunk(trackIds, 100)) {
      await this.api(`/playlists/${playlistId}/tracks`, { method: 'POST', json: { uris: batch.map((id) => `spotify:track:${id}`) }, signal });
      added += batch.length;
      onProgress?.(added);
    }
  }

  async saveAlbums(albumIds, { signal } = {}) {
    for (const batch of chunk(albumIds, 20)) {
      await this.api('/me/albums', { method: 'PUT', json: { ids: batch }, signal, parse: 'none' });
    }
  }

  async followArtists(artistIds, { signal } = {}) {
    for (const batch of chunk(artistIds, 50)) {
      await this.api('/me/following', { method: 'PUT', query: { type: 'artist' }, json: { ids: batch }, signal, parse: 'none' });
    }
  }
}

export { ApiError };
