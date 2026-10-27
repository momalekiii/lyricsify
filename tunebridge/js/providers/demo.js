// Demo provider — a fully offline stand-in for any service so the whole flow can be tried
// without API keys. It mimics realistic delays, partial matches and per-service capabilities.
import { ProviderBase, CapabilityError } from './base.js';
import { SERVICES } from '../services.js';
import { sleep, throwIfAborted } from '../util.js';
import { scoreTrack, scoreAlbum, scoreArtist, bestMatch, THRESHOLDS } from '../matching.js';

const CATALOG = [
  ['Blinding Lights', 'The Weeknd', 'After Hours', 200040, 'USUG11904206'],
  ['Levitating', 'Dua Lipa', 'Future Nostalgia', 203807, 'GBAHT2000207'],
  ['Get Lucky', 'Daft Punk, Pharrell Williams', 'Random Access Memories', 369626, 'USQX91300108'],
  ['Dreams', 'Fleetwood Mac', 'Rumours', 257800, 'USRE17600016'],
  ['Redbone', 'Childish Gambino', 'Awaken, My Love!', 326933, 'USRC11601938'],
  ['Midnight City', 'M83', 'Hurry Up, We’re Dreaming', 243960, 'FR9W11100163'],
  ['Electric Feel', 'MGMT', 'Oracular Spectacular', 229640, 'USSM10705246'],
  ['Nights', 'Frank Ocean', 'Blonde', 307151, 'QMEU31600008'],
  ['Bad Guy', 'Billie Eilish', 'When We All Fall Asleep, Where Do We Go?', 194087, 'USUM71900764'],
  ['As It Was', 'Harry Styles', 'Harry’s House', 167303, 'USSM12200612'],
  ['Heat Waves', 'Glass Animals', 'Dreamland', 238805, 'GBUM71909082'],
  ['Starboy', 'The Weeknd, Daft Punk', 'Starboy', 230453, 'USUG11600976'],
  ['Pink + White', 'Frank Ocean', 'Blonde', 184516, 'QMEU31600010'],
  ['Everybody Wants To Rule The World', 'Tears For Fears', 'Songs From The Big Chair', 251488, 'GBAAA8500014'],
  ['Instant Crush', 'Daft Punk, Julian Casablancas', 'Random Access Memories', 337560, 'USQX91300106'],
  ['The Less I Know The Better', 'Tame Impala', 'Currents', 216320, 'AUUM71500303'],
  ['Teardrop', 'Massive Attack', 'Mezzanine', 330840, 'GBAAA9800127'],
  ['Running Up That Hill (A Deal With God)', 'Kate Bush', 'Hounds of Love', 300440, 'GBAYE8500010'],
  ['Cruel Summer', 'Taylor Swift', 'Lover', 178426, 'USUG11901473'],
  ['Flowers', 'Miley Cyrus', 'Endless Summer Vacation', 200455, 'USSM12209777'],
  ['Espresso', 'Sabrina Carpenter', 'Short n’ Sweet', 175459, 'USUM72403305'],
  ['Birds of a Feather', 'Billie Eilish', 'Hit Me Hard and Soft', 210373, 'USUM72401991'],
  ['Shut Up and Dance', 'WALK THE MOON', 'Talking Is Hard', 199080, 'USRC11401470'],
  ['Take On Me', 'a-ha', 'Hunting High and Low', 225280, 'GBAAA8400088'],
  ['Mr. Brightside', 'The Killers', 'Hot Fuss', 222973, 'USIR20400274'],
  ['Pumped Up Kicks', 'Foster The People', 'Torches', 239600, 'USSM11100750'],
  ['Feel Good Inc.', 'Gorillaz', 'Demon Days', 222640, 'GBAYE0500127'],
  ['Clair de Lune', 'Claude Debussy, Kathia Buniatishvili', 'Motherland', 303000, 'FR6V81300090'],
  ['Weird Fishes / Arpeggi', 'Radiohead', 'In Rainbows', 318360, 'GBU4B0700040'],
  ['Ivy', 'Frank Ocean', 'Blonde', 249191, 'QMEU31600002'],
  ['Kids', 'MGMT', 'Oracular Spectacular', 302760, 'USSM10705256'],
  ['Shape of You', 'Ed Sheeran', '÷ (Deluxe)', 233712, 'GBAHS1600463'],
  ['Someone Like You', 'Adele', '21', 285240, 'GBBKS1000348'],
  ['Hey Ya!', 'Outkast', 'Speakerboxxx/The Love Below', 235213, 'USAR10301423'],
  ['Lose Yourself', 'Eminem', '8 Mile', 326466, 'USIR10211066'],
  ['Smells Like Teen Spirit', 'Nirvana', 'Nevermind', 301920, 'USGF19942501'],
  ['Hotel California', 'Eagles', 'Hotel California', 391376, 'USEE10001993'],
  ['Billie Jean', 'Michael Jackson', 'Thriller', 293826, 'USSM19902991'],
  ['Superstition', 'Stevie Wonder', 'Talking Book', 245493, 'USMO17200042'],
  ['Africa', 'TOTO', 'Toto IV', 295893, 'USSM18200297'],
];

