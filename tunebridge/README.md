# TuneBridge

**Move your music between streaming services — right in your browser.**

TuneBridge rebuilds your playlists, saved albums and followed artists on another service. Pick a source, pick a destination, sign in to both, tick what you want to move, and watch it go. It supports **Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer**, in every direction the services' APIs allow.

It is a static web app (plain HTML, CSS and JavaScript — no build step, no server, no database). You sign in with each service directly through its official login; the tokens stay in your browser. Nothing is uploaded anywhere because there is nowhere to upload it to.

**How login works.** Visitors never need API keys or developer accounts: *Log in with Spotify* opens Spotify's own login page and brings them straight back. The only setup is a **one-time registration of TuneBridge with each service by the site owner** (free for most of them, about five minutes each) — see [SETUP.md](SETUP.md).

**No login at all on the source side.** Pick **File or link** as the source and drop what the services let you export — a Spotify *Download your data* ZIP, Google Takeout, an Apple Music playlist export (XML / Plain Text), CSVs from Exportify / TuneMyMusic / Soundiiz, M3U files or a plain `Artist – Title` list — or paste a **public Deezer** playlist/album link. Everything is parsed in the browser, nothing is uploaded, and the imported library survives the destination's login redirect. This is the practical route for Spotify now that new Spotify apps are capped at 5 users.

## What can move where?

| Service | Playlists | Saved albums | Followed artists |
| --- | --- | --- | --- |
| Spotify | ✓ read & write ⁵ | ✓ read & write | ✓ read & write |
| Apple Music | ✓ read & write | ✓ read & write | read only ¹ |
| YouTube Music | ✓ read & write ² | — ³ | ✓ read & write (channel subscriptions) |
| SoundCloud | ✓ read & write | ✓ read & write ⁴ | ✓ read & write |
| TIDAL | ✓ read & write | ✓ read & write | ✓ read & write |
| Deezer | ✓ read & write | ✓ read & write | ✓ read & write |
| File or link (no login) | read ⁶ | read ⁶ | read ⁶ |

"Liked Songs"-style libraries (Spotify Liked Songs, YouTube Music Liked Music, SoundCloud likes, TIDAL collection tracks, Deezer Loved Tracks, the whole Apple Music song library) appear as a special playlist and can be transferred like any other.

1. Apple Music has no public API for following/favouriting artists, so artists can be read from Apple Music but not written to it.
2. The YouTube Data API's default quota (10,000 units/day) allows roughly 60–65 tracks to be *added* per day (each track costs a search + an insert). Reading from YouTube Music is cheap. You can request a higher quota from Google.
3. The YouTube Data API has no notion of saved albums.
4. SoundCloud "albums" are playlists flagged as albums; saving one likes it.
5. Since Spotify's February 2026 developer rules, a development-mode app can only read the contents of playlists the signed-in user owns or collaborates on; the app owner needs Spotify Premium and may allow-list 5 users (see [SETUP.md](SETUP.md)).
6. Imports are a source only: Spotify data export (`Playlist*.json`, `YourLibrary.json`, or the whole ZIP), Google Takeout (`music library songs`, `subscriptions`), Apple Music / iTunes XML, Plain Text and M3U exports, CSV/TSV with title + artist columns, plain text lists, and public Deezer playlist / album / artist links.

## How matching works

For every track TuneBridge first tries the **ISRC** (the industry-standard recording ID) when both services expose it — that is an exact hit. Otherwise it searches the destination and scores candidates by cleaned-up title, artist overlap and duration, and it refuses lookalikes such as karaoke versions, covers, live recordings or remixes unless the original was one too. Albums use UPC first, then title + artist; artists match on normalised names. Every transfer ends with a list of what could not be found, downloadable as CSV.

## Try it

- **Live:** <https://momalekiii.github.io/tunebridge/> — the *Demo* toggle in the top bar runs the whole flow with sample libraries and needs no keys.
- **Locally** (from the repository root):

  ```bash
  python -m http.server 8000 --bind 127.0.0.1     # or: npm start
  # open http://127.0.0.1:8000/
  ```

  Use `127.0.0.1` rather than `localhost`: Spotify no longer accepts `localhost` redirect URIs. ES modules need an HTTP server, so don't open `index.html` from the file system.

