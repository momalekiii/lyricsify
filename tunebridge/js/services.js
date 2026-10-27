// Service registry: branding, capabilities and setup links for every provider.
// Logo paths come from the CC0-licensed simple-icons project (https://simpleicons.org).
// The names and logos themselves remain trademarks of their respective owners.

const LOGOS = {
  spotify:
    'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z',
  apple:
    'M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z',
  youtube:
    'M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L15.816 12l-6.132 3.54z',
  soundcloud:
    'M23.999 14.165c-.052 1.796-1.612 3.169-3.4 3.169h-8.18a.68.68 0 0 1-.675-.683V7.862a.747.747 0 0 1 .452-.724s.75-.513 2.333-.513a5.364 5.364 0 0 1 2.763.755 5.433 5.433 0 0 1 2.57 3.54c.282-.08.574-.121.868-.12.884 0 1.73.358 2.347.992s.948 1.49.922 2.373ZM10.721 8.421c.247 2.98.427 5.697 0 8.672a.264.264 0 0 1-.53 0c-.395-2.946-.22-5.718 0-8.672a.264.264 0 0 1 .53 0ZM9.072 9.448c.285 2.659.37 4.986-.006 7.655a.277.277 0 0 1-.55 0c-.331-2.63-.256-5.02 0-7.655a.277.277 0 0 1 .556 0Zm-1.663-.257c.27 2.726.39 5.171 0 7.904a.266.266 0 0 1-.532 0c-.38-2.69-.257-5.21 0-7.904a.266.266 0 0 1 .532 0Zm-1.647.77a26.108 26.108 0 0 1-.008 7.147.272.272 0 0 1-.542 0 27.955 27.955 0 0 1 0-7.147.275.275 0 0 1 .55 0Zm-1.67 1.769c.421 1.865.228 3.5-.029 5.388a.257.257 0 0 1-.514 0c-.21-1.858-.398-3.549 0-5.389a.272.272 0 0 1 .543 0Zm-1.655-.273c.388 1.897.26 3.508-.01 5.412-.026.28-.514.283-.54 0-.244-1.878-.347-3.54-.01-5.412a.283.283 0 0 1 .56 0Zm-1.668.911c.4 1.268.257 2.292-.026 3.572a.257.257 0 0 1-.514 0c-.241-1.262-.354-2.312-.023-3.572a.283.283 0 0 1 .563 0Z',
  tidal:
    'M12.012 3.992L8.008 7.996 4.004 3.992 0 7.996 4.004 12l4.004-4.004L12.012 12l-4.004 4.004 4.004 4.004 4.004-4.004L12.012 12l4.004-4.004-4.004-4.004zM16.042 7.996l3.979-3.979L24 7.996l-3.979 3.979z',
  deezer:
    'M.693 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807C.312 4.41 0 5.666 0 7.217s.312 2.808.693 2.808ZM21.038 1.56c-.364 0-.684.805-.91 2.096C19.765 1.446 19.184 0 18.526 0c-.78 0-1.464 2.036-1.784 5-.312-2.158-.788-3.536-1.325-3.536-.745 0-1.386 2.704-1.62 6.472-.442-1.932-1.083-3.145-1.793-3.145s-1.35 1.213-1.793 3.145c-.242-3.76-.874-6.463-1.628-6.463-.537 0-1.013 1.378-1.325 3.535C6.938 2.036 6.262 0 5.474 0c-.658 0-1.247 1.447-1.602 3.665-.217-1.291-.546-2.105-.91-2.105-.675 0-1.221 2.807-1.221 6.272 0 3.466.546 6.273 1.221 6.273.277 0 .537-.476.736-1.273.32 2.928.996 4.938 1.776 4.938.606 0 1.143-1.204 1.507-3.11.251 3.622.875 6.195 1.602 6.195.46 0 .875-1.023 1.187-2.677C10.142 21.6 11 24 12.004 24c1.005 0 1.863-2.4 2.235-5.822.312 1.654.727 2.677 1.186 2.677.728 0 1.352-2.573 1.603-6.195.364 1.906.9 3.11 1.507 3.11.78 0 1.455-2.01 1.775-4.938.208.797.46 1.273.737 1.273.675 0 1.22-2.807 1.22-6.273-.008-3.457-.553-6.272-1.23-6.272ZM23.307 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807-.381 0-.693 1.256-.693 2.807s.312 2.808.693 2.808Z',
};