const ALBUMS = [
  ['Random Access Memories', 'Daft Punk', '2013', 13, '886443927087'],
  ['Blonde', 'Frank Ocean', '2016', 17, '888295465403'],
  ['Currents', 'Tame Impala', '2015', 13, '602547337689'],
  ['Rumours', 'Fleetwood Mac', '1977', 11, '081227973599'],
  ['After Hours', 'The Weeknd', '2020', 14, '602508955761'],
  ['In Rainbows', 'Radiohead', '2007', 10, '634904032425'],
  ['Future Nostalgia', 'Dua Lipa', '2020', 11, '190295287597'],
  ['Mezzanine', 'Massive Attack', '1998', 11, '724384559922'],
];

const ARTISTS = ['The Weeknd', 'Daft Punk', 'Frank Ocean', 'Tame Impala', 'Fleetwood Mac', 'Radiohead', 'Billie Eilish', 'M83', 'MGMT', 'Massive Attack', 'Kate Bush', 'Dua Lipa'];

const PLAYLISTS = [
  ['Late Night Drive', 'Synths, neon and empty highways.', [0, 5, 6, 11, 15, 16, 28, 2, 14, 7]],
  ['Sunday Morning', 'Slow coffee, soft light.', [3, 4, 12, 27, 29, 17, 32]],
  ['Gym Hits', 'High tempo, no excuses.', [1, 8, 9, 10, 22, 34, 35, 31, 19, 20, 21, 0]],
  ['All-time favourites', 'The songs that never leave the rotation.', [36, 37, 38, 39, 23, 24, 25, 26, 33, 35, 3, 13, 2, 0, 11, 15, 16, 28, 29, 18]],
  ['Indie Discoveries', '', [6, 15, 25, 28, 30, 10, 22]],
];

const makeId = (service, kind, index) => `demo-${service}-${kind}-${index}`;

function catalogTracks(service) {
  return CATALOG.map(([title, artist, album, durationMs, isrc], index) => ({
    id: makeId(service, 'track', index),
    title,
    artists: artist.split(', '),
    album,
    durationMs,
    isrc,
    explicit: false,
    url: SERVICES[service].home,
    image: '',
  }));
}

function catalogAlbums(service) {
  return ALBUMS.map(([title, artist, year, trackCount, upc], index) => ({ id: makeId(service, 'album', index), title, artists: [artist], upc, year, trackCount, image: '', url: SERVICES[service].home }));
}

const catalogArtists = (service) => ARTISTS.map((name, index) => ({ id: makeId(service, 'artist', index), name, image: '', url: SERVICES[service].home }));

// Deterministic "gaps" so each service is missing a few tracks from the shared catalog.
function missingIndexes(service) {
  const seed = Array.from(service).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const missing = new Set();
  for (let i = 0; i < 4; i += 1) missing.add((seed * (i + 3) + i * 7) % CATALOG.length);
  return missing;
}

