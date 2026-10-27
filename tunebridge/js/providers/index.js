// Provider factory: builds the right adapter for a service id, real or demo.
import { SpotifyProvider } from './spotify.js';
import { AppleMusicProvider } from './apple.js';
import { YouTubeMusicProvider } from './youtube.js';
import { SoundCloudProvider } from './soundcloud.js';
import { TidalProvider } from './tidal.js';
import { DeezerProvider } from './deezer.js';
import { DemoProvider } from './demo.js';

const REAL = {
  spotify: SpotifyProvider,
  apple: AppleMusicProvider,
  youtube: YouTubeMusicProvider,
  soundcloud: SoundCloudProvider,
  tidal: TidalProvider,
  deezer: DeezerProvider,
};

export function createProvider(serviceId, { demo = false, config = {} } = {}) {
  if (demo) return new DemoProvider(serviceId);
  const Provider = REAL[serviceId];
  if (!Provider) throw new Error(`Unknown service: ${serviceId}`);
  return new Provider(config);
}

export { AuthError, CapabilityError } from './base.js';
