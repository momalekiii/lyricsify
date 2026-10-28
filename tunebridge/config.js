// TuneBridge deployment configuration — ONE-TIME SETUP BY THE SITE OWNER.
//
// Visitors never need API keys: they click "Log in with Spotify" (etc.), sign in on the
// service's own website and come straight back. What the services need in exchange is
// that TuneBridge itself is registered with them once, which is what this file holds.
// Step-by-step instructions for every service are in SETUP.md (≈5 minutes each).
//
// Everything here is public (it ships to the browser) — never put a client secret in this
// file for a public site. Visitors can also add their own keys through the Advanced dialog;
// those are stored only in their browser and take precedence over the values below.
//
// Register this exact redirect URI with every service (shown in Advanced settings as well):
//   https://momalekiii.github.io/tunebridge/   the published site (trailing slash matters)
//   http://127.0.0.1:8000/                     local development (python -m http.server 8000 in the repo root)
window.TUNEBRIDGE_CONFIG = {
  appName: 'TuneBridge',
  ownerName: 'Momalekiii',
  ownerUrl: 'https://momalekiii.github.io',
  // Where the "Site owner? Setup guide" link in the app points (SETUP.md in this repository).
  repoUrl: 'https://github.com/momalekiii/tunebridge',

  // Show the "Demo" toggle so visitors can try the flow with sample libraries.
  allowDemo: true,
  // Keep the "Advanced: use my own developer app" escape hatch (recommended: since February
  // 2026 a Spotify development-mode app admits only 5 allow-listed users and its owner must
  // have Premium, so "bring your own app" is how everyone else can still use Spotify here).
  // Set to false to hide it completely.
  allowUserKeys: true,

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
  },
  soundcloud: {
    // https://soundcloud.com/you/apps (API access requires approval from SoundCloud).
    clientId: '',
    // SoundCloud's token endpoint needs the client secret. For a public site deploy
    // proxy/cloudflare-worker.js and put its URL here:
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
};
