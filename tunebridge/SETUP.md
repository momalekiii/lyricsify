# TuneBridge setup — what the site owner does once

TuneBridge is built so that **visitors never need API keys, developer accounts or anything technical**. They paste the link of a public playlist, see the songs, pick a destination and log in there — on that service's own website, with the login they always use — and come straight back to a finished transfer.

Two things make that possible, and both are a one-time job for you, the site owner:

1. **Reading pasted links.** Browsers are not allowed to read other websites, so a static page can only read Deezer links by itself (Deezer has an open API). For the other services a tiny **helper worker** fetches the public playlist page or calls the official API on the page's behalf. Free, ≈5 minutes, section 1 below.
2. **Destination logins.** Writing into someone's account needs their permission, which every service grants through its own login page (OAuth) — and every service insists on knowing which site it is sending people back to. That is what "registering TuneBridge" with each service means. Free for most services, ≈5 minutes each, sections 2–7.

You can do these in any order and skip what you don't need: services that aren't set up simply say so when a visitor picks them, and the rest keeps working.

| Service | Cost | Time | What you paste into `config.js` | Limits you should know about |
|---|---|---|---|---|
| Spotify | free, but **you need Spotify Premium** | 5 min | `spotify.clientId` | Since February 2026 a *development-mode* app admits only **5 named users** that you allow-list by e-mail, and stops working if the owner's Premium lapses. Extended quota (unlimited users) is only granted to registered businesses with 250,000+ monthly users. |
| Apple Music | **Apple Developer Program, US$99/year** | 15 min | `apple.developerToken` | Token expires after ≤ 180 days — renew it. Visitors need an Apple Music subscription. |
| YouTube Music | free | 10 min | `youtube.clientId` | Until Google verifies the app: an "unverified app" warning and up to **100 test users**. API quota ≈ 60 song transfers per day unless you request more. |
| TIDAL | free | 5 min | `tidal.clientId` | TIDAL's v2 API is still labelled beta. |
| SoundCloud | free, **by application** | 10 min + a tiny proxy | `soundcloud.clientId` + `soundcloud.tokenEndpoint` | SoundCloud reviews API requests; its token exchange needs a secret, so a free Cloudflare Worker sits in between. |
| Deezer | free | 5 min | `deezer.appId` | — |

Everything you put in `config.js` is **public by design** (it ships to the browser). Client IDs and App IDs are safe to publish — that is what they are for. Secrets (SoundCloud's client secret, TIDAL's client secret, the YouTube API key if you prefer to hide it) live in the helper worker, never in the page.

---

## 1. Helper worker — makes Spotify, Apple Music, SoundCloud and TIDAL links readable (free, 5 minutes)

The worker is one file, `proxy/cloudflare-worker.js`, with no dependencies. It answers `GET /resolve?url=…` with the playlist (name, cover, songs) and `POST /token` for logins that need a secret. Cloudflare's free tier (100,000 requests/day) is far more than a hobby site needs.

**Without any code tools:**

1. Create a free account at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker** → give it a name such as `tunebridge-helper` → **Deploy**.
2. Click **Edit code**, delete the sample, paste the whole content of `proxy/cloudflare-worker.js`, **Deploy**.
3. **Settings → Variables and Secrets** → add:
   - `ALLOWED_ORIGINS` (text): `https://momalekiii.github.io,http://127.0.0.1:8000`
   - optional `YOUTUBE_API_KEY` (secret): a YouTube Data API v3 key (see section 4) — lets the worker read YouTube links; alternatively put a referrer-restricted key straight into `config.js → youtube.apiKey` and skip this.
   - optional `SOUNDCLOUD_CLIENT_ID` + `SOUNDCLOUD_CLIENT_SECRET` (secrets): enables SoundCloud links *and* the SoundCloud destination login (section 6).
   - optional `TIDAL_CLIENT_ID` + `TIDAL_CLIENT_SECRET` (secrets): enables TIDAL links (section 5).
