// TIDAL adapter — TIDAL Developer Platform (OAuth 2.1 PKCE + JSON:API v2 at openapi.tidal.com).
import { ProviderBase, expiresAtFrom } from './base.js';
import { http, ApiError } from '../http.js';
import { beginRedirectAuth, createPkcePair, randomState, getRedirectUri } from '../oauth.js';
import { chunk, parseIsoDuration } from '../util.js';
import { matchViaSearch, trackQueries, albumQueries, scoreTrack, scoreAlbum, scoreArtist, bestMatch, THRESHOLDS } from '../matching.js';

const AUTHORIZE_URL = 'https://login.tidal.com/authorize';
const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const API = 'https://openapi.tidal.com/v2';
const SCOPES = ['user.read', 'collection.read', 'collection.write', 'playlists.read', 'playlists.write', 'search.read'].join(' ');
const JSON_API = 'application/vnd.api+json';
const COLLECTION_TRACKS_ID = '__tidal_collection_tracks__';

const imageOf = (attrs) => {
  const links = attrs?.imageLinks || attrs?.coverArt?.data?.[0]?.attributes?.files || [];
  const sorted = [...links].filter((l) => l?.href).sort((a, b) => (a.meta?.width || 0) - (b.meta?.width || 0));
  return sorted.find((l) => (l.meta?.width || 0) >= 160)?.href || sorted[0]?.href || '';
};

function indexIncluded(included = []) {
  const map = new Map();
  for (const item of included) map.set(`${item.type}:${item.id}`, item);
  return map;
}

function namesFor(resource, relation, index) {
  const ids = resource?.relationships?.[relation]?.data || [];
  return ids.map((r) => index.get(`${r.type}:${r.id}`)?.attributes?.name).filter(Boolean);
}

function toTrack(resource, index = new Map()) {
  const attrs = resource?.attributes;
  if (!attrs) return null;
  const albumId = resource.relationships?.albums?.data?.[0];
  return {
    id: String(resource.id),
    title: attrs.version && !new RegExp(attrs.version, 'i').test(attrs.title) ? `${attrs.title} (${attrs.version})` : attrs.title,
    artists: namesFor(resource, 'artists', index),
    album: albumId ? index.get(`${albumId.type}:${albumId.id}`)?.attributes?.title || '' : '',
    durationMs: parseIsoDuration(attrs.duration),
    isrc: attrs.isrc || '',
    explicit: Boolean(attrs.explicit),
    url: attrs.externalLinks?.find((l) => l.meta?.type === 'TIDAL_SHARING')?.href || `https://tidal.com/browse/track/${resource.id}`,
    image: '',
  };
}

function toAlbum(resource, index = new Map()) {
  const attrs = resource?.attributes || {};
  return {
    id: String(resource.id),
    title: attrs.title,
    artists: namesFor(resource, 'artists', index),
    upc: attrs.barcodeId || '',
    year: (attrs.releaseDate || '').slice(0, 4),
    trackCount: attrs.numberOfItems || 0,
    image: imageOf(attrs),
    url: attrs.externalLinks?.find((l) => l.meta?.type === 'TIDAL_SHARING')?.href || `https://tidal.com/browse/album/${resource.id}`,
  };
}

const toArtist = (resource) => ({
  id: String(resource.id),
  name: resource.attributes?.name || '',
  image: imageOf(resource.attributes),
  url: resource.attributes?.externalLinks?.find((l) => l.meta?.type === 'TIDAL_SHARING')?.href || `https://tidal.com/browse/artist/${resource.id}`,
});

