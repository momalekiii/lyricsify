// The helper worker (proxy/cloudflare-worker.js): page/API parsers and the HTTP router, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { classifyLink, parseSpotifyEmbed, parseAppleMusicPage, parseYouTubePlaylistPage, cleanVideoTitle, soundcloudTrack, tidalTracksFromJsonApi, isoDurationToMs, resolveLink } from '../proxy/cloudflare-worker.js';

const script = (attrs, data) => `<script ${attrs}>${JSON.stringify(data)}</script>`;

test('worker classifier agrees with the browser classifier on the important shapes', () => {
  assert.equal(classifyLink('https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1').id, '37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(classifyLink('https://music.apple.com/us/playlist/x/pl.abc').type, 'playlist');
  assert.equal(classifyLink('https://www.youtube.com/playlist?list=PL1').type, 'playlist');
  assert.equal(classifyLink('https://soundcloud.com/u/sets/s').type, 'playlist');
  assert.equal(classifyLink('https://tidal.com/browse/album/1').type, 'album');
  assert.equal(classifyLink('https://deezer.page.link/x').type, 'short');
  assert.equal(isoDurationToMs('PT3M20S'), 200000);
  assert.equal(isoDurationToMs(213), 213000, 'bare seconds');
  assert.equal(isoDurationToMs(213000), 213000, 'bare milliseconds');
});

test('Spotify embed page → playlist with tracks (and a note when truncated)', () => {
  const entity = { type: 'playlist', id: 'p1', uri: 'spotify:playlist:p1', name: 'Top Hits', subtitle: 'Spotify', trackCount: 150, coverArt: { sources: [{ url: 'small', width: 300 }, { url: 'big', width: 640 }] }, trackList: [
    { uri: 'spotify:track:t1', title: 'Dreams', subtitle: 'Fleetwood Mac', duration: 257000 },
    { uri: 'spotify:track:t2', title: 'Get Lucky', subtitle: 'Daft Punk, Pharrell Williams', duration: 369000 },
  ] };
  const html = `<html><body>${script('id="__NEXT_DATA__" type="application/json"', { props: { pageProps: { state: { data: { entity } } } } })}</body></html>`;
  const result = parseSpotifyEmbed(html);
  const playlist = result.playlists[0];
  assert.equal(playlist.name, 'Top Hits');
  assert.equal(playlist.image, 'big');
  assert.equal(playlist.owner, 'Spotify');
  assert.deepEqual(playlist.tracks[1], { id: 'spotify:track:t2', title: 'Get Lucky', artists: ['Daft Punk', 'Pharrell Williams'], album: '', durationMs: 369000, isrc: '', url: 'https://open.spotify.com/track/t2' });
  assert.match(result.notes[0], /first 2 of 150/);
  // layout drift: no __NEXT_DATA__, but some JSON blob still carries a trackList
  const drifted = `<html>${script('type="application/json" id="whatever"', { a: { b: { entity: { ...entity, trackCount: 2 } } } })}</html>`;
  assert.equal(parseSpotifyEmbed(drifted).playlists[0].tracks.length, 2);
  assert.throws(() => parseSpotifyEmbed('<html>nothing</html>'), /parse_failed|did not contain/);
  // albums
  const album = parseSpotifyEmbed(`<html>${script('id="__NEXT_DATA__" type="application/json"', { props: { pageProps: { state: { data: { entity: { ...entity, type: 'album', subtitle: 'Fleetwood Mac', releaseDate: { isoString: '1977-02-04T00:00:00Z' }, trackCount: 2 } } } } } })}</html>`);
  assert.equal(album.albums[0].artists[0], 'Fleetwood Mac');
  assert.equal(album.albums[0].year, '1977');
  assert.equal(album.albums[0].tracks[0].album, 'Top Hits');
});

test('Apple Music page → tracks from serialized-server-data, falling back to JSON-LD and og: tags', () => {
  const serverData = [{ data: { sections: [
    { id: 'header', items: [{ title: 'Chill Mix', artwork: {} }] },
    { id: 'track-list', itemKind: 'trackLockup', items: [
      { id: '1', title: 'Nights', subtitleLinks: [{ title: 'Frank Ocean' }], tertiaryLinks: [{ title: 'Blonde' }], duration: 307000, contentDescriptor: { identifiers: { storeAdamID: 1440935467 }, url: 'https://music.apple.com/us/album/nights/1440935467' } },
      { id: '2', title: 'Dreams', subtitleLinks: [{ title: 'Fleetwood Mac' }], tertiaryLinks: [{ title: 'Rumours' }], duration: 257, contentDescriptor: { identifiers: { storeAdamID: 2 } } },
      { id: '2', title: 'Dreams', subtitleLinks: [{ title: 'Fleetwood Mac' }], duration: 257, contentDescriptor: { identifiers: { storeAdamID: 2 } } },
    ] },
  ] } }];
  const ld = { '@type': 'MusicPlaylist', name: 'Chill Mix', author: { name: 'Apple Music' }, image: 'https://img/{w}x{h}bb.jpg', numTracks: 3, track: [{ '@type': 'MusicRecording', name: 'Nights' }] };
  const html = `<html><head><meta property="og:title" content="&#8206;Chill Mix by Apple Music on Apple Music"><meta property="og:image" content="https://img/1200x630cw.png">${script('type="application/ld+json" id="schema:music-playlist"', ld)}</head><body>${script('type="application/json" id="serialized-server-data"', serverData)}</body></html>`;
  const result = parseAppleMusicPage(html, { type: 'playlist', id: 'pl.1', url: 'https://music.apple.com/us/playlist/playlist/pl.1' });
  const playlist = result.playlists[0];
  assert.equal(playlist.name, 'Chill Mix');
  assert.equal(playlist.owner, 'Apple Music');
  assert.equal(playlist.image, 'https://img/600x600bb.jpg');
  assert.equal(playlist.tracks.length, 2, 'deduplicated');
  assert.deepEqual(playlist.tracks[0], { id: 'apple:1440935467', title: 'Nights', artists: ['Frank Ocean'], album: 'Blonde', durationMs: 307000, isrc: '', url: 'https://music.apple.com/us/album/nights/1440935467' });
  assert.equal(playlist.tracks[1].durationMs, 257000, 'seconds are normalised');
  assert.match(result.notes.join(' '), /first 2 of 3/);

  const onlyLd = `<html><head><meta property="og:title" content="Chill Mix - Playlist - Apple Music">${script('type="application/ld+json"', { ...ld, numTracks: 1, track: [{ '@type': 'MusicRecording', name: 'Nights', byArtist: { name: 'Frank Ocean' }, url: 'u' }] })}</head></html>`;
  const fallback = parseAppleMusicPage(onlyLd, { type: 'playlist', id: 'pl.1' });
  assert.deepEqual(fallback.playlists[0].tracks.map((t) => [t.title, t.artists]), [['Nights', ['Frank Ocean']]]);
  assert.throws(() => parseAppleMusicPage('<html></html>', { type: 'playlist' }), /parse_failed|did not contain/);

  const albumHtml = `<html><head><meta property="og:title" content="&#8206;Rumours - Album by Fleetwood Mac - Apple Music">${script('type="application/ld+json"', { '@type': 'MusicAlbum', name: 'Rumours', byArtist: { name: 'Fleetwood Mac' }, datePublished: '1977-02-04', track: [{ name: 'Dreams' }, { name: 'Go Your Own Way' }] })}</head></html>`;
  const album = parseAppleMusicPage(albumHtml, { type: 'album', id: '594061854', url: 'x' });
  assert.equal(album.albums[0].title, 'Rumours');
  assert.deepEqual(album.albums[0].artists, ['Fleetwood Mac']);
  assert.deepEqual(album.albums[0].tracks.map((t) => t.artists), [['Fleetwood Mac'], ['Fleetwood Mac']], 'album artist fills in for tracks');
});

test('YouTube public playlist page → tracks from ytInitialData with cleaned titles', () => {
  const data = { metadata: { playlistMetadataRenderer: { title: 'Workout' } }, contents: [{ playlistVideoRenderer: { videoId: 'a1', title: { runs: [{ text: 'Fleetwood Mac - Dreams (Official Music Video)' }] }, shortBylineText: { runs: [{ text: 'FleetwoodMacVEVO' }] }, lengthSeconds: '257' } }, { playlistVideoRenderer: { videoId: 'a2', title: { runs: [{ text: 'Nights' }] }, shortBylineText: { runs: [{ text: 'Frank Ocean - Topic' }] }, lengthSeconds: '307' } }, { playlistVideoRenderer: { videoId: 'a3', title: { simpleText: '[Private video]' } } }] };
  const html = `<html><head><meta property="og:image" content="thumb"></head><body><script nonce="x">var ytInitialData = ${JSON.stringify(data)};</script></body></html>`;
  const result = parseYouTubePlaylistPage(html, { id: 'PL1', url: 'https://www.youtube.com/playlist?list=PL1' });
  assert.equal(result.playlists[0].name, 'Workout');
  assert.deepEqual(result.playlists[0].tracks.map((t) => [t.title, t.artists, t.durationMs]), [['Dreams', ['Fleetwood Mac'], 257000], ['Nights', ['Frank Ocean'], 307000]]);
  assert.deepEqual(cleanVideoTitle('Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen Official'), { title: 'Bohemian Rhapsody', artists: ['Queen'] });
});

test('SoundCloud and TIDAL payloads → normalised tracks', () => {
  assert.deepEqual(soundcloudTrack({ id: 9, title: 'Some Artist - Some Song', duration: 200000, user: { username: 'uploader' }, permalink_url: 'p', publisher_metadata: { isrc: 'QZ-ABC-21-00001' } }), { id: 'soundcloud:9', title: 'Some Song', artists: ['Some Artist'], album: '', durationMs: 200000, isrc: 'QZABC2100001', url: 'p' });
  assert.deepEqual(soundcloudTrack({ id: 10, title: 'Untitled Jam', duration: 1000, user: { username: 'uploader' }, publisher_metadata: { artist: 'Real Name', release_title: 'EP' } }).artists, ['Real Name']);
  assert.equal(soundcloudTrack({ id: 11, title: 'Loose Track', user: { username: 'uploader' } }).artists[0], 'uploader');

  const included = [
    { id: 't1', type: 'tracks', attributes: { title: 'Dreams', isrc: 'GBAYE0601498', duration: 'PT4M17S' }, relationships: { artists: { data: [{ id: 'a1', type: 'artists' }] }, albums: { data: [{ id: 'al1', type: 'albums' }] } } },
    { id: 'a1', type: 'artists', attributes: { name: 'Fleetwood Mac' } },
    { id: 'al1', type: 'albums', attributes: { title: 'Rumours' } },
  ];
  assert.deepEqual(tidalTracksFromJsonApi([{ id: 't1', type: 'tracks' }], included).map(({ _id, ...t }) => t), [{ id: 'tidal:t1', title: 'Dreams', artists: ['Fleetwood Mac'], album: 'Rumours', durationMs: 257000, isrc: 'GBAYE0601498', url: 'https://tidal.com/browse/track/t1' }]);
});

test('router: CORS, caching headers, error envelope, short-link expansion, token endpoint', async () => {
  const entity = { type: 'playlist', id: 'p1', uri: 'spotify:playlist:p1', name: 'Hits', subtitle: 'Spotify', trackList: [{ uri: 'spotify:track:t1', title: 'Dreams', subtitle: 'Fleetwood Mac', duration: 1000 }] };
  const embed = `<html>${script('id="__NEXT_DATA__" type="application/json"', { props: { pageProps: { state: { data: { entity } } } } })}</html>`;
  const fetches = [];
  globalThis.fetch = async (url, init = {}) => {
    fetches.push([String(url), init.method || 'GET']);
    if (String(url).startsWith('https://spotify.link/')) return { ok: true, status: 200, url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1', text: async () => '<html></html>' };
    if (String(url).startsWith('https://open.spotify.com/embed/playlist/')) return new Response(embed, { status: 200 });
    if (String(url).startsWith('https://secure.soundcloud.com/oauth/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const env = { ALLOWED_ORIGINS: 'https://momalekiii.github.io', SOUNDCLOUD_CLIENT_ID: 'id', SOUNDCLOUD_CLIENT_SECRET: 'secret' };
  const call = (path, init = {}) => worker.fetch(new Request(`https://helper.test${path}`, { headers: { Origin: 'https://momalekiii.github.io', ...(init.headers || {}) }, ...init }), env, { waitUntil() {} });

  const ok = await call(`/resolve?url=${encodeURIComponent('https://spotify.link/abc')}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://momalekiii.github.io');
  assert.match(ok.headers.get('Cache-Control'), /max-age=600/);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.platform, 'spotify');
  assert.equal(body.result.playlists[0].tracks[0].title, 'Dreams');
  assert.ok(fetches.some(([u]) => u.startsWith('https://spotify.link/')) && fetches.some(([u]) => u.includes('/embed/playlist/37i9dQZF1DXcBWIGoYBM5M')), 'short link expanded, then embed fetched');

  const unsupported = await call(`/resolve?url=${encodeURIComponent('https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M')}`);
  assert.equal(unsupported.status, 400);
  assert.deepEqual((await unsupported.json()).error, 'unsupported');

  const notConfigured = await call(`/resolve?url=${encodeURIComponent('https://tidal.com/browse/playlist/1b418bb8-90a7-4f87-901d-707993838346')}`);
  assert.equal((await notConfigured.json()).error, 'not_configured');

  const forbidden = await worker.fetch(new Request('https://helper.test/resolve?url=x', { headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(forbidden.status, 403);

  const preflight = await call('/resolve', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /GET/);

  const token = await call('/token', { method: 'POST', body: JSON.stringify({ provider: 'soundcloud', grant_type: 'authorization_code', code: 'c', redirect_uri: 'r', code_verifier: 'v' }) });
  assert.equal(token.status, 200);
  assert.deepEqual(await token.json(), { access_token: 'tok', expires_in: 3600 });
  const tokenCall = fetches.find(([u, m]) => u.startsWith('https://secure.soundcloud.com') && m === 'POST');
  assert.ok(tokenCall, 'secret added server-side');

  const index = await call('/');
  assert.deepEqual((await index.json()).links, { spotify: true, apple: true, youtube: true, soundcloud: true, tidal: false, deezer: true });
  await assert.rejects(() => resolveLink('https://example.com/nothing', env), /unsupported|not a music link/);
});