4. Copy the worker URL (looks like `https://tunebridge-helper.<you>.workers.dev`) into `config.js → resolverUrl`. If you use SoundCloud, also set `soundcloud.tokenEndpoint` to that URL + `/token`.
5. Open the worker URL in a browser: it answers with `{"ok":true,…,"links":{…}}` showing which services it can read.

**With wrangler instead:** `npm create cloudflare@latest tunebridge-helper` (Hello World), replace `src/index.js` with the worker file, `npx wrangler secret put …` for each secret, add `[vars] ALLOWED_ORIGINS = "…"` to `wrangler.toml`, `npx wrangler deploy`.

What the worker does per service:

| Link | How it is read | Notes |
|---|---|---|
| Spotify playlist / album | public embed page (`open.spotify.com/embed/…`) | no Spotify credentials needed; the embed lists the first ≈100 songs, the app tells the visitor when a playlist is longer |
| Apple Music playlist / album | public page (`music.apple.com/…`) | no Apple credentials needed; first ≈100 songs |
| YouTube / YouTube Music playlist | YouTube Data API (`YOUTUBE_API_KEY`) or the public playlist page | public and unlisted playlists; 1 quota unit per 50 songs |
| SoundCloud playlist | official API with client credentials | needs the SoundCloud app from section 6 |
| TIDAL playlist / album | official v2 API with client credentials | needs the TIDAL app from section 5 (it issues a client secret) |
| Deezer | public API | the browser does this itself; the worker only expands `deezer.page.link` short links |

Reading Spotify's and Apple's public pages is best effort — it is the same information anyone sees when opening the link without an account, but if a service redesigns its page the worker returns `parse_failed` and the app tells the visitor to drop an exported file instead. The worker caches each answer for 10 minutes and never stores anything.

---

## 2. Before you start with logins: the redirect URI

Every service asks for a *redirect URI* — the address it sends people back to after login. For the published site it is exactly:

```
https://momalekiii.github.io/tunebridge/
```

The trailing slash matters. If you also want to test on your own machine, add this one too:

```
http://127.0.0.1:8000/
```

(Use `127.0.0.1`, not `localhost` — Spotify no longer accepts `localhost`.) The owner settings dialog in the running app (add `#setup` to the URL) shows the exact value for whatever URL it is served from, with a copy button.

---

## 3. Spotify login (free, 5 minutes — owner needs Premium)

Read this first: Spotify tightened its developer platform on **11 February 2026** (existing apps followed on 9 March). A development-mode app now requires its owner to have an active Spotify Premium subscription, admits at most **5 allow-listed users**, and talks to a reduced API (TuneBridge already targets it: `/playlists/{id}/items`, `PUT /me/library`, search limited to 10 results). The only way past the 5-user cap is *extended quota mode*, which Spotify grants to registered businesses with a launched service and 250,000+ monthly active users — not to hobby sites. So for Spotify specifically, plan on: you + 4 people on the allow-list can use Spotify as a *destination*. Spotify as a *source* is unaffected — pasted Spotify links are read by the helper worker without any Spotify app at all.

1. Go to <https://developer.spotify.com/dashboard> and log in with your normal (Premium) Spotify account.
2. **Create app.** Name: `TuneBridge`. Description: anything. Website: `https://momalekiii.github.io/tunebridge/`. **Redirect URIs:** add the URI(s) from section 2. Under *Which API/SDKs are you planning to use?* tick **Web API**. Save.
3. Open the app → **Settings** → copy the **Client ID** and paste it into `config.js`:

   ```js
   spotify: { clientId: 'paste-it-here' },
   ```

   No client secret is needed — TuneBridge uses the PKCE flow that Spotify recommends for browser apps.
4. **Who can log in.** Only people you list under **User Management** (name + the e-mail of their Spotify account, **up to 5**) can use the app. Everyone else can log in but then sees TuneBridge's message *"the Spotify app behind this site is in development mode…"*. Add your own account first.
5. Spotify's own editorial/algorithmic playlists are not readable by development-mode apps; the visitor's own playlists, liked songs, albums and followed artists are.

## 4. Apple Music login (Apple Developer Program required, 15 minutes)

