// TuneBridge deployment configuration.
//
// Fill in the credentials for the services you want to offer. Everything here is public
// (it ships to the browser) — never put a client secret in this file for a public site.
// Visitors can also add their own keys through the Settings dialog; those are stored only
// in their browser and take precedence over the values below.
//
// Register this exact redirect URI with every service (shown in Settings as well):
//   https://<your-user>.github.io/<repo>/      e.g. https://momalekiii.github.io/tunebridge/
//   http://127.0.0.1:8000/tunebridge/          for local development
window.TUNEBRIDGE_CONFIG = {
  appName: 'TuneBridge',
  ownerName: 'Momalekiii',
  ownerUrl: 'https://momalekiii.github.io',

  // Show the "Demo" toggle so visitors can try the flow with sample libraries.
  allowDemo: true,
  // Let visitors paste their own API keys in Settings (recommended: Spotify dev-mode apps
  // are limited to 25 allow-listed users, so "bring your own key" keeps the tool usable).
  allowUserKeys: true,

  spotify: {
    // https://developer.spotify.com/dashboard → Create app → Web API, add the redirect URI.
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