export class TidalProvider extends ProviderBase {
  constructor(config) {
    super('tidal', config);
    this.country = 'US';
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
        response_type: 'code',
        client_id: this.config.clientId,
        redirect_uri: getRedirectUri(),
        scope: this.config.scopes || SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state: randomState(),
      },
    });
  }

  async finishConnect({ code, verifier }) {
    const data = await http(TOKEN_URL, {
      method: 'POST',
      form: { grant_type: 'authorization_code', client_id: this.config.clientId, code, redirect_uri: getRedirectUri(), code_verifier: verifier },
    });
    this.setToken({ accessToken: data.access_token, refreshToken: data.refresh_token || null, expiresAt: expiresAtFrom(data.expires_in), userId: data.user_id || data.user?.userId || null });
  }

  async refresh(token) {
    const data = await http(TOKEN_URL, { method: 'POST', form: { grant_type: 'refresh_token', client_id: this.config.clientId, refresh_token: token.refreshToken } });
    return { ...token, accessToken: data.access_token, refreshToken: data.refresh_token || token.refreshToken, expiresAt: expiresAtFrom(data.expires_in) };
  }

  authHeaders(token) {
    return { Authorization: `Bearer ${token.accessToken}`, Accept: JSON_API };
  }

  api(path, options = {}) {
    const url = path.startsWith('http') ? path : API + path;
    const headers = { ...(options.headers || {}) };
    if (options.json !== undefined) headers['Content-Type'] = JSON_API;
    return this.authedFetch(url, { ...options, headers });
  }

  async *paginate(path, query = {}, { signal } = {}) {
    let next = path;
    let first = true;
    while (next) {
      const page = await this.api(next, { query: first ? { countryCode: this.country, ...query } : undefined, signal });
      first = false;
      yield page || {};
      next = page?.links?.next || null;
    }
  }

  async getProfile() {
    const me = await this.api('/users/me');
    const data = me?.data || {};
    this.country = data.attributes?.country || this.country;
    this.profile = { id: String(data.id), name: data.attributes?.username || data.attributes?.firstName || 'TIDAL user', image: '', url: 'https://tidal.com', country: this.country };
    return this.profile;
  }

  async userId() {
    if (!this.profile) await this.getProfile();
    return this.profile.id;
  }

  async listPlaylists({ signal } = {}) {
    const userId = await this.userId();
    const playlists = [
      { id: COLLECTION_TRACKS_ID, name: 'My Collection — Tracks', description: 'Tracks saved to your TIDAL collection', trackCount: null, image: '', url: 'https://tidal.com/my-collection/tracks', owner: 'You', isPublic: false, special: true },
    ];
    const seen = new Set();
    const push = (resource) => {
      if (!resource?.attributes || seen.has(resource.id)) return;
      seen.add(resource.id);
      const attrs = resource.attributes;
      playlists.push({
        id: String(resource.id),
        name: attrs.name,
        description: attrs.description || '',
        trackCount: attrs.numberOfItems ?? null,
        image: imageOf(attrs),
        url: attrs.externalLinks?.find((l) => l.meta?.type === 'TIDAL_SHARING')?.href || `https://tidal.com/browse/playlist/${resource.id}`,
        owner: 'You',
        isPublic: attrs.accessType === 'PUBLIC',
      });
    };
    try {
      for await (const page of this.paginate(`/userCollections/${userId}/relationships/playlists`, { include: 'playlists' }, { signal })) {
        for (const item of page.included || []) if (item.type === 'playlists') push(item);
      }
    } catch (error) {
      if (!(error instanceof ApiError) || ![400, 403, 404, 405].includes(error.status)) throw error;
      for await (const page of this.paginate('/playlists', { 'filter[r.owners.id]': userId }, { signal })) {
        for (const item of page.data || []) push(item);
      }
    }
    return playlists;
  }

  /** Fetch full track resources (with artist names) for a list of ids. */
  async hydrateTracks(ids, { signal } = {}) {
    const tracks = [];
    for (const batch of chunk(ids, 20)) {
      const page = await this.api('/tracks', { query: { countryCode: this.country, 'filter[id]': batch.join(','), include: 'artists,albums' }, signal });
      const index = indexIncluded(page.included);
      const byId = new Map((page.data || []).map((t) => [String(t.id), toTrack(t, index)]));
      for (const id of batch) if (byId.get(String(id))) tracks.push(byId.get(String(id)));
    }
    return tracks;
  }

  async getPlaylistTracks(playlist, { signal, onProgress } = {}) {
    const userId = await this.userId();
    const path = playlist.id === COLLECTION_TRACKS_ID ? `/userCollections/${userId}/relationships/tracks` : `/playlists/${playlist.id}/relationships/items`;
    const ids = [];
    for await (const page of this.paginate(path, {}, { signal })) {
      for (const item of page.data || []) if (item.type === 'tracks') ids.push(String(item.id));
      onProgress?.(ids.length);
    }
    return this.hydrateTracks(ids, { signal });
  }

  async listAlbums({ signal } = {}) {
    const userId = await this.userId();
    const ids = [];
    for await (const page of this.paginate(`/userCollections/${userId}/relationships/albums`, {}, { signal })) {
      for (const item of page.data || []) if (item.type === 'albums') ids.push(String(item.id));
    }
    const albums = [];
    for (const batch of chunk(ids, 20)) {
      const page = await this.api('/albums', { query: { countryCode: this.country, 'filter[id]': batch.join(','), include: 'artists' }, signal });
      const index = indexIncluded(page.included);
      for (const album of page.data || []) albums.push(toAlbum(album, index));
    }
    return albums;
  }

  async listArtists({ signal } = {}) {
    const userId = await this.userId();
    const ids = [];
    for await (const page of this.paginate(`/userCollections/${userId}/relationships/artists`, {}, { signal })) {
      for (const item of page.data || []) if (item.type === 'artists') ids.push(String(item.id));
    }
    const artists = [];
    for (const batch of chunk(ids, 20)) {
      const page = await this.api('/artists', { query: { countryCode: this.country, 'filter[id]': batch.join(',') }, signal });
      for (const artist of page.data || []) artists.push(toArtist(artist));
    }
    return artists;
  }

  async searchIds(query, type, { signal } = {}) {
    const page = await this.api(`/searchResults/${encodeURIComponent(query)}`, { query: { countryCode: this.country, include: type }, signal });
    const ids = (page?.data?.relationships?.[type]?.data || []).map((r) => String(r.id));
    const included = (page?.included || []).filter((r) => r.type === type);
    return { ids: ids.length ? ids : included.map((r) => String(r.id)), included };
  }

  async findTrack(track, { signal } = {}) {
    if (track.isrc) {
      const page = await this.api('/tracks', { query: { countryCode: this.country, 'filter[isrc]': track.isrc, include: 'artists,albums' }, signal }).catch(() => null);
      const index = indexIncluded(page?.included);
      const candidates = (page?.data || []).map((t) => toTrack(t, index)).filter(Boolean);
      const match = bestMatch(track, candidates, scoreTrack, 0.5);
      if (match) return { ...match.candidate, score: 1 };
    }
    const searchFn = async (query) => {
      const { ids } = await this.searchIds(query, 'tracks', { signal });
      return this.hydrateTracks(ids.slice(0, 10), { signal });
    };
    const match = await matchViaSearch(track, trackQueries(track), searchFn, scoreTrack, THRESHOLDS.track, { maxQueries: 2 });
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findAlbum(album, { signal } = {}) {
    if (album.upc) {
      const page = await this.api('/albums', { query: { countryCode: this.country, 'filter[barcodeId]': album.upc, include: 'artists' }, signal }).catch(() => null);
      if (page?.data?.length) return { ...toAlbum(page.data[0], indexIncluded(page.included)), score: 1 };
    }
    const searchFn = async (query) => {
      const { ids } = await this.searchIds(query, 'albums', { signal });
      if (!ids.length) return [];
      const page = await this.api('/albums', { query: { countryCode: this.country, 'filter[id]': ids.slice(0, 10).join(','), include: 'artists' }, signal });
      const index = indexIncluded(page.included);
      return (page.data || []).map((a) => toAlbum(a, index));
    };
    const match = await matchViaSearch(album, albumQueries(album), searchFn, scoreAlbum, THRESHOLDS.album);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findArtist(artist, { signal } = {}) {
    const { ids, included } = await this.searchIds(artist.name, 'artists', { signal });
    let candidates = included.map(toArtist);
    if (!candidates.length && ids.length) {
      const page = await this.api('/artists', { query: { countryCode: this.country, 'filter[id]': ids.slice(0, 10).join(',') }, signal });
      candidates = (page.data || []).map(toArtist);
    }
    const match = bestMatch(artist, candidates, scoreArtist, THRESHOLDS.artist);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async createPlaylist({ name, description, isPublic }, { signal } = {}) {
    const created = await this.api('/playlists', {
      method: 'POST',
      query: { countryCode: this.country },
      json: { data: { type: 'playlists', attributes: { name: name.slice(0, 200), description: (description || '').slice(0, 500), accessType: isPublic ? 'PUBLIC' : 'UNLISTED' } } },
      signal,
    });
    const id = created?.data?.id;
    if (!id) throw new Error('TIDAL did not return the new playlist.');
    return { id: String(id), url: `https://tidal.com/browse/playlist/${id}` };
  }

  async addTracks(playlistId, trackIds, { signal, onProgress } = {}) {
    let added = 0;
    for (const batch of chunk(trackIds, 20)) {
      await this.api(`/playlists/${playlistId}/relationships/items`, {
        method: 'POST',
        query: { countryCode: this.country },
        json: { data: batch.map((id) => ({ type: 'tracks', id: String(id) })) },
        signal,
        parse: 'none',
      });
      added += batch.length;
      onProgress?.(added);
    }
  }

  async saveAlbums(albumIds, { signal } = {}) {
    const userId = await this.userId();
    for (const batch of chunk(albumIds, 20)) {
      await this.api(`/userCollections/${userId}/relationships/albums`, { method: 'POST', query: { countryCode: this.country }, json: { data: batch.map((id) => ({ type: 'albums', id: String(id) })) }, signal, parse: 'none' });
    }
  }

  async followArtists(artistIds, { signal } = {}) {
    const userId = await this.userId();
    for (const batch of chunk(artistIds, 20)) {
      await this.api(`/userCollections/${userId}/relationships/artists`, { method: 'POST', query: { countryCode: this.country }, json: { data: batch.map((id) => ({ type: 'artists', id: String(id) })) }, signal, parse: 'none' });
    }
  }
}
