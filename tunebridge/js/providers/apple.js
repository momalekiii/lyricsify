// Apple Music adapter — MusicKit JS v3 handles sign-in (popup); API calls go straight to
// api.music.apple.com with the developer token + Music User Token.
import { ProviderBase, AuthError } from './base.js';
import { http, ApiError } from '../http.js';
import { chunk } from '../util.js';
import { matchViaSearch, trackQueries, albumQueries, scoreTrack, scoreAlbum, bestMatch, THRESHOLDS } from '../matching.js';

const MUSICKIT_SRC = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
const API = 'https://api.music.apple.com';
const LIBRARY_SONGS_ID = '__apple_library_songs__';

let musicKitPromise = null;

function loadMusicKit() {
  if (typeof window === 'undefined') return Promise.reject(new Error('MusicKit needs a browser'));
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  if (!musicKitPromise) {
    musicKitPromise = new Promise((resolve, reject) => {
      const done = () => (window.MusicKit ? resolve(window.MusicKit) : reject(new Error('MusicKit failed to initialise')));
      document.addEventListener('musickitloaded', done, { once: true });
      const script = document.createElement('script');
      script.src = MUSICKIT_SRC;
      script.async = true;
      script.onerror = () => reject(new Error('Could not load MusicKit JS. Check your connection or content blockers.'));
      document.head.append(script);
      setTimeout(() => reject(new Error('MusicKit JS took too long to load.')), 20000);
    }).catch((error) => {
      musicKitPromise = null;
      throw error;
    });
  }
  return musicKitPromise;
}

const artworkUrl = (artwork, size = 200) => (artwork?.url ? artwork.url.replace('{w}', size).replace('{h}', size) : '');

function catalogOf(item) {
  const data = item?.relationships?.catalog?.data;
  return Array.isArray(data) && data.length ? data[0] : null;
}

function toTrack(item) {
  const attrs = item?.attributes;
  if (!attrs) return null;
  const catalog = catalogOf(item);
  const catalogId = item.type === 'songs' ? item.id : catalog?.id || attrs.playParams?.catalogId || '';
  return {
    id: catalogId || item.id,
    libraryId: item.type === 'library-songs' ? item.id : '',
    title: attrs.name,
    artists: [attrs.artistName].filter(Boolean),
    album: attrs.albumName || '',
    durationMs: attrs.durationInMillis || catalog?.attributes?.durationInMillis || 0,
    isrc: attrs.isrc || catalog?.attributes?.isrc || '',
    explicit: attrs.contentRating === 'explicit',
    url: attrs.url || catalog?.attributes?.url || '',
    image: artworkUrl(attrs.artwork || catalog?.attributes?.artwork, 120),
  };
}

function toAlbum(item) {
  const attrs = item?.attributes || {};
  const catalog = catalogOf(item);
  return {
    id: item.type === 'albums' ? item.id : catalog?.id || attrs.playParams?.catalogId || item.id,
    title: attrs.name,
    artists: [attrs.artistName].filter(Boolean),
    upc: attrs.upc || catalog?.attributes?.upc || '',
    year: (attrs.releaseDate || catalog?.attributes?.releaseDate || '').slice(0, 4),
    trackCount: attrs.trackCount || catalog?.attributes?.trackCount || 0,
    image: artworkUrl(attrs.artwork || catalog?.attributes?.artwork),
    url: attrs.url || catalog?.attributes?.url || '',
  };
}

function toArtist(item) {
  const attrs = item?.attributes || {};
  const catalog = catalogOf(item);
  return { id: item.type === 'artists' ? item.id : catalog?.id || item.id, name: attrs.name, image: artworkUrl(attrs.artwork || catalog?.attributes?.artwork), url: attrs.url || catalog?.attributes?.url || '' };
}

export class AppleMusicProvider extends ProviderBase {
  constructor(config) {
    super('apple', config);
    this.music = null;
    this.storefront = '';
  }

  isConfigured() {
    return Boolean(this.config.developerToken);
  }

  async instance() {
    if (this.music) return this.music;
    const MusicKit = await loadMusicKit();
    const configured = await MusicKit.configure({
      developerToken: this.config.developerToken,
      app: { name: 'TuneBridge', build: '1.0.0' },
    });
    this.music = configured || MusicKit.getInstance();
    return this.music;
  }

  async connect() {
    const music = await this.instance();
    const userToken = await music.authorize();
    if (!userToken) throw new Error('Apple Music sign-in was cancelled.');
    this.setToken({ accessToken: userToken, expiresAt: null, refreshToken: null });
  }

  async finishConnect() {
    /* popup flow — nothing to do */
  }

  disconnect() {
    super.disconnect();
    try {
      this.music?.unauthorize?.();
    } catch (_) {
      /* ignore */
    }
  }

  authHeaders(token) {
    return { Authorization: `Bearer ${this.config.developerToken}`, 'Music-User-Token': token.accessToken };
  }

  api(path, options = {}) {
    return this.authedFetch(path.startsWith('http') ? path : API + path, options);
  }

  async getStorefront() {
    if (this.storefront) return this.storefront;
    try {
      const music = await this.instance();
      this.storefront = music.storefrontId || music.storefrontCountryCode || '';
    } catch (_) {
      /* fall through */
    }
    if (!this.storefront) {
      const data = await this.api('/v1/me/storefront').catch(() => null);
      this.storefront = data?.data?.[0]?.id || 'us';
    }
    return this.storefront;
  }

  async getProfile() {
    const storefront = await this.getStorefront();
    this.profile = { id: 'apple-music-user', name: 'Apple Music library', image: '', url: 'https://music.apple.com/library', country: storefront.toUpperCase() };
    return this.profile;
  }