// capability tuple = [canRead, canWrite]
export const SERVICES = {
  spotify: {
    id: 'spotify',
    name: 'Spotify',
    color: '#1ed760',
    color2: '#19b955',
    ink: '#06230f',
    logo: LOGOS.spotify,
    home: 'https://open.spotify.com',
    developer: 'https://developer.spotify.com/dashboard',
    caps: { playlists: [true, true], albums: [true, true], artists: [true, true] },
    credentials: [
      { key: 'clientId', label: 'Client ID', placeholder: 'Spotify app Client ID' },
    ],
    setup: 'Create an app in the Spotify Developer Dashboard, add the redirect URI below, and paste the Client ID. Spotify apps in development mode can allow-list up to 25 users.',
  },
  apple: {
    id: 'apple',
    name: 'Apple Music',
    color: '#fa243c',
    color2: '#fb6a7f',
    ink: '#ffffff',
    logo: LOGOS.apple,
    home: 'https://music.apple.com',
    developer: 'https://developer.apple.com/account/resources/authkeys/list',
    caps: { playlists: [true, true], albums: [true, true], artists: [true, false] },
    credentials: [
      { key: 'developerToken', label: 'MusicKit developer token (JWT)', placeholder: 'eyJhbGciOiJFUzI1NiIs…', multiline: true },
    ],
    setup: 'Requires an Apple Developer Program membership. Create a MusicKit key, then run scripts/apple-developer-token.mjs to mint a developer token (valid up to 6 months).',
    notes: ['Apple Music has no public “follow artist” API, so artists can only be read from Apple Music, not written to it.'],
  },
  youtube: {
    id: 'youtube',
    name: 'YouTube Music',
    color: '#ff2a2a',
    color2: '#ff6a3d',
    ink: '#ffffff',
    logo: LOGOS.youtube,
    home: 'https://music.youtube.com',
    developer: 'https://console.cloud.google.com/apis/credentials',
    caps: { playlists: [true, true], albums: [false, false], artists: [true, true] },
    credentials: [
      { key: 'clientId', label: 'Google OAuth Client ID', placeholder: '1234567890-abc.apps.googleusercontent.com' },
    ],
    setup: 'Create a Google Cloud project, enable the YouTube Data API v3, create an OAuth “Web application” client, and add this page’s origin and redirect URI.',
    notes: [
      'YouTube’s API quota (10,000 units/day by default) allows roughly 60–65 tracks to be added per day. Reading from YouTube Music is cheap.',
      'The YouTube Data API has no concept of saved albums, so albums are not available for YouTube Music.',
    ],
  },
  soundcloud: {
    id: 'soundcloud',
    name: 'SoundCloud',
    color: '#ff5500',
    color2: '#ff8a1f',
    ink: '#ffffff',
    logo: LOGOS.soundcloud,
    home: 'https://soundcloud.com',
    developer: 'https://soundcloud.com/you/apps',
    caps: { playlists: [true, true], albums: [true, true], artists: [true, true] },
    credentials: [
      { key: 'clientId', label: 'Client ID', placeholder: 'SoundCloud app Client ID' },
      { key: 'clientSecret', label: 'Client secret (optional, browser-only exchange)', placeholder: 'Only if you are not using a token proxy', secret: true },
      { key: 'tokenEndpoint', label: 'Token proxy URL (recommended)', placeholder: 'https://your-worker.workers.dev/soundcloud/token' },
    ],
    setup: 'Register an app with SoundCloud (API access requires approval). SoundCloud’s token exchange needs the client secret, so deploy proxy/cloudflare-worker.js and paste its URL, or add the secret for personal use only.',
    notes: ['SoundCloud “albums” are playlists marked as albums; liking one adds it to your library.'],
  },
  tidal: {
    id: 'tidal',
    name: 'TIDAL',
    color: '#35e6ff',
    color2: '#b5f6ff',
    ink: '#03242a',
    logo: LOGOS.tidal,
    home: 'https://tidal.com',
    developer: 'https://developer.tidal.com/dashboard',
    caps: { playlists: [true, true], albums: [true, true], artists: [true, true] },
    credentials: [
      { key: 'clientId', label: 'Client ID', placeholder: 'TIDAL developer app Client ID' },
    ],
    setup: 'Create an app in the TIDAL Developer Portal, add the redirect URI, and enable the user-collection and playlist scopes.',
    notes: ['TIDAL’s v2 API is still labelled beta by TIDAL; endpoints may change.'],
  },
  deezer: {
    id: 'deezer',
    name: 'Deezer',
    color: '#a238ff',
    color2: '#ff0092',
    ink: '#ffffff',
    logo: LOGOS.deezer,
    home: 'https://www.deezer.com',
    developer: 'https://developers.deezer.com/myapps',
    caps: { playlists: [true, true], albums: [true, true], artists: [true, true] },
    credentials: [
      { key: 'appId', label: 'Application ID', placeholder: 'Deezer app ID (numeric)' },
      { key: 'tokenEndpoint', label: 'Token proxy URL (optional)', placeholder: 'Only if Deezer rejects the browser (implicit) sign-in flow' },
    ],
    setup: 'Create an application on Deezer for Developers and set the “Application domain” to this site’s host. Sign-in uses Deezer’s browser flow; a token proxy is only needed as a fallback.',
  },
};

export const SERVICE_IDS = Object.keys(SERVICES);

export const KINDS = [
  { id: 'playlists', label: 'Playlists', singular: 'playlist' },
  { id: 'albums', label: 'Albums', singular: 'album' },
  { id: 'artists', label: 'Artists', singular: 'artist' },
];

export function canRead(serviceId, kind) {
  return Boolean(SERVICES[serviceId]?.caps[kind]?.[0]);
}

export function canWrite(serviceId, kind) {
  return Boolean(SERVICES[serviceId]?.caps[kind]?.[1]);
}

export function logoSvg(serviceId, { size = 24, className = '' } = {}) {
  const service = SERVICES[serviceId];
  if (!service) return '';
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="${service.logo}"/></svg>`;
}
