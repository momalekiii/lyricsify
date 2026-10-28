# TuneBridge setup — make "Log in with …" work for your visitors

TuneBridge is built so that **visitors never need API keys, developer accounts or anything technical**. They click *Log in with Spotify*, sign in on Spotify's own website (the same login page they always use), and land back on TuneBridge. The same goes for every other service.

What the services need in exchange is that **TuneBridge itself is registered with them once, by you, the site owner.** That registration is how a service knows it may send people back to `https://momalekiii.github.io/tunebridge/` after login, and what name to show on its consent screen. There is no way around it from a website — browsers deliberately stop one site from reading your login session on another, and no streaming service accepts an unregistered site as a login destination. (Services such as Soundiiz or TuneMyMusic work exactly the same way; they just did this step a long time ago.)

The good news: it is a one-time job, it is free for most services, and each one takes about five minutes.

There is also a path that needs **no registration at all** for the *source* side: visitors can pick **File or link** and drop a Spotify data export, Google Takeout, an Apple Music playlist export, a CSV/M3U, or paste a public Deezer link. Only the destination service has to be registered. For Spotify this is the recommended route, because Spotify now caps new apps at 5 users (see below).

| Service | Cost | Time | What you paste into `config.js` | Limits you should know about |
|---|---|---|---|---|
| Spotify | free, but **you need Spotify Premium** | 5 min | `spotify.clientId` | Since February 2026 a *development-mode* app admits only **5 named users** that you allow-list by e-mail, and stops working if the owner's Premium lapses. Extended quota (unlimited users) is only granted to registered businesses with 250,000+ monthly users. |
| Apple Music | **Apple Developer Program, US$99/year** | 15 min | `apple.developerToken` | Token expires after ≤ 180 days — renew it. Visitors need an Apple Music subscription. |
| YouTube Music | free | 10 min | `youtube.clientId` | Until Google verifies the app: an "unverified app" warning and up to **100 test users**. API quota ≈ 60 song transfers per day unless you request more. |
| TIDAL | free | 5 min | `tidal.clientId` | TIDAL's v2 API is still labelled beta. |
| SoundCloud | free, **by application** | 10 min + a tiny proxy | `soundcloud.clientId` + `soundcloud.tokenEndpoint` | SoundCloud reviews API requests; its token exchange needs a secret, so a free Cloudflare Worker sits in between. |
| Deezer | free | 5 min | `deezer.appId` | — |

Everything you put in `config.js` is **public by design** (it ships to the browser). Client IDs and App IDs are safe to publish — that is what they are for. The only secret in the whole setup is SoundCloud's client secret, which lives in the proxy, never in the page.

---

## 0. Before you start: the redirect URI

Every service asks for a *redirect URI* — the address it sends people back to after login. For the published site it is exactly:

```
https://momalekiii.github.io/tunebridge/
```

The trailing slash matters. If you also want to test on your own machine, add this one too:

```
http://127.0.0.1:8000/
```

(Use `127.0.0.1`, not `localhost` — Spotify no longer accepts `localhost`.) The Advanced dialog in the running app shows the exact value for whatever URL it is served from, with a copy button.

---

## 1. Spotify (free, 5 minutes — owner needs Premium)

Read this first: Spotify tightened its developer platform on **11 February 2026** (existing apps followed on 9 March). A development-mode app now requires its owner to have an active Spotify Premium subscription, admits at most **5 allow-listed users**, and talks to a reduced API (TuneBridge already targets it: `/playlists/{id}/items`, `PUT /me/library`, search limited to 10 results). The only way past the 5-user cap is *extended quota mode*, which Spotify grants to registered businesses with a launched service and 250,000+ monthly active users — not to hobby sites. So for Spotify specifically, plan on: you + 4 people on the allow-list, and everyone else bringing their own free Spotify app via *Advanced* (they need Premium too).

1. Go to <https://developer.spotify.com/dashboard> and log in with your normal (Premium) Spotify account.
2. **Create app.** Name: `TuneBridge`. Description: anything. Website: `https://momalekiii.github.io/tunebridge/`. **Redirect URIs:** add the URI(s) from step 0. Under *Which API/SDKs are you planning to use?* tick **Web API**. Save.
3. Open the app → **Settings** → copy the **Client ID** and paste it into `config.js`:

   ```js
   spotify: { clientId: 'paste-it-here' },
   ```

   No client secret is needed — TuneBridge uses the PKCE flow that Spotify recommends for browser apps.
4. **Who can log in.** Only people you list under **User Management** (name + the e-mail of their Spotify account, **up to 5**) can use the app. Everyone else can log in but then sees TuneBridge's message *"the Spotify app behind this site is in development mode…"*. Add your own account first.
   - Leave `allowUserKeys: true` in `config.js` so other visitors can use their own Spotify app via *Advanced* (a 5-minute job for them; they need Premium as the app owner).
5. Spotify's own editorial/algorithmic playlists are not readable by development-mode apps; the visitor's own playlists, liked songs, albums and followed artists are.

## 2. Apple Music (Apple Developer Program required, 15 minutes)

Apple's MusicKit only talks to apps that present a *developer token*, and those can only be minted with an Apple Developer Program membership (US$99/year). If you don't have one, skip Apple Music — the other five services keep working, and the Apple Music card will say the login isn't switched on yet.

