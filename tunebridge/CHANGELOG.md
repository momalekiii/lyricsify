# Changelog

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