Apple's MusicKit only talks to apps that present a *developer token*, and those can only be minted with an Apple Developer Program membership (US$99/year). If you don't have one, skip Apple Music — the other five services keep working, and the Apple Music card will say the login isn't switched on yet.

1. In <https://developer.apple.com/account> → **Certificates, Identifiers & Profiles → Identifiers → +** → choose **Media IDs** → register one (e.g. `media.io.github.momalekiii.tunebridge`) with **MusicKit** enabled.
2. **Keys → +** → name it `TuneBridge MusicKit`, enable **Media Services (MusicKit, …)**, click *Configure*, pick the Media ID, then **Register** and **Download** the `.p8` file (you can download it only once). Note the **Key ID** shown there and your **Team ID** (top right of the account page).
3. Mint the token with the included script (needs Node 20+):

   ```bash
   node scripts/apple-developer-token.mjs --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --team-id YYYYYYYYYY --origin https://momalekiii.github.io
   ```

4. Paste the printed token into `config.js → apple.developerToken`. The `--origin` claim ties the token to your site, which is what makes it safe to publish. Tokens last at most 180 days — put a reminder in your calendar and re-run the script.
5. Visitors log in through Apple's own MusicKit popup with their Apple ID. They need an active Apple Music subscription.

## 5. YouTube Music login + API key (free, 10 minutes)

1. <https://console.cloud.google.com/> → create a project called `TuneBridge`.
2. **APIs & Services → Library** → search *YouTube Data API v3* → **Enable**.
3. **APIs & Services → OAuth consent screen** (Google now calls it *Google Auth Platform*): choose **External**, fill in app name `TuneBridge`, your support e-mail and developer contact. Under **Scopes** add `https://www.googleapis.com/auth/youtube`. Under **Test users** add the Gmail addresses that should be able to log in while the app is in *Testing* (up to 100).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**:
   - *Authorized JavaScript origins:* `https://momalekiii.github.io` (and `http://127.0.0.1:8000` for local testing)
   - *Authorized redirect URIs:* the URI(s) from section 2
5. Copy the **Client ID** into `config.js → youtube.clientId`. No secret is needed (browser flow).
6. **Who can log in.** While the consent screen is in *Testing*, only your test users can sign in. Click **Publish app** to let anyone in; because the YouTube scope counts as *sensitive*, Google then shows an "This app isn't verified" screen (visitors click *Advanced → Go to TuneBridge*) and caps the app at 100 users until you complete Google's verification (privacy policy page + domain verification; free, takes a few days).
7. **Quota.** Google gives each project 10,000 units per day; finding one song costs 100 units and adding it costs 50, so roughly **60 songs per day**. TuneBridge shows the estimate before a transfer. You can request more via the *YouTube API Services – Quota extension* form (free).
5. **API key for reading links (optional but recommended):** in the same project, *Credentials → Create credentials → API key*. Under *Application restrictions* choose **Websites** and add `https://momalekiii.github.io/*` (and `http://127.0.0.1:8000/*` for local testing); under *API restrictions* allow only **YouTube Data API v3**. Paste it into `config.js → youtube.apiKey`. The page can then read public and unlisted YouTube / YouTube Music playlists by itself (1 quota unit per 50 songs). If you would rather keep the key out of the page, put it into the worker as `YOUTUBE_API_KEY` instead.

## 6. TIDAL login (free, 5 minutes)

1. <https://developer.tidal.com/dashboard> → log in with your TIDAL account → **Create new app**.
2. Name it `TuneBridge`, add the redirect URI(s) from section 2, and make sure these scopes are enabled for the app: `user.read`, `collection.read`, `collection.write`, `playlists.read`, `playlists.write`, `search.read`.
3. Copy the **Client ID** into `config.js → tidal.clientId`. PKCE — no secret.
3. The TIDAL dashboard also shows a **Client Secret**. Don't put it in `config.js`; put it (with the Client ID) into the helper worker as `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` so pasted TIDAL links can be read.

## 7. SoundCloud login (free, by application, 10 minutes + the helper worker)

