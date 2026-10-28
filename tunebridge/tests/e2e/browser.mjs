// Real-browser end-to-end check of TuneBridge against mocked platform endpoints.
//
//   1. Serve the app:        npm start          (http://127.0.0.1:8000/)
//   2. Install a driver:     npm i --no-save puppeteer-core    (and have Chrome/Chromium installed)
//   3. Run:                  CHROME=/path/to/chrome node tests/e2e/browser.mjs [http://127.0.0.1:8000/]
//
// What it covers (66 checks): link bar for all six services, paste → preview (Deezer API mocked),
// the helper worker's real code answering /resolve for Spotify + Apple pages, file imports
// (CSV / Spotify JSON / M3U / Apple XML), a complete Spotify login round-trip (PKCE authorize →
// code → token → auto-resumed transfer → results, all endpoints mocked), follow-up actions,
// dialogs, sample mode, owner settings and the mobile layout. No real network calls are made.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', '..');
const FIX = join(here, 'fixtures');
const base = process.argv[2] || 'http://127.0.0.1:8000/';
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch (_) { console.error('Install the driver first: npm i --no-save puppeteer-core'); process.exit(2); }
let executablePath = process.env.CHROME || process.env.PUPPETEER_EXECUTABLE_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));
let extraArgs = [];
if (!executablePath) {
  try { const chromium = (await import('@sparticuz/chromium')).default; executablePath = await chromium.executablePath(); extraArgs = chromium.args.filter((a) => !/disable-web-security/.test(a)); } catch (_) {}
}
if (!executablePath) { console.error('No Chrome found — set CHROME=/path/to/chrome'); process.exit(2); }
const worker = (await import(pathToFileURL(`${APP}/proxy/cloudflare-worker.js`).href)).default;

