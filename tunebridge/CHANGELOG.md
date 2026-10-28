# Changelog

## 1.1.1 — 2026-10-28

Fixes from the first real-browser test of the paste flow, plus the service dock.

- **Fixed: nothing reacted after pasting.** `app.js?v=…` was versioned but the modules it imports were not, so a browser that had seen an earlier version kept stale modules and the script failed on load (no logo swap, dead buttons). `index.html` now carries an import map that pins every module to the release version (`npm run stamp`; `npm test` checks it).
- **Fixed:** typing or pasting an incomplete link threw (`classList.add('')`) and stopped the bar from updating.
- **New: service dock** under the bar — the six service icons; the one your link comes from glows in its brand gradient, the others step back. Tap one to be told what to paste. Replaces the "Works with" strip.
- Links: URLs wrapped in share text ("Listen on Spotify: https://…") are extracted; `link.deezer.com` short links and `music.youtube.com/browse/VL…` are recognised.
- Logging in from an embedded preview (iframe) opens the service's login in a new tab, since login pages refuse to render in frames; the pending transfer is picked up there.
- A site with no destination configured offers the sample destination right in step 3 (visible only until a real service is set up); the sample-mode badge is a button that leaves sample mode.
- Footer: "© Developed with ❤️ by momalekiii" (both © and the name link to the author's site).
- After a reload the dock keeps glowing for the service the loaded playlist came from.
- Verification: `tests/e2e/browser.mjs` drives a real Chromium through the whole app against mocked endpoints — link bar for all six services, Deezer paste, the worker's own code answering `/resolve`, four file formats, a complete Spotify PKCE login round-trip with auto-resumed transfer, dialogs, settings, mobile (66 checks). The worker was also exercised under Cloudflare's runtime (`wrangler dev`): index, CORS allow/deny, every error path, `/token`.

## 1.1.0 — 2026-10-28

**Paste a link, log in once.** The source side no longer has a login at all.

- New flow: paste the link of a public playlist → the box takes the service's logo and colours → preview (cover, name, every song) → pick a destination → one button *Log in with … & transfer*. The login happens on the destination's own website; the transfer starts automatically on return.
- Link reading: Deezer directly from the browser; YouTube / YouTube Music via a free API key or the worker; Spotify, Apple Music, SoundCloud and TIDAL via the new helper worker (`proxy/cloudflare-worker.js` → `GET /resolve`), which also keeps the SoundCloud/Deezer token exchange (`POST /token`). Short links (spotify.link, on.soundcloud.com, deezer.page.link) are expanded by the worker.
- Files still work as a fallback for private playlists and whole libraries: drop anywhere on the page or use *drop an exported file*.
- Footer reduced to `©` (linking to the author's site) and the heart.
- Developer-facing controls removed from the visible UI: owner settings via `#setup` or *About → Site owner settings*; sample destination via `#demo`.
- Tests: link classifier for all six services, YouTube title cleaning, resolver client, worker parsers and router (38 total).

## 1.0.0 — 2026-10-28

First public release.

- Transfer playlists, saved albums and followed artists between Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer, in every direction the official APIs allow.
- "Liked Songs"-style libraries available as special playlists.
- ISRC/UPC-first matching with title, artist and duration scoring that rejects covers, karaoke, live and remix lookalikes.
- Live progress, cancellation, and a downloadable CSV of anything that could not be found.
- **File or link** source: transfer without logging in to the source. Drop a Spotify *Download your data* ZIP, Google Takeout, Apple Music XML / Plain Text / M3U exports, CSV (Exportify, TuneMyMusic, Soundiiz…) or an `Artist – Title` text list, or paste a public Deezer link. Parsed entirely in the browser; the imported library is kept in IndexedDB so it survives the destination's login redirect.
- Spotify adapter targets the February 2026 development-mode API (`/playlists/{id}/items`, `PUT /me/library`, `POST /me/playlists`, 10-result searches) and falls back to the classic endpoints for extended-quota apps; owner-only playlist reads are explained instead of failing with 403.
- Login-first flow: visitors just click *Log in with …* and sign in on the service's own site; the site owner registers the app once (see SETUP.md). Spotify's development-mode allow-list is explained in-app instead of a bare 403.
- Demo mode with sample libraries; *Advanced* dialog for bring-your-own developer apps.
- Cloudflare Worker token proxy (SoundCloud, optional Deezer) and an Apple Music developer-token script.
