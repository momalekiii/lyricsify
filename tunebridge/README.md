# TuneBridge

**Paste a playlist link. Get it on another streaming service.**

TuneBridge copies a public playlist (or album) from **Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL or Deezer** to any of them. The visitor's side could not be simpler:

1. **Paste the link** of a public playlist — the box lights up in that service's colours and shows its logo.
2. **Check the preview** — cover, name and every song, read without logging in anywhere.
3. **Pick where it should go and log in there** — on that service's own website, with the login they always use. The transfer starts by itself the moment they come back.

No accounts to create, no API keys, no passwords typed into TuneBridge, nothing to install. It is a static web app (plain HTML, CSS and JavaScript — no build step, no database) that runs in the browser and is published on GitHub Pages.

**Source without login.** The pasted link is read through public data: Deezer's public API directly from the browser; YouTube through the (free) YouTube Data API; Spotify, Apple Music, SoundCloud and TIDAL through a tiny helper worker the site owner deploys once (see below). Visitors who have a private playlist — or want their whole library — can **drop an exported file** instead (Spotify *Download your data* ZIP, Apple Music XML, Google Takeout, CSV, M3U…), which is parsed entirely in the browser.

**Destination with the real login.** Writing into someone's account is only possible with their permission, so the destination uses the service's official login page (OAuth). The site owner registers TuneBridge with each destination service once — free for most of them, about five minutes each — see [SETUP.md](SETUP.md). Visitors never see any of that.

## What can go where?

| Pasted link (source, no login) | Reads | How |
| --- | --- | --- |
| Deezer playlist / album | ✓ | public API, straight from the browser — works with zero setup |
| YouTube / YouTube Music playlist | ✓ (public or unlisted) | free YouTube Data API key, or the helper worker |
| Spotify playlist / album | ✓ first ≈100 songs ¹ | helper worker reads the public embed page |
| Apple Music playlist / album | ✓ ¹ | helper worker reads the public page |
| SoundCloud playlist | ✓ | helper worker + SoundCloud API credentials |
| TIDAL playlist / album | ✓ | helper worker + TIDAL API credentials |
| Dropped file | ✓ playlists, albums, artists | Spotify data export (ZIP / `Playlist*.json` / `YourLibrary.json`), Google Takeout, Apple Music / iTunes XML, Plain Text and M3U exports, CSV/TSV (Exportify, TuneMyMusic, Soundiiz…), `Artist – Title` text lists |

| Destination (login) | Playlists | Saved albums | Followed artists |
| --- | --- | --- | --- |
| Spotify | ✓ | ✓ | ✓ |
| Apple Music | ✓ | ✓ | — ² |
| YouTube Music | ✓ ³ | — ⁴ | ✓ (channel subscriptions) |
| SoundCloud | ✓ | ✓ ⁵ | ✓ |
| TIDAL | ✓ | ✓ | ✓ |
| Deezer | ✓ | ✓ | ✓ |

1. Spotify and Apple Music have no key-free API, so the worker reads what their public pages show — the first ≈100 songs — and the app says so in the preview. For longer playlists visitors drop an export file (the help dialog explains where to get it). Page scraping is best effort: if either service redesigns its pages the worker returns a clear error and the app points to the file route.
2. Apple Music has no public API for following artists.
3. The YouTube Data API's default quota (10,000 units/day) allows roughly 60–65 tracks to be *added* per day. You can request a higher quota from Google.
4. The YouTube Data API has no notion of saved albums.
5. SoundCloud "albums" are playlists flagged as albums; saving one likes it.

## How matching works

For every track TuneBridge first tries the **ISRC** (the industry-standard recording ID) when both services expose it — that is an exact hit. Otherwise it searches the destination and scores candidates by cleaned-up title, artist overlap and duration, and it refuses lookalikes such as karaoke versions, covers, live recordings or remixes unless the original was one too. Albums use UPC first, then title + artist; artists match on normalised names. Every transfer ends with a list of what could not be found, downloadable as CSV.

## Try it

- **Live:** <https://momalekiii.github.io/tunebridge/> — paste any public **Deezer** playlist link and it works with no setup at all; add `#demo` to the URL to use a sample destination that touches no real account.
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

## Setting up the services (site owner, once)

Everything lives in **[SETUP.md](SETUP.md)**. In short:

- **Helper worker** (reads Spotify / Apple Music / SoundCloud / TIDAL links, ≈5 minutes, free): paste `proxy/cloudflare-worker.js` into a Cloudflare Worker, set `ALLOWED_ORIGINS`, put its URL into `config.js → resolverUrl`. Optional secrets add YouTube (API key), SoundCloud and TIDAL link reading. Deezer links need nothing.
- **Destinations**: register TuneBridge once with each service you want people to be able to transfer *to*, paste the Client ID / App ID / developer token into `config.js`, push. Keys in `config.js` are public by design; the only secrets (SoundCloud, TIDAL, YouTube key) live in the worker.

Nothing technical is shown to visitors. The owner settings dialog is reachable by adding `#setup` to the URL (or via *About → Site owner settings*); services that aren't configured simply say so when picked as a destination.

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
│   ├── importers/        pasted links (classifier, Deezer/YouTube direct, resolver client) + file parsers (ZIP/JSON/XML/CSV/M3U) + IndexedDB library
│   └── providers/        one adapter per service + demo provider + the import source
├── proxy/cloudflare-worker.js   token exchange proxy for SoundCloud (optionally Deezer)
├── scripts/apple-developer-token.mjs
├── tests/                node --test suites (matching, engine, adapters against mocked APIs, importers, resolver worker)
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
