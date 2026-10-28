// "File or link" source — no login, no keys. Serves whatever the visitor imported (Spotify data
// export, Google Takeout, Apple Music exports, CSV/M3U/text files, public Deezer links) through
// the same read interface as the real services, so the transfer engine doesn't care.
import { ProviderBase, CapabilityError } from './base.js';
import { getLibrary, hasLibrary, clearLibrary } from '../importers/library.js';
import { summarize } from '../importers/index.js';

export class ImportProvider extends ProviderBase {
  constructor(config = {}) {
    super('import', config);
    this.matchConcurrency = 1;
  }

  get name() {
    const sources = getLibrary()?.sources || [];
    if (sources.length === 1) return sources[0];
    if (sources.length > 1) return sources.join(' + ');
    return 'your import';
  }

  isConfigured() {
    return true;
  }

  isConnected() {
    return hasLibrary();
  }

  /** The UI handles importing itself (drop zone / link box); there is nothing to redirect to. */
  async connect() {
    throw new Error('Drop a file or paste a link to import your music.');
  }

  async finishConnect() {}

  disconnect() {
    this.profile = null;
    clearLibrary().catch(() => {});
  }

  async getProfile() {
    const library = getLibrary();
    const sources = library?.sources?.length ? library.sources.join(', ') : 'files';
    this.profile = { id: 'import', name: `${summarize(library)} from ${sources}`, image: '', url: '' };
    return this.profile;
  }

  async listPlaylists() {
    return (getLibrary()?.playlists || []).map(({ tracks, ...playlist }) => ({ ...playlist, trackCount: tracks?.length ?? playlist.trackCount ?? 0 }));
  }

  async getPlaylistTracks(playlist, { onProgress } = {}) {
    const found = (getLibrary()?.playlists || []).find((p) => p.id === playlist.id);
    const tracks = found?.tracks || [];
    onProgress?.(tracks.length);
    return tracks;
  }

  async listAlbums() {
    return getLibrary()?.albums || [];
  }

  async listArtists() {
    return getLibrary()?.artists || [];
  }

  async findTrack() { throw new CapabilityError('Imported files are a source only.'); }
  async findAlbum() { throw new CapabilityError('Imported files are a source only.'); }
  async findArtist() { throw new CapabilityError('Imported files are a source only.'); }
  async createPlaylist() { throw new CapabilityError('Imported files are a source only.'); }
  async addTracks() { throw new CapabilityError('Imported files are a source only.'); }
  async saveAlbums() { throw new CapabilityError('Imported files are a source only.'); }
  async followArtists() { throw new CapabilityError('Imported files are a source only.'); }
}