async function latency(signal, base = 60, spread = 90) {
  await sleep(base + Math.random() * spread, { signal });
}

export class DemoProvider extends ProviderBase {
  constructor(serviceId) {
    super(serviceId, {});
    this.demo = true;
    this.connected = false;
    this.created = new Map();
    this.missing = missingIndexes(serviceId);
    this.matchConcurrency = 3;
  }

  isConfigured() {
    return true;
  }

  isConnected() {
    return this.connected;
  }

  async connect() {
    await latency(undefined, 350, 250);
    this.connected = true;
  }

  async finishConnect() {}

  disconnect() {
    this.connected = false;
    this.profile = null;
  }

  async getProfile() {
    await latency();
    this.profile = { id: 'demo-user', name: `Demo listener (${this.name})`, image: '', url: this.def.home };
    return this.profile;
  }

  async listPlaylists({ signal } = {}) {
    await latency(signal, 300, 300);
    const tracks = catalogTracks(this.id);
    return PLAYLISTS.map(([name, description, indexes], index) => ({
      id: makeId(this.id, 'playlist', index),
      name,
      description,
      trackCount: indexes.length,
      image: '',
      url: this.def.home,
      owner: 'Demo listener',
      isPublic: index % 2 === 0,
      tracks: indexes.map((i) => tracks[i]),
    }));
  }

  async getPlaylistTracks(playlist, { signal, onProgress } = {}) {
    await latency(signal, 200, 300);
    const tracks = playlist.tracks || (await this.listPlaylists({ signal })).find((p) => p.id === playlist.id)?.tracks || [];
    onProgress?.(tracks.length);
    return tracks;
  }

  async listAlbums({ signal } = {}) {
    if (!this.caps.albums[0]) throw new CapabilityError(`${this.name} does not expose saved albums.`);
    await latency(signal, 250, 250);
    return catalogAlbums(this.id);
  }

  async listArtists({ signal } = {}) {
    if (!this.caps.artists[0]) throw new CapabilityError(`${this.name} does not expose followed artists.`);
    await latency(signal, 250, 250);
    return catalogArtists(this.id);
  }

  async findTrack(track, { signal } = {}) {
    throwIfAborted(signal);
    await latency(signal, 90, 220);
    const candidates = catalogTracks(this.id).filter((_, index) => !this.missing.has(index));
    const match = bestMatch(track, candidates, scoreTrack, THRESHOLDS.track);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findAlbum(album, { signal } = {}) {
    if (!this.caps.albums[1]) throw new CapabilityError(`${this.name} cannot save albums.`);
    await latency(signal, 120, 200);
    const match = bestMatch(album, catalogAlbums(this.id), scoreAlbum, THRESHOLDS.album);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async findArtist(artist, { signal } = {}) {
    if (!this.caps.artists[1]) throw new CapabilityError(`${this.name} cannot follow artists.`);
    await latency(signal, 120, 200);
    const match = bestMatch(artist, catalogArtists(this.id), scoreArtist, THRESHOLDS.artist);
    return match ? { ...match.candidate, score: match.score } : null;
  }

  async createPlaylist({ name }, { signal } = {}) {
    await latency(signal, 200, 300);
    const id = makeId(this.id, 'new', this.created.size + 1);
    this.created.set(id, { name, tracks: [] });
    return { id, url: this.def.home };
  }

  async addTracks(playlistId, trackIds, { signal, onProgress } = {}) {
    await latency(signal, 150, 300);
    const playlist = this.created.get(playlistId);
    if (playlist) playlist.tracks.push(...trackIds);
    onProgress?.(trackIds.length);
  }

  async saveAlbums(_ids, { signal } = {}) {
    await latency(signal, 150, 200);
  }

  async followArtists(_ids, { signal } = {}) {
    await latency(signal, 150, 200);
  }
}
