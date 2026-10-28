// Exercises the real Spotify / YouTube / Deezer adapters against mocked HTTP responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyProvider } from '../js/providers/spotify.js';
import { YouTubeMusicProvider, quota } from '../js/providers/youtube.js';
import { DeezerProvider } from '../js/providers/deezer.js';
import { tokens } from '../js/oauth.js';
import { runTransfer } from '../js/transfer.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    if (init.body) {
      try { body = JSON.parse(init.body); } catch (_) { body = String(init.body); }
    }
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers });
    for (const [matcher, handler] of routes) {
      if (typeof matcher === 'string' ? url.startsWith(matcher) : matcher.test(url)) return handler(new URL(url), init, calls);
    }
    return json({ error: { message: `no route for ${url}` } }, 404);
  };
  return calls;
}

const spotifyTrack = (id, name, artist, isrc, duration = 200000) => ({ id, uri: `spotify:track:${id}`, name, type: 'track', is_local: false, duration_ms: duration, explicit: false, external_ids: { isrc }, external_urls: { spotify: `https://open.spotify.com/track/${id}` }, artists: [{ name: artist }], album: { name: 'Album', images: [] } });

test('Spotify adapter (Feb-2026 API): pagination, liked songs, ISRC matching, batching, /me/library', async () => {
  tokens.set('spotify', { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600e3 });
  const calls = mockFetch([
    ['https://api.spotify.com/v1/me/playlists', (url, init) => {
      if (init.method === 'POST') return json({ id: 'new1', external_urls: { spotify: 'https://open.spotify.com/playlist/new1' } }, 201);
      const offset = Number(url.searchParams.get('offset') || 0);
      if (offset === 0) return json({ items: [{ id: 'p1', name: 'Road trip', description: '', items: { total: 2 }, images: [], external_urls: { spotify: 'x' }, owner: { display_name: 'Me' }, public: true }], next: 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50' });
      return json({ items: [{ id: 'p2', name: 'Second page', items: { total: 0 }, images: [], owner: {} }], next: null });
    }],
    ['https://api.spotify.com/v1/playlists/p1/items', (url) => {
      assert.match(url.searchParams.get('fields'), /items\(item\(.*external_ids\(isrc\)/);
      return json({ items: [{ item: spotifyTrack('t1', 'Dreams', 'Fleetwood Mac', 'USRE17600016') }, { item: { type: 'episode', id: 'e1' } }, { item: null }, { item: { ...spotifyTrack('t3', 'Local', 'Me', ''), is_local: true } }], next: null });
    }],
    ['https://api.spotify.com/v1/me/tracks', () => json({ items: [{ track: spotifyTrack('t9', 'Liked', 'Someone', 'XX') }], next: null })],
    ['https://api.spotify.com/v1/me/library', (url, init) => {
      assert.equal(init.method, 'PUT');
      assert.ok(url.searchParams.get('uris').split(',').length <= 40, 'at most 40 URIs per /me/library call');
      return new Response(null, { status: 200 });
    }],
    ['https://api.spotify.com/v1/me', () => json({ id: 'user1', display_name: 'User', images: [], external_urls: {} })], // no `country` since 2026
    ['https://api.spotify.com/v1/search', (url) => {
      assert.ok(Number(url.searchParams.get('limit')) <= 10, 'search limit capped at 10');
      const q = url.searchParams.get('q');
      if (q.startsWith('isrc:')) return json({ tracks: { items: [spotifyTrack('match1', 'Dreams - 2004 Remaster', 'Fleetwood Mac', 'USRE17600016')] } });
      return json({ tracks: { items: [] } });
    }],
    ['https://api.spotify.com/v1/playlists/new1/items', () => json({ snapshot_id: 's' }, 201)],
  ]);
  const spotify = new SpotifyProvider({ clientId: 'cid' });
  const playlists = await spotify.listPlaylists();
  assert.deepEqual(playlists.map((p) => p.id), ['__spotify_liked__', 'p1', 'p2']);
  assert.equal(playlists[1].trackCount, 2, 'reads the renamed items.total field');
  const tracks = await spotify.getPlaylistTracks(playlists[1]);
  assert.equal(tracks.length, 1, 'episodes, nulls and local files are skipped');
  assert.equal(tracks[0].isrc, 'USRE17600016');
  const liked = await spotify.getPlaylistTracks(playlists[0]);
  assert.equal(liked[0].id, 't9');
  const match = await spotify.findTrack({ title: 'Dreams', artists: ['Fleetwood Mac'], isrc: 'USRE17600016', durationMs: 257800 });
  assert.equal(match.id, 'match1');
  assert.equal(match.score, 1);
  const created = await spotify.createPlaylist({ name: 'Road trip', description: 'd', isPublic: false });
  assert.equal(created.id, 'new1');
  assert.ok(calls.some((c) => c.url === 'https://api.spotify.com/v1/me/playlists' && c.method === 'POST'), 'creates via POST /me/playlists');
  const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
  await spotify.addTracks('new1', ids);
  const addCalls = calls.filter((c) => c.url.includes('/playlists/new1/items'));
  assert.equal(addCalls.length, 2, 'adds are batched by 100');
  assert.equal(addCalls[0].body.uris.length, 100);
  assert.equal(addCalls[0].body.uris[0], 'spotify:track:id0');
  assert.equal(addCalls[0].headers.Authorization, 'Bearer AT');
  await spotify.saveAlbums(Array.from({ length: 45 }, (_, i) => `al${i}`));
  await spotify.followArtists(['ar1', 'ar2']);
  const libraryCalls = calls.filter((c) => c.url.startsWith('https://api.spotify.com/v1/me/library'));
  assert.equal(libraryCalls.length, 3, '45 albums → 2 calls of ≤40 URIs, artists → 1 call');
  assert.match(libraryCalls[0].url, /uris=spotify%3Aalbum%3Aal0/);
  assert.match(libraryCalls[2].url, /uris=spotify%3Aartist%3Aar1/);
  tokens.clear('spotify');
});

test('Spotify adapter: legacy endpoints for extended-quota/grandfathered apps, and owner-only playlists', async () => {
  tokens.set('spotify', { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600e3 });
  const gone = () => json({ error: { status: 404, message: 'Service not found' } }, 404);
  const calls = mockFetch([
    ['https://api.spotify.com/v1/playlists/p1/items', gone],
    ['https://api.spotify.com/v1/playlists/p1/tracks', () => json({ items: [{ track: spotifyTrack('t1', 'Dreams', 'Fleetwood Mac', 'USRE17600016') }], next: null })],
    [/\/v1\/playlists\/theirs\/(items|tracks)/, () => json({ error: { status: 403, message: 'Forbidden' } }, 403)],
    ['https://api.spotify.com/v1/me/playlists', (url, init) => (init.method === 'POST' ? gone() : json({ items: [], next: null }))],
    ['https://api.spotify.com/v1/users/user1/playlists', () => json({ id: 'new1', external_urls: {} }, 201)],
    ['https://api.spotify.com/v1/playlists/new1/items', gone],
    ['https://api.spotify.com/v1/playlists/new1/tracks', () => json({ snapshot_id: 's' }, 201)],
    ['https://api.spotify.com/v1/me/library', gone],
    ['https://api.spotify.com/v1/me/albums', () => new Response(null, { status: 200 })],
    ['https://api.spotify.com/v1/me/following', () => new Response(null, { status: 204 })],
    ['https://api.spotify.com/v1/me', () => json({ id: 'user1', display_name: 'User', country: 'US' })],
  ]);
  const spotify = new SpotifyProvider({ clientId: 'cid' });
  const tracks = await spotify.getPlaylistTracks({ id: 'p1', name: 'Road trip' });
  assert.equal(tracks.length, 1, 'falls back to /tracks when /items is unavailable');
  const created = await spotify.createPlaylist({ name: 'x', description: '', isPublic: false });
  assert.equal(created.id, 'new1');
  await spotify.addTracks('new1', Array.from({ length: 150 }, (_, i) => `id${i}`));
  assert.equal(calls.filter((c) => c.url.includes('/playlists/new1/items')).length, 1, 'legacy endpoint is remembered after the first 404');
  assert.equal(calls.filter((c) => c.url.includes('/playlists/new1/tracks')).length, 2);
  await spotify.saveAlbums(['al1']);
  await spotify.followArtists(['ar1']);
  assert.ok(calls.some((c) => c.url.startsWith('https://api.spotify.com/v1/me/albums') && c.method === 'PUT'));
  assert.ok(calls.some((c) => c.url.startsWith('https://api.spotify.com/v1/me/following?type=artist&ids=ar1') && c.method === 'PUT'));
  await assert.rejects(() => spotify.getPlaylistTracks({ id: 'theirs', name: 'Their mix' }), /playlists you own or collaborate on/);
  tokens.clear('spotify');
});

test('Spotify adapter refreshes an expired token before calling the API', async () => {
  tokens.set('spotify', { accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() - 1000 });
  const calls = mockFetch([
    ['https://accounts.spotify.com/api/token', (url, init) => {
      assert.match(init.body, /grant_type=refresh_token/);
      return json({ access_token: 'NEW', expires_in: 3600 });
    }],
    ['https://api.spotify.com/v1/me', (url, init) => (init.headers.Authorization === 'Bearer NEW' ? json({ id: 'u', display_name: 'U' }) : json({ error: { status: 401, message: 'expired' } }, 401))],
  ]);
  const spotify = new SpotifyProvider({ clientId: 'cid' });
  const profile = await spotify.getProfile();
  assert.equal(profile.id, 'u');
  assert.equal(tokens.get('spotify').accessToken, 'NEW');
  assert.equal(tokens.get('spotify').refreshToken, 'RT', 'refresh token is kept when Spotify omits it');
  assert.equal(calls[0].url.startsWith('https://accounts.spotify.com'), true);
  tokens.clear('spotify');
});

test('YouTube adapter: topic-channel parsing, durations, quota accounting and quota errors', async () => {
  tokens.set('youtube', { accessToken: 'YT', expiresAt: Date.now() + 3600e3 });
  quota.used = 0;
  mockFetch([
    ['https://www.googleapis.com/youtube/v3/playlistItems', (url) => {
      assert.equal(url.searchParams.get('playlistId'), 'PL1');
      if (!url.searchParams.get('pageToken')) return json({ items: [{ contentDetails: { videoId: 'v1' }, snippet: { title: 'Blinding Lights', videoOwnerChannelTitle: 'The Weeknd - Topic' } }], nextPageToken: 'p2' });
      return json({ items: [{ contentDetails: { videoId: 'v2' }, snippet: { title: 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams', videoOwnerChannelTitle: 'DaftPunkVEVO' } }, { contentDetails: { videoId: 'v3' }, snippet: { title: 'Deleted video' } }] });
    }],
    ['https://www.googleapis.com/youtube/v3/videos', () => json({ items: [{ id: 'v1', contentDetails: { duration: 'PT3M20S' }, snippet: { channelTitle: 'The Weeknd - Topic' } }, { id: 'v2', contentDetails: { duration: 'PT6M10S' }, snippet: { channelTitle: 'DaftPunkVEVO' } }] })],
    ['https://www.googleapis.com/youtube/v3/search', (url) => {
      if (url.searchParams.get('type') === 'video') return json({ items: [{ id: { videoId: 'cover' }, snippet: { title: 'Blinding Lights (Piano Cover)', channelTitle: 'Piano Guy' } }, { id: { videoId: 'real' }, snippet: { title: 'Blinding Lights', channelTitle: 'The Weeknd - Topic' } }] });
      return json({ items: [] });
    }],
    ['https://www.googleapis.com/youtube/v3/playlists', () => json({ id: 'NEWPL' })],
    ['https://www.googleapis.com/youtube/v3/playlistItems', () => json({ id: 'ok' })],
  ]);
  const youtube = new YouTubeMusicProvider({ clientId: 'cid' });
  const tracks = await youtube.getPlaylistTracks({ id: 'PL1' });
  assert.equal(tracks.length, 2, 'deleted videos are skipped');
  assert.deepEqual([tracks[0].title, tracks[0].artists, tracks[0].durationMs], ['Blinding Lights', ['The Weeknd'], 200000]);
  assert.deepEqual([tracks[1].title, tracks[1].artists], ['Get Lucky (Official Audio) ft. Pharrell Williams', ['Daft Punk']]);
  const match = await youtube.findTrack({ title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 200040 });
  assert.equal(match.id, 'real', 'topic channel upload beats the cover');
  assert.ok(quota.used >= 100 + 1, `quota accounted (${quota.used})`);

  mockFetch([[/./, () => json({ error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } }, 403)]]);
  await assert.rejects(() => youtube.findTrack({ title: 'x', artists: ['y'] }), /quota exceeded/i);
  tokens.clear('youtube');
});

test('Deezer adapter unwraps errors inside 200 responses and converts durations', async () => {
  tokens.set('deezer', { accessToken: 'DZ', expiresAt: null });
  mockFetch([
    ['https://api.deezer.com/user/me/playlists', (url) => {
      assert.equal(url.searchParams.get('access_token'), 'DZ');
      return json({ data: [{ id: 1, title: 'Loved', nb_tracks: 1, is_loved_track: true, creator: { name: 'me' } }], total: 1 });
    }],
    ['https://api.deezer.com/playlist/1/tracks', () => json({ data: [{ id: 10, title: 'Nights', duration: 307, isrc: 'QMEU31600008', artist: { name: 'Frank Ocean' }, album: { title: 'Blonde' } }] })],
    ['https://api.deezer.com/user/me/albums', () => json({ error: { type: 'OAuthException', message: 'Invalid OAuth access token.', code: 300 } })],
  ]);
  const deezer = new DeezerProvider({ appId: '1' });
  const playlists = await deezer.listPlaylists();
  assert.equal(playlists[0].special, true);
  const tracks = await deezer.getPlaylistTracks(playlists[0]);
  assert.equal(tracks[0].durationMs, 307000);
  assert.equal(tracks[0].isrc, 'QMEU31600008');
  await assert.rejects(() => deezer.listAlbums(), (error) => error.name === 'AuthError');
  assert.equal(deezer.isConnected(), false, 'auth errors sign the service out');
});

test('runTransfer works with the real Spotify adapter as destination (mocked API)', async () => {
  tokens.set('spotify', { accessToken: 'AT', expiresAt: Date.now() + 3600e3 });
  const calls = mockFetch([
    ['https://api.spotify.com/v1/me/playlists', () => json({ id: 'np', external_urls: { spotify: 'https://open.spotify.com/playlist/np' } }, 201)],
    ['https://api.spotify.com/v1/me', () => json({ id: 'user1', display_name: 'User' })],
    ['https://api.spotify.com/v1/search', (url) => {
      const q = url.searchParams.get('q');
      if (q.includes('ISRC1')) return json({ tracks: { items: [spotifyTrack('s1', 'Song One', 'Artist', 'ISRC1')] } });
      if (q.includes('ISRC2')) return json({ tracks: { items: [] } });
      if (/song two/i.test(q)) return json({ tracks: { items: [spotifyTrack('s2', 'Song Two', 'Artist', 'OTHER', 180000)] } });
      return json({ tracks: { items: [] } });
    }],
    ['https://api.spotify.com/v1/playlists/np/items', () => json({ snapshot_id: 's' }, 201)],
  ]);
  const source = {
    id: 'demo', name: 'Demo', matchConcurrency: 2,
    getPlaylistTracks: async () => [
      { id: 'a', title: 'Song One', artists: ['Artist'], isrc: 'ISRC1', durationMs: 200000 },
      { id: 'b', title: 'Song Two', artists: ['Artist'], isrc: 'ISRC2', durationMs: 180000 },
      { id: 'c', title: 'Unfindable', artists: ['Nobody'], durationMs: 100000 },
    ],
  };
  const destination = new SpotifyProvider({ clientId: 'cid' });
  const report = await runTransfer({ source, destination, selection: { playlists: [{ id: 'p', name: 'Mixed', description: '' }], albums: [], artists: [] } });
  const item = report.items[0];
  assert.equal(item.status, 'done');
  assert.equal(item.matched, 2);
  assert.equal(item.missing.length, 1);
  assert.equal(item.url, 'https://open.spotify.com/playlist/np');
  const add = calls.find((c) => c.url.includes('/playlists/np/items'));
  assert.deepEqual(add.body.uris, ['spotify:track:s1', 'spotify:track:s2']);
  const create = calls.find((c) => c.url === 'https://api.spotify.com/v1/me/playlists' && c.method === 'POST');
  assert.match(create.body.description, /Transferred from Demo with TuneBridge/);
  tokens.clear('spotify');
});