1. SoundCloud hands out API access on request: go to <https://soundcloud.com/you/apps>. If there is no *Register a new application* button, use the request form linked from SoundCloud's help centre ("API access"). Add the redirect URI(s) from section 2 once the app exists.
2. Copy the **Client ID** into `config.js → soundcloud.clientId`.
3. SoundCloud's token exchange requires the **client secret**, which must not be published in a web page. Put `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET` into the helper worker (section 1) — the same two secrets also let the worker read SoundCloud playlist links.
4. Put the worker URL + `/token` into `config.js → soundcloud.tokenEndpoint` (e.g. `https://tunebridge-helper.<you>.workers.dev/token`). The worker only ever exchanges authorization codes for tokens; it never sees anyone's library.

## 8. Deezer login (free, 5 minutes)

1. <https://developers.deezer.com/myapps> → **Create a new application**.
2. *Application domain:* `momalekiii.github.io`. *Redirect URL after authentication:* `https://momalekiii.github.io/tunebridge/`.
3. Copy the **Application ID** into `config.js → deezer.appId`. Deezer's browser flow needs no secret.

---

## 9. Publish and test

1. Edit `config.js`, commit, push to `main`. The included GitHub Actions workflow runs the tests and redeploys the site within a minute or two.
2. Open <https://momalekiii.github.io/tunebridge/>, paste a public playlist link (any public Deezer playlist works even before the worker exists), pick a destination and click **Log in with … & transfer**. You should see the service's own login page and come back to a running transfer.
3. Destinations you have not configured show *"Transfers to … aren't switched on for this site yet"*; link types the worker can't read show *"Reading … links isn't switched on for this site yet"* together with the file alternative. Configure them whenever you like. The owner settings dialog (for testing keys in one browser) opens with `#setup` at the end of the URL.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| Spotify: **INVALID_CLIENT: Invalid redirect URI** | The redirect URI in the Spotify dashboard doesn't match exactly. | Add `https://momalekiii.github.io/tunebridge/` (trailing slash) to the app's Redirect URIs. |
| Spotify login works, then *"the Spotify app behind this site is in development mode…"* | That person isn't on the app's allow-list (max 5). | Dashboard → your app → **User Management** → add their name and Spotify e-mail (remove someone if the list is full). |
| Spotify: *"Your application is blocked from accessing the Web API since you do not have a Spotify Premium subscription"* | The app owner's Premium lapsed. | Resubscribe; the app resumes automatically. |
| Google: **Error 400: redirect_uri_mismatch** / **origin_mismatch** | Origin or redirect URI missing on the OAuth client. | Add both to the Web application client in Google Cloud. |
| Google: **Access blocked: TuneBridge has not completed the Google verification process** | Consent screen is in Testing and the person isn't a test user. | Add them as a test user, or publish the app. |
| Apple Music card: *login isn't switched on yet* although a token is set | Token expired (≤ 180 days) or minted for a different origin. | Re-run `scripts/apple-developer-token.mjs` and paste the new token. |
| TIDAL: **invalid_scope** | A scope isn't enabled on the app. | Enable the six scopes listed above in the TIDAL dashboard. |
| SoundCloud card says it is *half set up* | `clientId` is set but `tokenEndpoint` isn't. | Deploy the worker (section 5) and paste its URL. |

## FAQ

**Can visitors just log in without me registering anything?** No — not on any website, including this one. Login-and-return (OAuth) always requires the site to be a registered client of the service. Your visitors still only ever use their normal username and password, on the service's own page; TuneBridge never sees it.

**Is there anything technical visitors can stumble into?** No. The owner settings dialog is only reachable via `#setup` in the URL or the small *Site owner settings* link in the About dialog, and it only stores values in that one browser. Set `allowUserKeys: false` in `config.js` to disable it entirely.

**Is it safe to publish the client IDs?** Yes. Browser apps are *public clients*: the IDs identify the app, they don't authenticate it. Spotify, Google, TIDAL and Deezer all designed their browser flows for exactly this. Secrets (SoundCloud) never go into the page.

**What if I only register some services?** Everything else keeps working. Each card tells visitors honestly which logins are switched on.