// ---------- fixtures ----------
const script = (attrs, obj) => `<script ${attrs}>${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const spotifyEntity = { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M', uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', name: 'Today’s Top Hits', subtitle: 'Spotify', trackCount: 50, coverArt: { sources: [{ url: 'https://i.scdn.co/image/small', width: 300 }, { url: 'https://i.scdn.co/image/big', width: 640 }] }, trackList: [
  { uri: 'spotify:track:t1', title: 'Dreams', subtitle: 'Fleetwood Mac', duration: 257000 },
  { uri: 'spotify:track:t2', title: 'Get Lucky', subtitle: 'Daft Punk, Pharrell Williams', duration: 369000 },
  { uri: 'spotify:track:t3', title: 'Nightcall', subtitle: 'Kavinsky', duration: 258000 },
] };
const spotifyEmbedHtml = `<html><body>${script('id="__NEXT_DATA__" type="application/json"', { props: { pageProps: { state: { data: { entity: spotifyEntity } } } } })}</body></html>`;
const appleServerData = [{ data: { sections: [
  { id: 'header', items: [{ title: 'Chill Mix', artwork: {} }] },
  { id: 'track-list', itemKind: 'trackLockup', items: [
    { id: '1', title: 'Nights', subtitleLinks: [{ title: 'Frank Ocean' }], tertiaryLinks: [{ title: 'Blonde' }], duration: 307000, contentDescriptor: { identifiers: { storeAdamID: 1440935467 } } },
    { id: '2', title: 'Dreams', subtitleLinks: [{ title: 'Fleetwood Mac' }], tertiaryLinks: [{ title: 'Rumours' }], duration: 257000, contentDescriptor: { identifiers: { storeAdamID: 2 } } },
  ] },
] } }];
const appleLd = { '@type': 'MusicPlaylist', name: 'Chill Mix', author: { name: 'Apple Music' }, image: 'https://img/{w}x{h}bb.jpg', numTracks: 2 };
const applePageHtml = `<html><head><meta property="og:title" content="&#8206;Chill Mix by Apple Music on Apple Music">${script('type="application/ld+json" id="schema:music-playlist"', appleLd)}</head><body>${script('type="application/json" id="serialized-server-data"', appleServerData)}</body></html>`;
const deezerPlaylist = { id: 1234567, title: 'Late Night Drive', description: 'Synths and city lights', public: true, nb_tracks: 4, picture_medium: 'https://e-cdns-images.dzcdn.net/images/playlist/abc/250x250.jpg', link: 'https://www.deezer.com/playlist/1234567', creator: { name: 'DJ Sandbox' } };
const deezerTracks = [
  { id: 1, title: 'Blinding Lights', duration: 200, isrc: 'USUG11904206', link: 'https://www.deezer.com/track/1', artist: { name: 'The Weeknd' }, album: { title: 'After Hours' } },
  { id: 2, title: 'Midnight City', duration: 244, isrc: 'FR9W11000395', link: 'https://www.deezer.com/track/2', artist: { name: 'M83' }, album: { title: 'Hurry Up, We’re Dreaming' } },
  { id: 3, title: 'Nightcall', duration: 258, isrc: 'FR6V81017310', link: 'https://www.deezer.com/track/3', artist: { name: 'Kavinsky' }, album: { title: 'OutRun' } },
  { id: 4, title: 'A Totally Unknown Song', duration: 180, isrc: '', link: 'https://www.deezer.com/track/4', artist: { name: 'Nobody' }, album: { title: 'Nothing' } },
];
const deezerAlbum = { id: 302127, title: 'Discovery', upc: '724384960650', release_date: '2001-03-07', nb_tracks: 2, cover_medium: 'https://e-cdns-images.dzcdn.net/images/cover/x/250x250.jpg', link: 'https://www.deezer.com/album/302127', artist: { name: 'Daft Punk' }, tracks: { data: [
  { id: 11, title: 'One More Time', duration: 320, isrc: 'GBDUW0000059', artist: { name: 'Daft Punk' } },
  { id: 12, title: 'Digital Love', duration: 301, isrc: 'GBDUW0000061', artist: { name: 'Daft Punk' } },
] } };
const spotifyTrack = (id, name, artist, isrc, duration = 200000) => ({ id, uri: `spotify:track:${id}`, name, type: 'track', is_local: false, duration_ms: duration, explicit: false, external_ids: { isrc }, external_urls: { spotify: `https://open.spotify.com/track/${id}` }, artists: [{ name: artist }], album: { name: 'Album', images: [] } });
const KNOWN_ISRC = { USUG11904206: ['bl1', 'Blinding Lights', 'The Weeknd'], FR9W11000395: ['mc1', 'Midnight City', 'M83'], FR6V81017310: ['nc1', 'Nightcall', 'Kavinsky'], USRE17600016: ['dr1', 'Dreams - 2004 Remaster', 'Fleetwood Mac'], USQX91300108: ['gl1', 'Get Lucky', 'Daft Punk'] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// upstream fetch used by the worker (runs in Node)
const upstream = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://open.spotify.com/embed/')) return new Response(spotifyEmbedHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://music.apple.com/')) return new Response(applePageHtml, { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response('not found', { status: 404 });
};

