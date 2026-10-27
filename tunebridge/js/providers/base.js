// Shared behaviour for every provider adapter: token storage, refresh, authenticated fetch.
//
// Normalised models used across providers:
//   Track    { id, title, artists: string[], album, durationMs, isrc, explicit, url, image }
//   Playlist { id, name, description, trackCount, image, url, owner, isPublic, special }
//   Album    { id, title, artists: string[], upc, year, trackCount, image, url }
//   Artist   { id, name, image, url }
//   Match    { id, title, artists, url, score }
import { http, ApiError } from '../http.js';
import { tokens } from '../oauth.js';
import { SERVICES } from '../services.js';

export class AuthError extends Error {
  constructor(serviceId, message) {
    super(message || `Your ${SERVICES[serviceId]?.name || serviceId} session has expired. Please reconnect.`);
    this.name = 'AuthError';
    this.serviceId = serviceId;
  }
}

export class CapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export class ProviderBase {
  constructor(id, config = {}) {
    this.id = id;
    this.config = config;
    this.def = SERVICES[id];
    this.caps = this.def.caps;
    this.matchConcurrency = 3;
    this.profile = null;
  }

  get name() {
    return this.def.name;
  }

  // --- configuration & tokens -------------------------------------------------

  isConfigured() {
    return false;
  }

  /** Actionable hint shown when credentials are missing (the UI adds the "not set up" headline). */
  missingConfigMessage() {
    return `Add your own ${this.def.credentials[0]?.label || 'API key'} in Settings (free developer account), or try the demo.`;
  }

  getToken() {
    return tokens.get(this.id);
  }

  setToken(token) {
    tokens.set(this.id, token);
  }

  isConnected() {
    const token = this.getToken();
    if (!token || !token.accessToken) return false;
    if (token.expiresAt && token.expiresAt <= Date.now() && !token.refreshToken) return false;
    return true;
  }

  disconnect() {
    tokens.clear(this.id);
    this.profile = null;
  }

  /** Override in subclasses that support refresh tokens. */
  async refresh() {
    return null;
  }

  async ensureToken() {
    let token = this.getToken();
    if (!token || !token.accessToken) throw new AuthError(this.id, `Please connect ${this.name} first.`);
    if (token.expiresAt && token.expiresAt <= Date.now()) {
      if (!token.refreshToken) {
        this.disconnect();
        throw new AuthError(this.id);
      }
      token = await this.refreshOrFail(token);
    }
    return token;
  }

  async refreshOrFail(token) {
    try {
      const fresh = await this.refresh(token);
      if (!fresh || !fresh.accessToken) throw new Error('empty token');
      this.setToken(fresh);
      return fresh;
    } catch (error) {
      this.disconnect();
      throw new AuthError(this.id);
    }
  }

  authHeaders(token) {
    return { Authorization: `Bearer ${token.accessToken}` };
  }

  /** fetch() with the service's auth header and a single automatic refresh on 401. */
  async authedFetch(url, options = {}) {
    let token = await this.ensureToken();
    try {
      return await http(url, { ...options, headers: { ...this.authHeaders(token), ...(options.headers || {}) } });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (token.refreshToken && !options._retried) {
          token = await this.refreshOrFail(token);
          return this.authedFetch(url, { ...options, _retried: true });
        }
        this.disconnect();
        throw new AuthError(this.id);
      }
      throw error;
    }
  }

  // --- interface (overridden by each service) ---------------------------------

  /* eslint-disable no-unused-vars */
  async connect() { throw new Error('connect() not implemented'); }
  async finishConnect(_redirectResult) { throw new Error('finishConnect() not implemented'); }
  async getProfile() { throw new Error('getProfile() not implemented'); }
  async listPlaylists(_opts) { throw new CapabilityError(`${this.name} cannot list playlists.`); }
  async getPlaylistTracks(_playlist, _opts) { throw new CapabilityError(`${this.name} cannot read playlist tracks.`); }
  async listAlbums(_opts) { throw new CapabilityError(`${this.name} cannot list albums.`); }
  async listArtists(_opts) { throw new CapabilityError(`${this.name} cannot list followed artists.`); }
  async findTrack(_track, _opts) { throw new CapabilityError(`${this.name} cannot search tracks.`); }
  async findAlbum(_album, _opts) { throw new CapabilityError(`${this.name} cannot search albums.`); }
  async findArtist(_artist, _opts) { throw new CapabilityError(`${this.name} cannot search artists.`); }
  async createPlaylist(_details, _opts) { throw new CapabilityError(`${this.name} cannot create playlists.`); }
  async addTracks(_playlistId, _trackIds, _opts) { throw new CapabilityError(`${this.name} cannot add tracks.`); }
  async saveAlbums(_albumIds, _opts) { throw new CapabilityError(`${this.name} cannot save albums.`); }
  async followArtists(_artistIds, _opts) { throw new CapabilityError(`${this.name} cannot follow artists.`); }
  /* eslint-enable no-unused-vars */
}

export function expiresAtFrom(expiresInSeconds, skew = 60) {
  const seconds = Number(expiresInSeconds) || 3600;
  return Date.now() + Math.max(30, seconds - skew) * 1000;
}
