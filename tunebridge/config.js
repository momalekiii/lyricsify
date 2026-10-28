// TuneBridge deployment configuration — ONE-TIME SETUP BY THE SITE OWNER.
//
// Visitors never deal with any of this. They paste a public playlist link (or drop an exported
// file), check the preview, pick a destination and log in there on the service's own website.
// Step-by-step instructions are in SETUP.md.
//
// Everything in this file is public (it ships to the browser) — never put a client secret here.
//
// Register this exact redirect URI with every destination service:
//   https://momalekiii.github.io/tunebridge/   the published site (trailing slash matters)
//   http://127.0.0.1:8000/                     local development (python -m http.server 8000)
window.TUNEBRIDGE_CONFIG = {
  appName: 'TuneBridge',
  ownerName: 'Momalekiii',
  ownerUrl: 'https://momalekiii.github.io',
  repoUrl: 'https://github.com/momalekiii/tunebridge',

  // ── Reading pasted links ───────────────────────────────────────────────────────────────
  // Deezer links work with nothing configured. For Spotify, Apple Music, SoundCloud and TIDAL
  // links the page itself is not allowed to read those sites, so deploy the tiny helper worker
  // in proxy/cloudflare-worker.js (free, ≈5 minutes, SETUP.md → "Helper worker") and put its
  // URL here, e.g. 'https://tunebridge-helper.<you>.workers.dev'.
  resolverUrl: '',

  // ── Destination logins (the only part visitors log in to) ──────────────────────────────
  spotify: {
    // https://developer.spotify.com/dashboard → Create app → Web API, add the redirect URI.
    // Owner needs Spotify Premium; development mode = 5 allow-listed users (see SETUP.md).
    clientId: '',
  },
  apple: {
    // MusicKit developer token (JWT). Generate with: node scripts/apple-developer-token.mjs
    developerToken: '',
  },
  youtube: {
    // Google Cloud → APIs & Services → Credentials → OAuth client ID (Web application).
    // Add the site origin to "Authorized JavaScript origins" and the redirect URI to
    // "Authorized redirect URIs". Enable "YouTube Data API v3" for the project.
    clientId: '',
    // Optional: an API key (same project, restricted to your site's address) lets the page read
    // public YouTube / YouTube Music playlist links directly, without the helper worker.
    apiKey: '',
  },
  soundcloud: {
    // https://soundcloud.com/you/apps (API access requires approval from SoundCloud).
    clientId: '',
    // SoundCloud's token endpoint needs the client secret: use the helper worker's /token
    // endpoint, e.g. 'https://tunebridge-helper.<you>.workers.dev/token'.
    tokenEndpoint: '',
    // For strictly personal use you may put the secret here instead (NOT for public sites).
    clientSecret: '',
  },
  tidal: {
    // https://developer.tidal.com/dashboard → Create app → add the redirect URI.
    clientId: '',
  },
  deezer: {
    // https://developers.deezer.com/myapps → Create app (Application domain = your host).
    appId: '',
  },

  // ── Hidden helpers (not shown in the UI) ───────────────────────────────────────────────
  // Append #demo to the page URL to try the flow with a sample destination (nothing touches
  // real accounts); append #setup to open the owner settings dialog in the browser.
  allowDemo: true,
  allowUserKeys: true,
};