// ---------- browser ----------
const browser = await puppeteer.launch({ args: [...extraArgs, '--no-sandbox'], executablePath, headless: true, defaultViewport: { width: 1280, height: 900 } });
const page = await browser.newPage();
const errors = [];
const external = new Set();
const apiCalls = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push(`[console.error] ${m.text()}`); });
await page.setRequestInterception(true);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, accept', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
const jsonRes = (req, body, status = 200) => req.respond({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
page.on('request', async (req) => {
  const url = new URL(req.url());
  const method = req.method();
  try {
    if (url.origin === new URL(base).origin) {
      if (url.pathname.endsWith('/config.js')) {
        const body = readFileSync(`${APP}/config.js`, 'utf8') + "\nwindow.TUNEBRIDGE_CONFIG.resolverUrl = 'https://resolver.test';\nwindow.TUNEBRIDGE_CONFIG.spotify.clientId = 'cid-test';\n";
        return req.respond({ status: 200, contentType: 'text/javascript', body });
      }
      return req.continue();
    }
    if (method === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    if (url.hostname === 'resolver.test') {
      const realFetch = globalThis.fetch; globalThis.fetch = upstream;
      try {
        const res = await worker.fetch(new Request(req.url(), { method, headers: { Origin: new URL(base).origin } }), { ALLOWED_ORIGINS: new URL(base).origin });
        const headers = Object.fromEntries(res.headers.entries());
        return req.respond({ status: res.status, headers, body: await res.text() });
      } finally { globalThis.fetch = realFetch; }
    }
    if (url.hostname === 'api.deezer.com') {
      const cb = url.searchParams.get('callback');
      let body;
      if (url.pathname === '/playlist/999') body = { error: { type: 'DataException', message: 'no data', code: 800 } };
      else if (url.pathname === '/playlist/1234567') body = deezerPlaylist;
      else if (url.pathname === '/playlist/1234567/tracks') body = { data: deezerTracks, total: 4 };
      else if (url.pathname === '/album/302127') body = deezerAlbum;
      else body = { error: { type: 'DataException', message: 'no data', code: 800 } };
      if (cb) return req.respond({ status: 200, contentType: 'application/javascript', body: `${cb}(${JSON.stringify(body)})` });
      return jsonRes(req, body);
    }
    if (url.hostname === 'open.spotify.com' && url.pathname === '/oembed') return jsonRes(req, { title: 'Today’s Top Hits', thumbnail_url: 'https://i.scdn.co/image/thumb', provider_name: 'Spotify' });
    if (url.hostname === 'accounts.spotify.com' && url.pathname === '/authorize') {
      const back = `${url.searchParams.get('redirect_uri')}?code=CODE123&state=${encodeURIComponent(url.searchParams.get('state') || '')}`;
      apiCalls.push(`AUTHORIZE scope=${url.searchParams.get('scope')} pkce=${url.searchParams.get('code_challenge_method')}`);
      return req.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Spotify login (mock)</title><script>location.replace(${JSON.stringify(back)})</script>` });
    }
    if (url.hostname === 'accounts.spotify.com' && url.pathname === '/api/token') {
      apiCalls.push(`TOKEN ${req.postData()}`);
      return jsonRes(req, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 'x', token_type: 'Bearer' });
    }
    if (url.hostname === 'api.spotify.com') {
      apiCalls.push(`${method} ${url.pathname}${url.search ? '?' + decodeURIComponent(url.search).slice(0, 60) : ''}`);
      const auth = req.headers().authorization;
      if (auth !== 'Bearer AT-1') return jsonRes(req, { error: { status: 401, message: 'bad token' } }, 401);
      if (url.pathname === '/v1/me') return jsonRes(req, { id: 'user1', display_name: 'Mo', images: [], external_urls: {} });
      if (url.pathname === '/v1/search') {
        const q = url.searchParams.get('q') || '';
        const isrc = (q.match(/isrc:(\w+)/) || [])[1];
        if (isrc && KNOWN_ISRC[isrc]) { const [id, name, artist] = KNOWN_ISRC[isrc]; return jsonRes(req, { tracks: { items: [spotifyTrack(id, name, artist, isrc)] } }); }
        if (isrc) return jsonRes(req, { tracks: { items: [] } });
        const m = q.match(/^track:(.+?)\s+artist:(.+)$/);
        if (m && !/unknown|obscure/i.test(m[1])) return jsonRes(req, { tracks: { items: [spotifyTrack('m' + Math.abs([...q].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)), m[1], m[2], '')] } });
        return jsonRes(req, { tracks: { items: [] }, albums: { items: [] }, artists: { items: [] } });
      }
      if (url.pathname === '/v1/me/playlists' && method === 'POST') return jsonRes(req, { id: 'new1', external_urls: { spotify: 'https://open.spotify.com/playlist/new1' } }, 201);
      if (url.pathname === '/v1/me/playlists') return jsonRes(req, { items: [], next: null });
      if (url.pathname === '/v1/playlists/new1/items') return jsonRes(req, { snapshot_id: 's1' }, 201);
      if (url.pathname === '/v1/me/library') return req.respond({ status: 200, headers: cors, body: '' });
      return jsonRes(req, {});
    }
    if (/dzcdn\.net|scdn\.co|img$/.test(url.hostname)) return req.respond({ status: 200, contentType: 'image/png', body: png });
    if (/googleapis|gstatic/.test(url.hostname)) return req.abort();
    external.add(`${method} ${url.origin}${url.pathname}`);
    return req.abort();
  } catch (error) {
    errors.push(`[mock] ${req.url()}: ${error.message}`);
    try { req.abort(); } catch (_) {}
  }
});

// ---------- helpers ----------
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : ' — ' + detail}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (n) => n.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(missing)');
const visible = (sel) => page.$eval(sel, (n) => !n.hidden && n.offsetParent !== null).catch(() => false);
const shots = process.env.E2E_SCREENSHOTS; // set to a directory to keep screenshots
const shot = (name) => (shots ? page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }) : Promise.resolve());
async function setLink(value, { paste = false } = {}) {
  await page.$eval('#link-input', (n) => { n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
  if (paste) {
    await page.evaluate((v) => {
      const input = document.querySelector('#link-input'); input.focus();
      const dt = new DataTransfer(); dt.setData('text/plain', v);
      const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      input.dispatchEvent(evt);
      if (!evt.defaultPrevented) document.execCommand('insertText', false, v);
    }, value);
  } else await page.type('#link-input', value);
  await wait(250);
}
const barState = () => page.$eval('#link-form', (n) => ({ platform: n.dataset.platform, icon: n.querySelector('#link-icon').dataset.platform, on: [...document.querySelectorAll('.dock-item.is-on')].map((d) => d.dataset.platform).join(','), hint: document.querySelector('#link-hint').textContent.trim(), hintClass: document.querySelector('#link-hint').className, go: document.querySelector('#link-go').disabled }));

// ================= 1. home =================
console.log('\n1. Home');
await page.goto(base, { waitUntil: 'networkidle0' });
check('no JS errors on load', errors.length === 0, errors.join(' | '));
check('6 dock tiles', (await page.$$('#platform-dock .dock-item')).length === 6);
check('footer', (await text('.page-footer')) === '© Developed with ❤️ by momalekiii');
check('hidden steps hidden', !(await visible('#step-preview')) && !(await visible('#step-destination')) && !(await visible('#step-transfer')) && !(await visible('#step-results')));
check('no dev controls visible', !(await visible('#demo-badge')) && !(await page.$('#settings-button')));

// ================= 2. link bar matrix =================
console.log('\n2. Link bar — every platform');
const matrix = [
  ['spotify', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'],
  ['apple', 'https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb'],
  ['youtube', 'https://music.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI&si=x'],
  ['soundcloud', 'https://soundcloud.com/user-123/sets/my-set?si=abc'],
  ['tidal', 'https://tidal.com/browse/playlist/1b418bb8-90a7-4f87-901d-707993838346'],
  ['deezer', 'https://www.deezer.com/us/playlist/1234567'],
];
for (const [platform, link] of matrix) {
  await setLink(link);
  const s = await barState();
  check(`${platform}: bar + icon + dock + hint`, s.platform === platform && s.icon === platform && s.on === platform && /recognised/.test(s.hint) && !/is-error/.test(s.hintClass) && !s.go, JSON.stringify(s));
  if (platform === 'tidal') await shot('2-tidal-typed');
}
await setLink('https://spotify.link/AbCdEfGhIj');
check('short link recognised (resolver on)', (await barState()).platform === 'spotify' && /recognised|link/.test((await barState()).hint));
await setLink('https://music.youtube.com/playlist?list=WL');
check('private YouTube list explained', /private|Watch Later|your own/i.test((await barState()).hint) && (await barState()).platform === 'youtube');
await setLink('https://example.com/whatever');
check('unknown site explained', /understands/.test((await barState()).hint) && (await barState()).platform === '');
await setLink('Listen on Spotify: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x.');
check('link inside share text', (await barState()).platform === 'spotify');
await setLink('open.spo');
check('partial input: no throw, neutral hint', !/is-error/.test((await barState()).hintClass) && errors.length === 0, errors.join(' | '));
await page.click('#link-clear');
check('clear resets bar', (await barState()).platform === '' && (await page.$eval('#link-input', (n) => n.value)) === '');
await page.click('.dock-item[data-platform="soundcloud"]');
await wait(200);
check('dock tap arms placeholder', /SoundCloud/.test(await page.$eval('#link-input', (n) => n.placeholder)) && (await page.$eval('#link-form', (n) => n.dataset.armed)) === 'soundcloud');
await page.click('.dock-item[data-platform="soundcloud"]');

// ================= 3. Deezer paste → preview =================
console.log('\n3. Deezer paste → preview');
await setLink('https://www.deezer.com/en/playlist/1234567?utm_source=share', { paste: true });
await page.waitForSelector('.playlist-card', { timeout: 8000 }).catch(() => {});
await wait(300);
check('auto-preview after paste', await visible('#step-preview') && (await text('.playlist-card h3')) === 'Late Night Drive');
check('4 tracks listed with artists', (await page.$$('.track-list li')).length === 4 && /The Weeknd/.test(await text('.track-list')));
check('hint says imported', /Imported below/.test(await text('#link-hint')));
check('destination step visible, no panel yet', await visible('#step-destination') && !(await visible('#destination-panel')));
await shot('3-deezer-preview');
// Enter key submits
await setLink('https://www.deezer.com/album/302127');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /Discovery/.test(document.querySelector('#preview')?.textContent || ''), { timeout: 8000 }).catch(() => {});
check('Enter previews a Deezer album (a new link replaces the previous one)', /Discovery/.test(await text('#preview')) && !/Late Night Drive/.test(await text('#preview')) && /saved to your library/.test(await text('#preview')));
check('album card lists its songs', /One More Time/.test(await text('#preview')) && (await page.$$('#preview .playlist-card, #preview .item')).length >= 1);
// private playlist
await setLink('https://www.deezer.com/playlist/999');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /isn’t public|not public/i.test(document.querySelector('#preview')?.textContent || ''), { timeout: 8000 }).catch(() => {});
check('private Deezer playlist explained', /isn’t public/i.test(await text('#preview')), (await text('#preview')).slice(0, 160));

// ================= 4. resolver-backed links =================
console.log('\n4. Resolver (worker code) — Spotify + Apple links');
await setLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc', { paste: true });
await page.waitForFunction(() => /Today’s Top Hits/.test(document.querySelector('#preview')?.textContent || ''), { timeout: 10000 }).catch(() => {});
check('Spotify playlist via worker', /Today’s Top Hits/.test(await text('#preview')) && /Fleetwood Mac/.test(await text('#preview')), (await text('#preview')).slice(0, 200));
check('truncation note shown (first 3 of 50)', /first 3 of 50/i.test(await text('#preview')), (await text('.preview-notes')).slice(0, 160));
await setLink('https://music.apple.com/us/playlist/chill-mix/pl.f4d106fed2bd41149aaacabb233eb5eb', { paste: true });
await page.waitForFunction(() => /Chill Mix/.test(document.querySelector('#preview')?.textContent || ''), { timeout: 10000 }).catch(() => {});
check('Apple Music playlist via worker', /Chill Mix/.test(await text('#preview')) && /Frank Ocean/.test(await text('#preview')));
await shot('4-multi-preview');

// ================= 5. files =================
console.log('\n5. File import');
const fileInput = await page.$('#file-input');
await fileInput.uploadFile(`${FIX}/exportify.csv`, `${FIX}/Playlist1.json`, `${FIX}/gym.m3u`, `${FIX}/Library.xml`);
await page.waitForFunction(() => /Sunday Chill/.test(document.querySelector('#preview')?.textContent || ''), { timeout: 10000 }).catch(() => {});
const previewText = await text('#preview');
check('CSV parsed (exportify)', /exportify/.test(previewText));
check('Spotify export JSON parsed', /Road Trip/.test(previewText));
check('M3U parsed', /gym/.test(previewText));
check('Apple XML parsed', /Sunday Chill/.test(previewText));
await page.click('#preview .item input[type=checkbox] + .checkbox, #preview .item .checkbox');
await wait(200);
check('unticking a row works', !(await page.$eval('#preview .item input[type=checkbox]', (n) => n.checked)));
await page.click('#preview .item .checkbox');
await wait(200);
check('re-ticking works', await page.$eval('#preview .item input[type=checkbox]', (n) => n.checked));

// ================= 6. destination + OAuth round-trip =================
console.log('\n6. Destination + Spotify login round-trip');
await page.click('#destination-grid .service-button[data-service="spotify"]');
await wait(400);
check('panel + CTA for Spotify', await visible('#destination-panel') && /Log in with Spotify & transfer/.test(await text('#transfer-button')) && !(await page.$eval('#transfer-button', (n) => n.disabled)), `${await text('#transfer-button')} disabled=${await page.$eval('#transfer-button', (n) => n.disabled)} note=${await text('#cta-note')}`);
check('summary chips count playlists + songs', /5 ?playlists/.test(await text('#transfer-summary')) && /songs to match/.test(await text('#transfer-summary')), await text('#transfer-summary'));
await shot('6-destination');
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
  page.click('#transfer-button'),
]);
// after the mock login we are back on the app with ?code=…; boot() finishes the login and resumes the transfer
await page.waitForSelector('#step-results:not([hidden])', { timeout: 60000 }).catch(() => {});
await wait(500);
check('came back to the app (code consumed from URL)', page.url().startsWith(base) && !page.url().includes('code='), page.url());
check('authorize used PKCE', apiCalls.some((c) => /AUTHORIZE .*pkce=S256/.test(c)), apiCalls.filter((c) => c.startsWith('AUTHORIZE')).join());
check('token exchanged with code + verifier', apiCalls.some((c) => /TOKEN .*code=CODE123.*code_verifier=/.test(c) || /TOKEN .*code_verifier=.*code=CODE123/.test(c)), apiCalls.filter((c) => c.startsWith('TOKEN')).join());
check('transfer auto-resumed → results', await visible('#step-results'), await text('#step-results'));
const created = apiCalls.filter((c) => c === 'POST /v1/me/playlists').length;
check('5 playlists created on Spotify (Apple link + CSV + JSON + M3U + XML)', created === 5, `created=${created}`);
check('tracks added via /playlists/{id}/items', apiCalls.some((c) => c.startsWith('POST /v1/playlists/new1/items')));
check('ISRC search used for matching (CSV ISRCs)', apiCalls.some((c) => /GET \/v1\/search\?\??q=isrc:/.test(c)), apiCalls.filter((c) => /search/.test(c)).slice(0, 3).join());
check('results: some songs matched, some not found', /not found/.test(await text('#results-panel')) && /songs matched/.test(await text('#results-panel')), (await text('#results-panel')).slice(0, 200));
check('results mention Spotify', /Spotify/.test(await text('#results-copy')), await text('#results-copy'));
check('missing songs listed + CSV button', /not found/.test(await text('#results-panel')) && await visible('#download-missing'));
check('token stored', await page.evaluate(() => Boolean(localStorage.getItem('tunebridge.token.spotify'))));
check('pending transfer cleared', await page.evaluate(() => !sessionStorage.getItem('tunebridge.pendingTransfer.v1') && !localStorage.getItem('tunebridge.pendingTransfer.v1') && !localStorage.getItem('tunebridge.pendingAuth')));
check('no JS errors through login + transfer', errors.length === 0, errors.join(' | '));
await shot('6-results');

// ================= 7. after: send elsewhere, sign out, start over =================
console.log('\n7. Follow-ups');
await page.click('#transfer-more');
await wait(400);
check('send elsewhere → destination step, results hidden', await visible('#step-destination') && !(await visible('#step-results')));
await page.click('#destination-grid .service-button[data-service="spotify"]');
await wait(300);
check('logged-in status shows name', /Logged in to Spotify as Mo/.test(await text('#destination-status, .destination-status')) || /as Mo/.test(await text('#transfer-summary')), await text('#transfer-summary'));
check('CTA now "Transfer to Spotify"', /^Transfer to Spotify/.test(await text('#transfer-button')));
await page.click('#destination-grid .service-button[data-service="deezer"]');
await wait(300);
check('unconfigured destination: CTA disabled + friendly note', (await page.$eval('#transfer-button', (n) => n.disabled)) && /aren’t switched on/.test(await text('#cta-note')));
await page.click('#destination-grid .service-button[data-service="spotify"]');
await wait(300);
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Sign out/.test(b.textContent))?.click());
await wait(300);
check('sign out clears token', await page.evaluate(() => !localStorage.getItem('tunebridge.token.spotify')) && /Log in with Spotify/.test(await text('#transfer-button')));
await page.evaluate(() => [...document.querySelectorAll('#preview button')].find((b) => b.textContent.trim() === 'Clear')?.click());
await wait(600);
check('Clear (start over) resets everything', !(await visible('#step-preview')) && (await page.$eval('#link-input', (n) => n.value)) === '' && (await barState()).platform === '');
await page.reload({ waitUntil: 'networkidle0' });
check('library stays empty after reload', !(await visible('#step-preview')));

// ================= 8. dialogs, sample mode, owner settings =================
console.log('\n8. Dialogs, sample mode, owner settings');
await page.click('#about-button');
await wait(200);
check('About opens with capability table', await page.$eval('#about-dialog', (d) => d.open) && (await page.$$('#caps-table tbody tr')).length === 7);
await page.keyboard.press('Escape');
await wait(200);
check('Escape closes About', !(await page.$eval('#about-dialog', (d) => d.open)));
await page.click('#file-help-button');
await wait(200);
check('file help opens', await page.$eval('#import-help-dialog', (d) => d.open));
await page.evaluate(() => document.querySelector('#import-help-dialog [data-close]')?.click());
await wait(200);
check('close button closes file help', !(await page.$eval('#import-help-dialog', (d) => d.open)));
await page.evaluate(() => { location.hash = '#demo'; });
await wait(400);
check('#demo shows sample badge', await visible('#demo-badge'));
await page.click('#demo-badge');
await wait(300);
check('badge click leaves sample mode', !(await visible('#demo-badge')));
await page.evaluate(() => { location.hash = '#setup'; });
await wait(400);
check('#setup opens owner settings', await page.$eval('#settings-dialog', (d) => d.open));
await page.type('#settings-form [name="deezer.appId"]', '424242');
await page.evaluate(() => document.querySelector('#settings-form').requestSubmit());
await wait(400);
check('settings saved to this browser', await page.evaluate(() => JSON.parse(localStorage.getItem('tunebridge.settings.v1') || '{}')?.deezer?.appId === '424242'));
await page.evaluate(() => { location.hash = ''; });
await setLink('https://www.deezer.com/en/playlist/1234567', { paste: true });
await page.waitForSelector('.playlist-card', { timeout: 8000 }).catch(() => {});
await page.click('#destination-grid .service-button[data-service="deezer"]');
await wait(300);
check('Deezer destination now configured (CTA enabled)', !(await page.$eval('#transfer-button', (n) => n.disabled)) && /Log in with Deezer/.test(await text('#transfer-button')));
await page.evaluate(() => localStorage.removeItem('tunebridge.settings.v1'));

// ================= 9. mobile =================
console.log('\n9. Mobile');
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.reload({ waitUntil: 'networkidle0' });
await wait(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal overflow on mobile', overflow <= 0, `overflow=${overflow}px`);
await shot('9-mobile-preview');
await page.click('#destination-grid .service-button[data-service="apple"]');
await wait(300);
await shot('9-mobile-destination');

console.log(`\nAPI calls seen: ${apiCalls.length}`);
console.log(`Unmocked external requests: ${external.size ? [...external].join(', ') : 'none'}`);
console.log(`JS errors: ${errors.length ? errors.join('\n') : 'none'}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — FAILED: ' + failed.map((f) => f.name).join('; ') : ''}`);
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
