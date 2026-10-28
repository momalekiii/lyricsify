# Changelog

## 1.0.0 — 2026-10-28

First public release.

- Transfer playlists, saved albums and followed artists between Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer, in every direction the official APIs allow.
- "Liked Songs"-style libraries available as special playlists.
- ISRC/UPC-first matching with title, artist and duration scoring that rejects covers, karaoke, live and remix lookalikes.
- Live progress, cancellation, and a downloadable CSV of anything that could not be found.
- Login-first flow: visitors just click *Log in with …* and sign in on the service's own site; the site owner registers the app once (see SETUP.md). Spotify's development-mode allow-list is explained in-app instead of a bare 403.
- Demo mode with sample libraries; *Advanced* dialog for bring-your-own developer apps.
- Cloudflare Worker token proxy (SoundCloud, optional Deezer) and an Apple Music developer-token script.
