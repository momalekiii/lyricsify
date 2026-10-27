# TuneBridge

**Move your music between streaming services — right in your browser.**

TuneBridge rebuilds your playlists, saved albums and followed artists on another service. Pick a source, pick a destination, sign in to both, tick what you want to move, and watch it go. It supports **Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer**, in every direction the services' APIs allow.

It is a static web app (plain HTML, CSS and JavaScript — no build step, no server, no database). You sign in with each service directly through its official login; the tokens stay in your browser. Nothing is uploaded anywhere because there is nowhere to upload it to.

## What can move where?

| Service | Playlists | Saved albums | Followed artists |
| --- | --- | --- | --- |
| Spotify | ✓ read & write | ✓ read & write | ✓ read & write |
| Apple Music | ✓ read & write | ✓ read & write | read only ¹ |
| YouTube Music | ✓ read & write ² | — ³ | ✓ read & write (channel subscriptions) |
| SoundCloud | ✓ read & write | ✓ read & write ⁴ | ✓ read & write |
| TIDAL | ✓ read & write | ✓ read & write | ✓ read & write |
| Deezer | ✓ read & write | ✓ read & write | ✓ read & write |

"Liked Songs"-style libraries (Spotify Liked Songs, YouTube Music Liked Music, SoundCloud likes, TIDAL collection tracks, Deezer Loved Tracks, the whole Apple Music song library) appear as a special playlist and can be transferred like any other.

1. Apple Music has no public API for following/favouriting artists, so artists can be read from Apple Music but not written to it.
2. The YouTube Data API's default quota (10,000 units/day) allows roughly 60–65 tracks to be *added* per day (each track costs a search + an insert). Reading from YouTube Music is cheap. You can request a higher quota from Google.
3. The YouTube Data API has no notion of saved albums.
4. SoundCloud "albums" are playlists flagged as albums; saving one likes it.

## How matching works

For every track TuneBridge first tries the **ISRC** (the industry-standard recording ID) when both services expose it — that is an exact hit. Otherwise it searches the destination and scores candidates by cleaned-up title, artist overlap and duration, and it refuses lookalikes such as karaoke versions, covers, live recordings or remixes unless the original was one too. Albums use UPC first, then title + artist; artists match on normalised names. Every transfer ends with a list of what could not be found, downloadable as CSV.

## Try it

- **Demo mode** (the *Demo* toggle in the top bar) runs the whole flow with sample libraries and needs no keys — useful to see how it works and to test the UI.
- **Run locally:**

  ```bash
  cd tunebridge
  python -m http.server 8000 --bind 127.0.0.1
  # open http://127.0.0.1:8000/
  ```

  Use `127.0.0.1` rather than `localhost`: Spotify no longer accepts `localhost` redirect URIs.

## Deploy it (GitHub Pages)

1. Put the contents of this folder in its own repository (for example `momalekiii/tunebridge`).
2. **Settings → Pages → Build and deployment → Deploy from a branch** (`main`, `/ (root)`).
3. Your site is `https://<user>.github.io/tunebridge/`. That URL — with the trailing slash — is the **redirect URI** you register with every service. The Settings dialog shows the exact value for whatever URL the app is running on, with a copy button.
4. Fill in `config.js` with your API keys (see below) and push.

Any other static host (Netlify, Vercel, Cloudflare Pages, your own server) works the same way.

## Setting up the services

Each streaming service requires its own free developer app. Keys go into `config.js` (public, shipped to the browser — never put a *secret* there) or into the Settings dialog, where they are stored in the visitor's browser only. Visitor-entered keys take precedence, so people can "bring their own key" if you prefer not to share yours.

### Spotify

1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → **Create app** → tick **Web API**.
2. Add the redirect URI (e.g. `https://momalekiii.github.io/tunebridge/`).
3. Copy the **Client ID** into `config.js → spotify.clientId`. No secret is needed (PKCE).
4. New Spotify apps run in *development mode*: only users you add under **User Management** (up to 25) can sign in. Spotify currently grants extended quota only to registered businesses, which is why TuneBridge lets visitors use their own Client ID.
5. Spotify-curated playlists (editorial/algorithmic) are no longer readable by development-mode apps; your own and other users' playlists are fine.

### Apple Music

