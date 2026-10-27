# Lyricsify

Lyricsify is a phone-first, installable web app for finding lyrics, saving songs in your browser, and turning 1–10 chosen lines into a shareable image. Its minimal Spotify-inspired interface places a centered logo above one search field, searches automatically after typing pauses, and shows matches in a dropdown. Saved songs, theme, and language controls are easy to reach from the header; About contains app information. Tap lyric lines to select up to ten without text-dragging. The app includes English and Persian (RTL with Vazirmatn) plus light and dark themes. The footer credits @momalekiii. The app is plain HTML, CSS, and JavaScript: no build step, framework, server, or API key is needed for the web experience.

## Also in this repository: TuneBridge

[`tunebridge/`](tunebridge/) is a separate web app for moving playlists, saved albums and followed artists between Spotify, Apple Music, YouTube Music, SoundCloud, TIDAL and Deezer. It is self-contained (its own README, config and assets) so it can be lifted into its own repository and published on GitHub Pages. See [tunebridge/README.md](tunebridge/README.md).

## Run it locally

The site uses browser APIs (including a service worker), so serve the files over HTTP rather than opening `index.html` directly. Type a song or artist, then pause briefly for automatic search; press Enter to search immediately:

```bash
python -m http.server 8000 --bind 0.0.0.0
```

Then visit <http://localhost:8000>. Searches use two providers:

- **LRCLIB** for catalog search and lyric text. Artist/title searches try LRCLIB's exact-track endpoint and then its structured search, identifying Lyricsify with the client header required by LRCLIB's docs.
- **Lyrics.ovh** for direct artist/title lookups. Use `Artist - Song title` or `Song title by Artist` when selecting Lyrics.ovh.
- **Apple's iTunes Search API** for matching album-cover artwork and a track-metadata fallback when no lyric source matches; it does not provide lyrics.

Searches use all available lyric sources by default; when the query has an explicit artist/title format, Lyrics.ovh is included with LRCLIB. When a song is open, artist-specific search links are available for Spotify and SoundCloud; the links open each service's artist results because direct profile IDs are not provided by the lyrics sources. Lyrics availability varies by song and provider. Searches require an internet connection; the app shell is cached for subsequent visits, while saved songs are stored only in that browser's local storage.

## Share a lyric

1. Search and open a song.
2. Tap up to ten lyric lines to add them to the excerpt, or type your own. The lyric lines are buttons rather than selectable text; an attempt to select an eleventh line shows a warning.
3. Select **Share card**, open **Instagram** to choose **Story (9:16)** or **Post (4:5)**, or use **Download image**, **Copy text**, or **Post to X**.

Share cards are rendered on-device as PNGs with matching album artwork when available (1080 × 1350 for posts, 1080 × 1920 for Stories). They omit Lyricsify branding and lyric-provider labels so the selected excerpt stays front and center. The X and Instagram share text places “— by Lyricsify” under the excerpt. On phones, **Share card**, **Instagram**, and **Post to X** use the native share sheet when the browser supports sharing image files, with a prefilled caption. Choose Instagram or X there to pass along the image. If image sharing is unavailable, the image downloads; X opens a prefilled text composer so you can attach it, and Instagram opens for manual upload. The social app always requires you to confirm the post. **Post to X** opens X's composer with a short prefilled introduction, the selected line, and song credit; the user reviews and publishes it. The app does not log in to social accounts or post on a user's behalf. Social services decide which sharing options are available on a given device.

Lyrics are copyrighted works. Lyricsify does not operate a central lyric catalog; lyrics are fetched from the named providers and remain the property of their respective writers and publishers. Share thoughtfully and follow each provider's terms.

## Publish with GitHub Pages

The repository includes a GitHub Actions Pages workflow. After merging to `main`, enable **Settings → Pages → Build and deployment → GitHub Actions** in the repository if it is not already enabled. The workflow will publish the static site at the repository's GitHub Pages URL (usually `https://<owner>.github.io/<repository>/`). All app assets and manifest paths are relative, so it works under that project subpath. You can also start a deployment from **Actions → Deploy Lyricsify to GitHub Pages → Run workflow**.

## Install on a phone

Lyricsify is a Progressive Web App. On Android, open the HTTPS site in Chrome and choose **Install app** (or **Add to Home screen**). On iPhone/iPad, open it in Safari, tap **Share**, then **Add to Home Screen**. The app shell can open offline, but lyric searches need a connection. Browsers and social apps control whether image sharing is offered.

If a store-distributed mobile app is wanted later, this static app can be wrapped with Capacitor for Android and iOS. That adds platform build/signing work and does not bypass app-store policies or Instagram/X sharing restrictions. A native wrapper is not required to use the installable web app.

## Optional desktop client

`main.py` remains as a small Tkinter desktop client. It caches searches in a local SQLite database and queries Genius asynchronously, so a network request does not freeze the window. Genius is optional for the web app and is used only by this legacy desktop client:

```bash
python -m venv .venv
# Activate the environment, then:
pip install -r requirements.txt
cp .env.example .env
# Put your Genius API token in .env, then:
python main.py
```

The desktop client can still read cached songs without a token. The `database.db` file is local and ignored by Git.

## Development checks

```bash
node --check app.js
python -m py_compile main.py
```

## Credits

Created by [@momalekiii](https://github.com/momalekiii). Licensed under the [MIT License](LICENSE). Lyrics search and availability are provided by [LRCLIB](https://lrclib.net) and [Lyrics.ovh](https://lyrics.ovh). The original desktop client used the [Genius API](https://genius.com/developers).