  async *paginate(path, query = {}, { signal } = {}) {
    // Apple's `next` links only carry the offset, so we re-send limit/include ourselves.
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let page;
      try {
        page = await this.api(path, { query: { limit: 100, ...query, offset: offset || undefined }, signal });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return; // Apple returns 404 for empty collections
        throw error;
      }
      const items = page?.data || [];
      yield items;
      if (!page?.next || !items.length) return;
      const nextOffset = Number(new URL(page.next, API).searchParams.get('offset'));
      if (!Number.isFinite(nextOffset) || nextOffset <= offset) return;
      offset = nextOffset;
    }
  }

  async listPlaylists({ signal } = {}) {
    const playlists = [
      { id: LIBRARY_SONGS_ID, name: 'All library songs', description: 'Every song in your Apple Music library', trackCount: null, image: '', url: 'https://music.apple.com/library/songs', owner: 'You', isPublic: false, special: true },
    ];
    for await (const items of this.paginate('/v1/me/library/playlists', {}, { signal })) {
      for (const item of items) {
        const attrs = item.attributes || {};
        playlists.push({
          id: item.id,
          name: attrs.name,
          description: attrs.description?.standard || '',
          trackCount: attrs.trackCount ?? null,
          image: artworkUrl(attrs.artwork),
          url: attrs.playParams?.globalId ? `https://music.apple.com/playlist/${attrs.playParams.globalId}` : `https://music.apple.com/library/playlist/${item.id}`,
          owner: 'You',
          isPublic: Boolean(attrs.isPublic),
        });
      }
    }
    return playlists;
  }

  async getPlaylistTracks(playlist, { signal, onProgress } = {}) {
    const tracks = [];
    const path = playlist.id === LIBRARY_SONGS_ID ? '/v1/me/library/songs' : `/v1/me/library/playlists/${playlist.id}/tracks`;
    for await (const items of this.paginate(path, { include: 'catalog' }, { signal })) {
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
    for await (const items of this.paginate('/v1/me/library/albums', { include: 'catalog' }, { signal })) {
      for (const item of items) albums.push(toAlbum(item));
    }
    return albums;
  }

  async listArtists({ signal } = {}) {
    const artists = [];
    for await (const items of this.paginate('/v1/me/library/artists', { include: 'catalog' }, { signal })) {
      for (const item of items) artists.push(toArtist(item));
    }
    return artists;
  }

  async catalogSearch(term, types, { signal, limit = 10 } = {}) {
    const storefront = await this.getStorefront();
    const data = await this.api(`/v1/catalog/${storefront}/search`, { query: { term, types, limit }, signal });
    return data?.results || {};
  }

  async findTrack(track, { signal } = {}) {
    const storefront = await this.getStorefront();
    if (track.isrc) {
      const data = await this.api(`/v1/catalog/${storefront}/songs`, { query: { 'filter[isrc]': track.isrc }, signal }).catch(() => null);
      const candidates = (data?.data || []).map(toTrack).filter(Boolean);
      const match = bestMatch(track, candidates, scoreTrack, 0.5);
      if (match) return { ...match.candidate, score: 1 };
    }
    const searchFn = async (query) => ((await this.catalogSearch(query, 'songs', { signal })).songs?.data || []).map(toTrack).filter(Boolean);
    const match = await matchViaSearch(track, trackQueries(track), searchFn, scoreTrack, THRESHOLDS.track, { maxQueries: 2 });
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findAlbum(album, { signal } = {}) {
    const storefront = await this.getStorefront();
    if (album.upc) {
      const data = await this.api(`/v1/catalog/${storefront}/albums`, { query: { 'filter[upc]': album.upc }, signal }).catch(() => null);
      if (data?.data?.length) return { ...toAlbum(data.data[0]), score: 1 };
    }
    const searchFn = async (query) => ((await this.catalogSearch(query, 'albums', { signal })).albums?.data || []).map(toAlbum);
    const match = await matchViaSearch(album, albumQueries(album), searchFn, scoreAlbum, THRESHOLDS.album);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findArtist(artist, { signal } = {}) {
    const results = await this.catalogSearch(artist.name, 'artists', { signal });
    const candidates = (results.artists?.data || []).map(toArtist);
    const match = bestMatch(artist, candidates, (a, b) => (a.name && b.name ? (a.name.toLowerCase() === b.name.toLowerCase() ? 1 : 0.5) : 0), 0.9);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async createPlaylist({ name, description }, { signal } = {}) {
    const created = await this.api('/v1/me/library/playlists', {
      method: 'POST',
      json: { attributes: { name: name.slice(0, 200), description: (description || '').slice(0, 500) } },
      signal,
    });
    const playlist = created?.data?.[0];
    if (!playlist?.id) throw new Error('Apple Music did not return the new playlist.');
    return { id: playlist.id, url: `https://music.apple.com/library/playlist/${playlist.id}` };
  }

  async addTracks(playlistId, trackIds, { signal, onProgress } = {}) {
    let added = 0;
    for (const batch of chunk(trackIds, 100)) {
      await this.api(`/v1/me/library/playlists/${playlistId}/tracks`, { method: 'POST', json: { data: batch.map((id) => ({ id, type: 'songs' })) }, signal, parse: 'none' });
      added += batch.length;
      onProgress?.(added);
    }
  }

  async saveAlbums(albumIds, { signal } = {}) {
    for (const batch of chunk(albumIds, 25)) {
      await this.api('/v1/me/library', { method: 'POST', query: { 'ids[albums]': batch.join(',') }, signal, parse: 'none' });
    }
  }
}

export { AuthError, http };