1. Requires an [Apple Developer Program](https://developer.apple.com/programs/) membership.
2. **Certificates, Identifiers & Profiles → Identifiers** → create a *Media ID*; **Keys** → create a key with **MusicKit** enabled and download the `.p8` file (note the Key ID and your Team ID).
3. Mint a developer token (a signed JWT, valid up to 6 months):

   ```bash
   node scripts/apple-developer-token.mjs --key AuthKey_XXXX.p8 --key-id XXXX --team-id YYYY --origin https://momalekiii.github.io
   ```

4. Paste it into `config.js → apple.developerToken`. The `--origin` claim locks the token to your site, which matters because MusicKit tokens are visible to visitors by design. Set a reminder to renew it.
5. Sign-in happens in Apple's MusicKit popup; visitors need an Apple Music subscription.

### YouTube Music

1. [console.cloud.google.com](https://console.cloud.google.com/) → create a project → **APIs & Services → Library** → enable **YouTube Data API v3**.
2. **OAuth consent screen**: External, add the scope `https://www.googleapis.com/auth/youtube`. While the app is in *Testing*, add up to 100 test users; publishing with this scope requires Google's verification.
3. **Credentials → Create credentials → OAuth client ID → Web application.** Add your origin (`https://momalekiii.github.io`) to *Authorized JavaScript origins* and the redirect URI to *Authorized redirect URIs*.
4. Copy the **Client ID** into `config.js → youtube.clientId`.
5. Mind the quota (see footnote 2 above). Google resets it daily at midnight Pacific time; the app warns when a selection is likely to exceed it.

### SoundCloud

1. Register an app at [soundcloud.com/you/apps](https://soundcloud.com/you/apps) (SoundCloud reviews API-access requests) and add the redirect URI.
2. SoundCloud's token endpoint requires the client *secret*, which must not live in a public web page. Deploy the included Cloudflare Worker (free tier):

   ```bash
   npm create cloudflare@latest tunebridge-proxy      # "Hello World" worker; replace src/index.js with proxy/cloudflare-worker.js
   npx wrangler secret put SOUNDCLOUD_CLIENT_ID
   npx wrangler secret put SOUNDCLOUD_CLIENT_SECRET
   # in wrangler.toml: [vars] ALLOWED_ORIGINS = "https://momalekiii.github.io,http://127.0.0.1:8000"
   npx wrangler deploy
   ```

3. Put the Client ID in `config.js → soundcloud.clientId` and the worker URL in `soundcloud.tokenEndpoint`. (For strictly personal use you can instead enter the secret in the Settings dialog; it never leaves your browser, but don't publish it in `config.js`.)

### TIDAL

1. [developer.tidal.com/dashboard](https://developer.tidal.com/dashboard) → **Create new app**, add the redirect URI, and make sure the user scopes (`user.read`, `collection.read`, `collection.write`, `playlists.read`, `playlists.write`, `search.read`) are enabled for the app.
2. Copy the **Client ID** into `config.js → tidal.clientId`. PKCE — no secret needed.
3. TIDAL still labels its v2 API as beta; if an endpoint changes, the adapter lives in `js/providers/tidal.js`.

### Deezer

1. [developers.deezer.com/myapps](https://developers.deezer.com/myapps) → **Create a new application**. Set *Application domain* to your host (e.g. `momalekiii.github.io`) and the redirect URL to the redirect URI.
2. Copy the **Application ID** into `config.js → deezer.appId`. Deezer uses the implicit flow, so no secret is required.

## Project layout

```
tunebridge/
├── index.html            page structure (hero with animated workflow, wizard steps, dialogs, footer)
├── styles.css            dark theme, brand-coloured glows, flowing gradients, animations
├── app.js                UI controller (steps, picking content, progress, results, settings)
├── config.js             deployment configuration (API keys, owner link, toggles)
├── js/
│   ├── services.js       service registry: logos, colours, capabilities, setup notes
│   ├── oauth.js          PKCE helpers, redirect handling, token storage
│   ├── http.js           fetch wrapper with retries/429 handling, JSONP fallback
│   ├── matching.js       title normalisation and track/album/artist scoring
│   ├── transfer.js       the transfer engine (pure logic, no DOM)
│   ├── settings.js       config.js + per-browser overrides
│   └── providers/        one adapter per service + demo provider
├── proxy/cloudflare-worker.js   token exchange proxy for SoundCloud
├── scripts/apple-developer-token.mjs
└── tests/                node --test suites for matching and the engine
```

Adding a service means implementing the adapter interface in `js/providers/base.js` (list → match → create/add) and registering it in `js/services.js`.

## Development

```bash
node --test tests/          # matching + transfer engine tests (uses the demo providers)
node --check app.js         # quick syntax check
```

## Privacy

TuneBridge has no backend. OAuth tokens are stored in `localStorage` of your browser (use **Settings → Sign out of all services** to remove them), API keys you enter are stored there too, and the only servers contacted are the streaming services themselves (plus your own token proxy if you use SoundCloud).

## Credits

Created by [Momalekiii](https://momalekiii.github.io). Released under the [MIT License](LICENSE). Service logos come from the CC0 [Simple Icons](https://simpleicons.org) collection; Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer are trademarks of their respective owners, and TuneBridge is not affiliated with or endorsed by any of them.