## Deploy (GitHub Pages)

This repository deploys itself. Every push to `main` runs the tests and publishes the site with the included workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

1. Create the repository `momalekiii/tunebridge` and push these files to `main`.
2. The first workflow run enables GitHub Pages automatically (**Settings → Pages** should show *Source: GitHub Actions*; if it doesn't, select it there and re-run the workflow).
3. The site is live at **`https://momalekiii.github.io/tunebridge/`**. That URL — with the trailing slash — is the **redirect URI** to register with every service. The Settings dialog in the app shows the exact value for whatever URL it runs on, with a copy button.
4. Fill in `config.js` with your API keys (see below) and push again.

Any other static host (Netlify, Vercel, Cloudflare Pages, your own server) works the same way: upload the files, register the new URL as the redirect URI.

### Releasing a new version

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Bump the cache-busting query strings in `index.html` (`styles.css?v=…`, `app.js?v=…`, `config.js?v=…`) so returning visitors get the new files.
3. Push to `main` (deploys automatically), then tag it: `git tag v1.0.0 && git push --tags` and, optionally, `gh release create v1.0.0 --notes-file CHANGELOG.md`.

## Setting up the services

Everything a site owner needs — per-service steps, costs, user limits, the redirect URI, troubleshooting — lives in **[SETUP.md](SETUP.md)**. In short: register TuneBridge once with each service, paste the resulting Client ID / App ID / developer token into `config.js`, push. Keys in `config.js` are public by design (they ship to the browser); the only secret in the whole setup (SoundCloud's) goes into the included Cloudflare Worker, never into the page.

Visitors can additionally bring their own developer app through the *Advanced* dialog (stored in their browser only, takes precedence over `config.js`) — handy because a Spotify development-mode app admits only 5 allow-listed users (Spotify's February 2026 rules; the app owner also needs Premium). Set `allowUserKeys: false` to hide that option.

## Project layout

```
├── index.html            page structure (hero with animated workflow, wizard steps, dialogs, footer)
├── styles.css            dark theme, brand-coloured glows, flowing gradients, animations
├── app.js                UI controller (steps, picking content, progress, results, settings)
├── config.js             one-time owner configuration (service registrations, owner link, toggles)
├── SETUP.md              step-by-step guide: register TuneBridge with each service so visitors can just log in
├── js/
│   ├── services.js       service registry: logos, colours, capabilities, setup notes
│   ├── oauth.js          PKCE helpers, redirect handling, token storage
│   ├── http.js           fetch wrapper with retries/429 handling, JSONP fallback
│   ├── matching.js       title normalisation and track/album/artist scoring
│   ├── transfer.js       the transfer engine (pure logic, no DOM)
│   ├── settings.js       config.js + per-browser overrides
│   ├── importers/        no-login sources: ZIP/JSON/XML/CSV/M3U parsers, Deezer public links, IndexedDB library
│   └── providers/        one adapter per service + demo provider + the import source
├── proxy/cloudflare-worker.js   token exchange proxy for SoundCloud (optionally Deezer)
├── scripts/apple-developer-token.mjs
├── tests/                node --test suites (matching, engine, adapters against mocked APIs, importers)
└── .github/workflows/    CI + GitHub Pages deployment
```

Adding a service means implementing the adapter interface in `js/providers/base.js` (list → match → create/add) and registering it in `js/services.js`.

## Development

```bash
npm test        # node --test tests/*.test.mjs  (matching, transfer engine, adapters with mocked APIs)
npm run check   # syntax-check every module
```

No dependencies, no build step: edit the files and reload.

## Privacy

TuneBridge has no backend. OAuth tokens are stored in `localStorage` of your browser (use **Settings → Sign out of all services** to remove them), API keys you enter are stored there too, and the only servers contacted are the streaming services themselves (plus your own token proxy if you use SoundCloud).

## Credits

Created by [Momalekiii](https://momalekiii.github.io). Released under the [MIT License](LICENSE). Service logos come from the CC0 [Simple Icons](https://simpleicons.org) collection; Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer are trademarks of their respective owners, and TuneBridge is not affiliated with or endorsed by any of them.