1. In <https://developer.apple.com/account> → **Certificates, Identifiers & Profiles → Identifiers → +** → choose **Media IDs** → register one (e.g. `media.io.github.momalekiii.tunebridge`) with **MusicKit** enabled.
2. **Keys → +** → name it `TuneBridge MusicKit`, enable **Media Services (MusicKit, …)**, click *Configure*, pick the Media ID, then **Register** and **Download** the `.p8` file (you can download it only once). Note the **Key ID** shown there and your **Team ID** (top right of the account page).
3. Mint the token with the included script (needs Node 20+):

   ```bash
   node scripts/apple-developer-token.mjs --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --team-id YYYYYYYYYY --origin https://momalekiii.github.io
   ```

4. Paste the printed token into `config.js → apple.developerToken`. The `--origin` claim ties the token to your site, which is what makes it safe to publish. Tokens last at most 180 days — put a reminder in your calendar and re-run the script.
5. Visitors log in through Apple's own MusicKit popup with their Apple ID. They need an active Apple Music subscription.

## 3. YouTube Music (free, 10 minutes)

1. <https://console.cloud.google.com/> → create a project called `TuneBridge`.
2. **APIs & Services → Library** → search *YouTube Data API v3* → **Enable**.
3. **APIs & Services → OAuth consent screen** (Google now calls it *Google Auth Platform*): choose **External**, fill in app name `TuneBridge`, your support e-mail and developer contact. Under **Scopes** add `https://www.googleapis.com/auth/youtube`. Under **Test users** add the Gmail addresses that should be able to log in while the app is in *Testing* (up to 100).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**:
   - *Authorized JavaScript origins:* `https://momalekiii.github.io` (and `http://127.0.0.1:8000` for local testing)
   - *Authorized redirect URIs:* the URI(s) from step 0
5. Copy the **Client ID** into `config.js → youtube.clientId`. No secret is needed (browser flow).
6. **Who can log in.** While the consent screen is in *Testing*, only your test users can sign in. Click **Publish app** to let anyone in; because the YouTube scope counts as *sensitive*, Google then shows an "This app isn't verified" screen (visitors click *Advanced → Go to TuneBridge*) and caps the app at 100 users until you complete Google's verification (privacy policy page + domain verification; free, takes a few days).
7. **Quota.** Google gives each project 10,000 units per day; finding one song costs 100 units and adding it costs 50, so roughly **60 songs per day**. TuneBridge shows the estimate before a transfer. You can request more via the *YouTube API Services – Quota extension* form (free).

## 4. TIDAL (free, 5 minutes)

1. <https://developer.tidal.com/dashboard> → log in with your TIDAL account → **Create new app**.
2. Name it `TuneBridge`, add the redirect URI(s) from step 0, and make sure these scopes are enabled for the app: `user.read`, `collection.read`, `collection.write`, `playlists.read`, `playlists.write`, `search.read`.
3. Copy the **Client ID** into `config.js → tidal.clientId`. PKCE — no secret.

## 5. SoundCloud (free, by application, 10 minutes + proxy)

1. SoundCloud hands out API access on request: go to <https://soundcloud.com/you/apps>. If there is no *Register a new application* button, use the request form linked from SoundCloud's help centre ("API access"). Add the redirect URI(s) from step 0 once the app exists.
2. Copy the **Client ID** into `config.js → soundcloud.clientId`.
3. SoundCloud's token exchange requires the **client secret**, which must not be published in a web page. The repository includes a tiny proxy for exactly this (free Cloudflare account, no card):

   ```bash
   npm create cloudflare@latest tunebridge-proxy      # pick "Hello World" worker
   # replace src/index.js with proxy/cloudflare-worker.js from this repository
   npx wrangler secret put SOUNDCLOUD_CLIENT_ID
   npx wrangler secret put SOUNDCLOUD_CLIENT_SECRET
   # in wrangler.toml add:  [vars]  ALLOWED_ORIGINS = "https://momalekiii.github.io,http://127.0.0.1:8000"
   npx wrangler deploy                                 # prints https://tunebridge-proxy.<you>.workers.dev
   ```

4. Put that worker URL into `config.js → soundcloud.tokenEndpoint`. The worker only ever exchanges authorization codes for tokens; it never sees anyone's library.

## 6. Deezer (free, 5 minutes)

1. <https://developers.deezer.com/myapps> → **Create a new application**.
2. *Application domain:* `momalekiii.github.io`. *Redirect URL after authentication:* `https://momalekiii.github.io/tunebridge/`.
3. Copy the **Application ID** into `config.js → deezer.appId`. Deezer's browser flow needs no secret.

---

## 7. Publish and test

1. Edit `config.js`, commit, push to `main`. The included GitHub Actions workflow runs the tests and redeploys the site within a minute or two.
2. Open <https://momalekiii.github.io/tunebridge/>, pick two services and click **Log in with …** on each. You should see the service's own login page and come back to TuneBridge with *Connected as <your name>*.
3. Services you have not configured simply show *"… login isn't switched on for this site yet"* — the rest of the app keeps working. Configure them whenever you like.

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

**Do visitors have to do anything in *Advanced*?** No. That dialog exists only for people who want to use their own developer app — for example when your Spotify app's 5-user allow-list is full. Set `allowUserKeys: false` in `config.js` to hide it entirely.

**Is it safe to publish the client IDs?** Yes. Browser apps are *public clients*: the IDs identify the app, they don't authenticate it. Spotify, Google, TIDAL and Deezer all designed their browser flows for exactly this. Secrets (SoundCloud) never go into the page.

**What if I only register some services?** Everything else keeps working. Each card tells visitors honestly which logins are switched on.
