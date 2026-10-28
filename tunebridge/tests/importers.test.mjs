// File/link importers: Spotify data export, Apple Music exports, Google Takeout, CSV, M3U, text, ZIP, Deezer links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { importBytes, importFiles, summarize, classifyLink, linkHint, importDeezerLink, importLink, cleanVideoTitle } from '../js/importers/index.js';
import { parseDelimited, parseDuration, splitArtistTitle, importDelimited } from '../js/importers/text.js';
import { parsePlist, importApplePlist } from '../js/importers/apple-music.js';
import { importSpotifyJson } from '../js/importers/spotify-export.js';
import { listZipEntries } from '../js/importers/zip.js';

const utf8 = (text) => new TextEncoder().encode(text);
const utf16le = (text) => {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff; bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) { const code = text.charCodeAt(i); bytes[2 + i * 2] = code & 0xff; bytes[3 + i * 2] = code >> 8; }
  return bytes;
};

// --- tiny ZIP writer (stored + deflate) for fixtures -------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes) => { let crc = 0xffffffff; for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
function makeZip(files, { deflate = true } = {}) {
  const parts = []; const central = []; let offset = 0;
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? utf8(content) : content;
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameBytes = utf8(name);
    const method = deflate ? 8 : 0;
    const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0), ...u32(crc32(raw)), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes]);
    parts.push(local, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0), ...u32(crc32(raw)), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nameBytes]));
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const total = [...parts, ...central, eocd];
  const out = new Uint8Array(total.reduce((n, c) => n + c.length, 0));
  let pos = 0; for (const chunk of total) { out.set(chunk, pos); pos += chunk.length; }
  return out;
}

const SPOTIFY_PLAYLISTS = {
  playlists: [
    { name: 'Road trip', lastModifiedDate: '2026-01-02', items: [
      { track: { trackName: 'Dreams', artistName: 'Fleetwood Mac', albumName: 'Rumours', trackUri: 'spotify:track:0ofHAoxe9vBkTCp2UQIavz' }, episode: null, localTrack: null, addedDate: '2025-05-01' },
      { track: null, episode: { episodeName: 'Some podcast', showName: 'Show', episodeUri: 'spotify:episode:abc' }, localTrack: null, addedDate: '2025-05-01' },
      { track: { trackName: 'Get Lucky', artistName: 'Daft Punk', albumName: 'Random Access Memories', trackUri: 'spotify:track:2Foc5Q5nqNiosCNqttzHof' }, episode: null, localTrack: null, addedDate: '2025-05-02' },
    ], description: 'Windows down', numberOfFollowers: 0 },
  ],
};
const SPOTIFY_LIBRARY = {
  tracks: [{ artist: 'Frank Ocean', album: 'Blonde', track: 'Nights', uri: 'spotify:track:7eqoqGkKwgOaWNNHx90uEZ' }],
  albums: [{ artist: 'Radiohead', album: 'In Rainbows', uri: 'spotify:album:5vkqYmiPBYLaalcmjujWxK' }],
  shows: [], episodes: [], bannedTracks: [],
  artists: [{ name: 'Tame Impala', uri: 'spotify:artist:5INjqkS1o8h1imAzPqGZBb' }],
  bannedArtists: [], other: [],
};

test('Spotify data export: Playlist1.json and YourLibrary.json', () => {
  const playlists = importSpotifyJson(SPOTIFY_PLAYLISTS, { fileName: 'Playlist1.json' });
  assert.equal(playlists.playlists.length, 1);
  assert.equal(playlists.playlists[0].name, 'Road trip');
  assert.equal(playlists.playlists[0].description, 'Windows down');
  assert.deepEqual(playlists.playlists[0].tracks.map((t) => t.title), ['Dreams', 'Get Lucky']);
  assert.equal(playlists.playlists[0].tracks[0].id, 'spotify:0ofHAoxe9vBkTCp2UQIavz');
  assert.deepEqual(playlists.playlists[0].tracks[0].artists, ['Fleetwood Mac']);
  assert.match(playlists.notes[0], /1 podcast episodes/);

  const library = importSpotifyJson(SPOTIFY_LIBRARY, { fileName: 'YourLibrary.json' });
  assert.equal(library.playlists[0].name, 'Liked Songs');
  assert.equal(library.playlists[0].special, true);
  assert.equal(library.playlists[0].tracks[0].title, 'Nights');
  assert.deepEqual(library.albums.map((a) => a.title), ['In Rainbows']);
  assert.deepEqual(library.artists.map((a) => a.name), ['Tame Impala']);
  assert.equal(importSpotifyJson({ hello: 'world' }), null);
});

test('ZIP: a Spotify "Account data" package is unpacked and routed', async () => {
  const zip = makeZip({
    'Spotify Account Data/Playlist1.json': JSON.stringify(SPOTIFY_PLAYLISTS),
    'Spotify Account Data/YourLibrary.json': JSON.stringify(SPOTIFY_LIBRARY),
    'Spotify Account Data/StreamingHistory_music_0.json': '[{"endTime":"2025-01-01 10:00","artistName":"x","trackName":"y","msPlayed":1000}]',
    'Spotify Account Data/Userdata.json': '{"username":"me"}',
    '__MACOSX/._Playlist1.json': 'junk',
  });
  assert.equal(listZipEntries(zip).length, 5);
  const result = await importBytes('my_spotify_data.zip', zip);
  assert.deepEqual(result.playlists.map((p) => p.name).sort(), ['Liked Songs', 'Road trip']);
  assert.equal(result.albums.length, 1);
  assert.equal(result.artists.length, 1);
  const stored = await importBytes('stored.zip', makeZip({ 'Playlist1.json': JSON.stringify(SPOTIFY_PLAYLISTS) }, { deflate: false }));
  assert.equal(stored.playlists[0].tracks.length, 2, 'stored (uncompressed) entries work too');
});

test('Apple Music: XML playlist export, Library.xml, plain-text export', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Major Version</key><integer>1</integer>
  <key>Tracks</key><dict>
    <key>1001</key><dict><key>Track ID</key><integer>1001</integer><key>Name</key><string>Dreams</string><key>Artist</key><string>Fleetwood Mac</string><key>Album</key><string>Rumours</string><key>Total Time</key><integer>257800</integer><key>Persistent ID</key><string>ABC123</string><key>Apple Music</key><true/></dict>
    <key>1002</key><dict><key>Track ID</key><integer>1002</integer><key>Name</key><string>Weird Fishes &#47; Arpeggi &amp; more</string><key>Artist</key><string>Radiohead</string><key>Album</key><string>In Rainbows</string><key>Total Time</key><integer>318360</integer></dict>
    <key>1003</key><dict><key>Track ID</key><integer>1003</integer><key>Name</key><string>Episode 1</string><key>Artist</key><string>Host</string><key>Genre</key><string>Podcast</string><key>Podcast</key><true/></dict>
  </dict>
  <key>Playlists</key><array>
    <dict><key>Name</key><string>Library</string><key>Master</key><true/><key>Playlist ID</key><integer>1</integer><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1001</integer></dict><dict><key>Track ID</key><integer>1002</integer></dict></array></dict>
    <dict><key>Name</key><string>Music</string><key>Distinguished Kind</key><integer>4</integer><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1001</integer></dict></array></dict>
    <dict><key>Name</key><string>Sunday morning</string><key>Playlist Persistent ID</key><string>PL1</string><key>Playlist Items</key><array><dict><key>Track ID</key><integer>1001</integer></dict><dict><key>Track ID</key><integer>1003</integer></dict><dict><key>Track ID</key><integer>1002</integer></dict></array></dict>
  </array>
</dict></plist>`;
  const plist = parsePlist(xml);
  assert.equal(plist['Major Version'], 1);
  assert.equal(plist.Playlists.length, 3);
  const result = importApplePlist(xml, { fileName: 'Sunday morning.xml' });
  assert.equal(result.playlists.length, 1, 'Master and distinguished playlists are skipped');
  assert.equal(result.playlists[0].name, 'Sunday morning');
  assert.equal(result.playlists[0].id, 'apple:playlist:PL1');
  assert.deepEqual(result.playlists[0].tracks.map((t) => t.title), ['Dreams', 'Weird Fishes / Arpeggi & more'], 'podcast skipped, entities decoded');
  assert.equal(result.playlists[0].tracks[0].durationMs, 257800);
  assert.equal(result.playlists[0].tracks[0].id, 'apple:ABC123');

  const tsv = 'Name\tArtist\tComposer\tAlbum\tGrouping\tWork\tMovement Number\tMovement Count\tMovement Name\tGenre\tSize\tTime\tDisc Number\tDisc Count\tTrack Number\tTrack Count\tYear\tDate Modified\tDate Added\tBit Rate\tSample Rate\tVolume Adjustment\tKind\tEqualizer\tComments\tPlays\tLast Played\tSkips\tLast Skipped\tMy Rating\tLocation\n'
    + 'Dreams\tFleetwood Mac\t\tRumours\t\t\t\t\t\tRock\t\t258\t1\t1\t2\t11\t1977\t\t\t256\t44100\t\tApple Music AAC audio file\t\t\t3\t\t\t\t\t\n'
    + 'Nights\tFrank Ocean\t\tBlonde\t\t\t\t\t\tR&B\t\t307\t1\t1\t14\t17\t2016\t\t\t256\t44100\t\tApple Music AAC audio file\t\t\t\t\t\t\t\t\n';
  return importBytes('Sunday morning.txt', utf16le(tsv)).then((text) => {
    assert.equal(text.playlists.length, 1);
    assert.equal(text.playlists[0].name, 'Sunday morning');
    assert.deepEqual(text.playlists[0].tracks.map((t) => [t.title, t.artists[0], t.album, t.durationMs]), [['Dreams', 'Fleetwood Mac', 'Rumours', 258000], ['Nights', 'Frank Ocean', 'Blonde', 307000]]);
  });
});

test('CSV: Exportify/TuneMyMusic-style sheets, Takeout music library, Takeout ID-only playlists, subscriptions', async () => {
  const exportify = 'Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Added At\n'
    + 'spotify:track:1,"Dreams - 2004 Remaster",Rumours,Fleetwood Mac,1977-02-04,257800,80,2025-01-01\n'
    + 'spotify:track:2,"Get Lucky (feat. Pharrell Williams)",Random Access Memories,"Daft Punk, Pharrell Williams",2013-05-17,369626,70,2025-01-02\n';
  const a = importDelimited(exportify, { fileName: 'road_trip.csv' });
  assert.equal(a.playlists[0].name, 'road_trip');
  assert.equal(a.playlists[0].tracks[1].title, 'Get Lucky (feat. Pharrell Williams)');
  assert.deepEqual(a.playlists[0].tracks[1].artists, ['Daft Punk', 'Pharrell Williams']);
  assert.equal(a.playlists[0].tracks[0].durationMs, 257800);

  const tmm = 'Track name,Artist name,Album,Playlist name,Type,ISRC\nDreams,Fleetwood Mac,Rumours,Oldies,Song,USRE17600016\nNights,Frank Ocean,Blonde,Late,Song,\nIn Rainbows,Radiohead,,,Album,\nTame Impala,,,,Artist,\n';
  const b = importDelimited(tmm, { fileName: 'tunemymusic.csv' });
  assert.deepEqual(b.playlists.map((p) => p.name), ['Oldies', 'Late'], 'playlist column splits into several playlists');
  assert.equal(b.playlists[0].tracks[0].isrc, 'USRE17600016');
  assert.deepEqual(b.albums.map((x) => x.title), ['In Rainbows']);
  assert.deepEqual(b.artists.map((x) => x.name), ['Tame Impala']);

  const takeoutSongs = 'Song Title,Album Title,Artist Names,Duration (ms),Explicit\nDreams,Rumours,Fleetwood Mac,257800,No\n';
  const c = await importBytes('Takeout/YouTube and YouTube Music/music-library-songs/music library songs.csv', utf8(takeoutSongs));
  assert.equal(c.playlists[0].tracks[0].title, 'Dreams');
  assert.equal(c.playlists[0].origin, 'YouTube Music');

  const takeoutPlaylist = 'Video ID,Playlist Video Creation Timestamp\ndQw4w9WgXcQ,2024-01-01T00:00:00+00:00\n';
  const d = await importBytes('Takeout/YouTube and YouTube Music/playlists/Workout-videos.csv', utf8(takeoutPlaylist));
  assert.equal(d.playlists.length, 0);
  assert.match(d.notes[0], /only YouTube video IDs/);

  const subs = 'Channel Id,Channel Url,Channel Title\nUC1,https://www.youtube.com/channel/UC1,Tame Impala - Topic\nUC2,https://www.youtube.com/channel/UC2,Radiohead\n';
  const e = await importBytes('subscriptions.csv', utf8(subs));
  assert.deepEqual(e.artists.map((x) => x.name), ['Tame Impala', 'Radiohead']);

  assert.deepEqual(parseDelimited('a;b\n"x;y";2\n'), [['a', 'b'], ['x;y', '2']], 'semicolon sniffing + quotes');
  assert.equal(parseDuration('4:17'), 257000);
  assert.equal(parseDuration('258'), 258000);
  assert.equal(parseDuration('257800'), 257800);
  assert.equal(parseDuration('258', 'Duration (ms)'), 258);
});

test('M3U and plain text lists', async () => {
  const m3u = '#EXTM3U\n#PLAYLIST:Mix tape\n#EXTINF:257,Fleetwood Mac - Dreams\n/music/Fleetwood Mac/Dreams.m4a\n#EXTINF:-1,Frank Ocean – Nights\nhttp://example.com/nights.mp3\n/music/Daft Punk - Get Lucky.mp3\n';
  const a = await importBytes('mix.m3u8', utf8(m3u));
  assert.equal(a.playlists[0].name, 'Mix tape');
  assert.deepEqual(a.playlists[0].tracks.map((t) => [t.artists[0], t.title, t.durationMs]), [['Fleetwood Mac', 'Dreams', 257000], ['Frank Ocean', 'Nights', 0], ['Daft Punk', 'Get Lucky', 0]]);

  const txt = '# my songs\n1. Fleetwood Mac - Dreams\nFrank Ocean – Nights\nJust a title\n\n';
  const b = await importBytes('songs.txt', utf8(txt));
  assert.deepEqual(b.playlists[0].tracks.map((t) => [t.artists[0] || '', t.title]), [['Fleetwood Mac', 'Dreams'], ['Frank Ocean', 'Nights'], ['', 'Just a title']]);
  assert.deepEqual(splitArtistTitle('A - B - C'), { artist: 'A', title: 'B - C' });
});

test('importFiles merges several files and summarize() describes the result', async () => {
  const files = [
    { name: 'Playlist1.json', arrayBuffer: async () => utf8(JSON.stringify(SPOTIFY_PLAYLISTS)).buffer },
    { name: 'broken.json', arrayBuffer: async () => utf8('{not json').buffer },
  ];
  const result = await importFiles(files);
  assert.equal(result.playlists.length, 1);
  assert.match(result.notes.join('\n'), /broken\.json: not valid JSON/);
  assert.equal(summarize(result), '1 playlist (2 songs)');
  assert.equal(summarize({ playlists: [{ tracks: [] }, { tracks: [{}] }], albums: [{}, {}], artists: [{}] }), '2 playlists (1 song) · 2 albums · 1 artist');
});

test('Link classification: all six services, URIs, short links, and unusable links', () => {
  assert.deepEqual(classifyLink('https://www.deezer.com/en/playlist/908622995'), { kind: 'link', platform: 'deezer', type: 'playlist', id: '908622995', url: 'https://www.deezer.com/playlist/908622995' });
  assert.equal(classifyLink('deezer.com/album/302127').type, 'album');
  assert.equal(classifyLink('https://deezer.page.link/abc').type, 'short');
  const spotify = classifyLink('https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc');
  assert.deepEqual(spotify, { kind: 'link', platform: 'spotify', type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M', url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' });
  assert.equal(classifyLink('spotify:album:4LH4d3cOWNNsVw41Gqt2kv').type, 'album');
  assert.equal(classifyLink('https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M').type, 'track');
  assert.equal(classifyLink('https://spotify.link/abc').type, 'short');
  const apple = classifyLink('https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb');
  assert.equal(apple.platform, 'apple'); assert.equal(apple.type, 'playlist'); assert.equal(apple.id, 'pl.f4d106fed2bd41149aaacabb233eb5eb'); assert.equal(apple.storefront, 'us');
  assert.equal(classifyLink('https://music.apple.com/gb/album/discovery/697194953').type, 'album');
  assert.equal(classifyLink('https://music.apple.com/gb/album/discovery/697194953?i=697195787').type, 'track');
  assert.equal(classifyLink('https://music.youtube.com/playlist?list=PLabc&si=1').id, 'PLabc');
  assert.equal(classifyLink('https://www.youtube.com/watch?v=xyz&list=PLabc').type, 'playlist');
  assert.equal(classifyLink('https://www.youtube.com/playlist?list=WL').type, 'private');
  assert.equal(classifyLink('https://youtu.be/xyz').type, 'track');
  assert.deepEqual(classifyLink('https://soundcloud.com/some-user/sets/my-mix'), { kind: 'link', platform: 'soundcloud', type: 'playlist', id: 'some-user/sets/my-mix', url: 'https://soundcloud.com/some-user/sets/my-mix' });
  assert.equal(classifyLink('https://soundcloud.com/some-user/one-track').type, 'track');
  assert.equal(classifyLink('https://tidal.com/browse/playlist/1b418bb8-90a7-4f87-901d-707993838346').type, 'playlist');
  assert.equal(classifyLink('https://listen.tidal.com/album/77646169').type, 'album');
  assert.equal(classifyLink('not a url at all').kind, 'invalid');
  assert.equal(classifyLink('https://example.com/x').kind, 'unknown');
  assert.equal(classifyLink('').kind, 'empty');

  // hints
  assert.equal(linkHint(classifyLink('https://www.deezer.com/playlist/1')), null, 'Deezer needs nothing');
  assert.match(linkHint(spotify), /isn’t switched on/, 'Spotify needs the helper worker');
  assert.equal(linkHint(spotify, { resolverEnabled: true }), null);
  assert.equal(linkHint(classifyLink('https://music.youtube.com/playlist?list=PLabc'), { youtubeDirect: true }), null, 'YouTube works with an API key');
  assert.match(linkHint(classifyLink('https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M'), { resolverEnabled: true }), /single song/);
  assert.match(linkHint(classifyLink('https://spotify.link/abc')), /shortened link/);
  assert.equal(linkHint(classifyLink('https://spotify.link/abc'), { resolverEnabled: true }), null, 'the worker expands short links');
});

test('Deezer public links: fetching without any key', async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    const u = new URL(url);
    const body = u.pathname === '/playlist/908622995' ? { id: 908622995, title: 'Hits', description: 'd', nb_tracks: 3, link: 'https://www.deezer.com/playlist/908622995', creator: { name: 'Deezer' }, picture_medium: 'pic' }
      : u.pathname === '/playlist/908622995/tracks' ? (u.searchParams.get('index') === '0'
        ? { data: [{ id: 1, title: 'Dreams', duration: 258, isrc: 'USRE17600016', artist: { name: 'Fleetwood Mac' }, album: { title: 'Rumours' }, link: 'l1' }, { id: 2, title: 'Nights', duration: 307, artist: { name: 'Frank Ocean' }, album: { title: 'Blonde' } }], next: 'x' }
        : { data: [{ id: 3, title: 'Get Lucky', duration: 369, artist: { name: 'Daft Punk' }, album: { title: 'RAM' } }] })
      : u.pathname === '/album/302127' ? { id: 302127, title: 'Discovery', artist: { name: 'Daft Punk' }, upc: '724384960650', release_date: '2001-03-07', nb_tracks: 14, cover_medium: 'c', link: 'https://www.deezer.com/album/302127' }
      : u.pathname === '/playlist/1' ? { error: { type: 'DataException', message: 'no data', code: 800 } }
      : { error: { message: 'nope' } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const playlist = await importDeezerLink(classifyLink('https://www.deezer.com/en/playlist/908622995'));
  assert.equal(playlist.playlists[0].name, 'Hits');
  assert.equal(playlist.playlists[0].tracks.length, 3, 'paginates');
  assert.equal(playlist.playlists[0].tracks[0].isrc, 'USRE17600016');
  assert.equal(playlist.playlists[0].tracks[0].durationMs, 258000);
  const album = await importDeezerLink(classifyLink('https://www.deezer.com/album/302127'));
  assert.equal(album.albums[0].upc, '724384960650');
  await assert.rejects(() => importDeezerLink(classifyLink('https://www.deezer.com/playlist/1')), /isn’t public/);
  assert.ok(requests.every((r) => !/access_token/.test(r)), 'no token is ever sent');
});

test('importLink: routes YouTube to the Data API with a key, everything else to the resolver, and maps resolver errors', async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const u = new URL(String(url));
    const ok = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'www.googleapis.com' && u.pathname.endsWith('/playlists')) return ok({ items: [{ snippet: { title: 'Gym', channelTitle: 'Me', thumbnails: { medium: { url: 'thumb' } } }, contentDetails: { itemCount: 2 } }] });
    if (u.hostname === 'www.googleapis.com' && u.pathname.endsWith('/playlistItems')) return ok({ items: [
      { snippet: { title: 'Fleetwood Mac - Dreams (Official Music Video)', videoOwnerChannelTitle: 'FleetwoodMacVEVO' }, contentDetails: { videoId: 'v1' } },
      { snippet: { title: 'Private video' }, contentDetails: { videoId: 'v2' } },
      { snippet: { title: 'Nights', videoOwnerChannelTitle: 'Frank Ocean - Topic' }, contentDetails: { videoId: 'v3' } },
    ] });
    if (u.hostname === 'helper.example' && u.pathname === '/resolve') {
      const target = u.searchParams.get('url');
      if (/open\.spotify\.com/.test(target)) return ok({ ok: true, result: { platform: 'spotify', playlists: [{ id: 'spotify:playlist:x', name: 'Hits', image: 'img', url: target, owner: 'Spotify', tracks: [{ id: 'spotify:track:1', title: 'Dreams', artists: ['Fleetwood Mac'], durationMs: 257000 }] }], albums: [], artists: [], notes: ['first 100 only'] } });
      if (/music\.apple\.com/.test(target)) return ok({ ok: false, error: 'not_public', message: 'x' }, 403);
      return ok({ ok: false, error: 'parse_failed' }, 400);
    }
    return ok({}, 404);
  };
  const yt = await importLink(classifyLink('https://music.youtube.com/playlist?list=PLabc'), { config: { youtubeApiKey: 'KEY' } });
  assert.equal(yt.playlists[0].name, 'Gym');
  assert.deepEqual(yt.playlists[0].tracks.map((t) => [t.title, t.artists]), [['Dreams', ['Fleetwood Mac']], ['Nights', ['Frank Ocean']]]);
  assert.equal(yt.playlists[0].platform, 'youtube');
  assert.match(yt.notes.join(' '), /1 private or deleted video was skipped/);
  assert.ok(requests.some((r) => /key=KEY/.test(r)) && requests.every((r) => !/helper\.example/.test(r)), 'direct API call, no resolver');

  const sp = await importLink(classifyLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), { config: { resolverUrl: 'https://helper.example/' } });
  assert.equal(sp.playlists[0].name, 'Hits');
  assert.equal(sp.playlists[0].tracks[0].artists[0], 'Fleetwood Mac');
  assert.deepEqual(sp.notes, ['first 100 only']);
  assert.ok(requests.some((r) => r.startsWith('https://helper.example/resolve?url=https%3A%2F%2Fopen.spotify.com')), 'resolver called with the canonical link');

  await assert.rejects(() => importLink(classifyLink('https://music.apple.com/us/playlist/x/pl.1'), { config: { resolverUrl: 'https://helper.example' } }), /isn’t public/);
  await assert.rejects(() => importLink(classifyLink('https://tidal.com/browse/playlist/1b418bb8-90a7-4f87-901d-707993838346'), { config: { resolverUrl: 'https://helper.example' } }), /changed its page layout/);
  await assert.rejects(() => importLink(classifyLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), { config: {} }), /isn’t switched on/);
});

test('YouTube video titles are turned into artist + song', () => {
  assert.deepEqual(cleanVideoTitle('Fleetwood Mac - Dreams (Official Music Video) [HD]', 'FleetwoodMacVEVO'), { title: 'Dreams', artists: ['Fleetwood Mac'] });
  assert.deepEqual(cleanVideoTitle('Nights', 'Frank Ocean - Topic'), { title: 'Nights', artists: ['Frank Ocean'] });
  assert.deepEqual(cleanVideoTitle('Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams', 'DaftPunkVEVO').artists, ['Daft Punk']);
  assert.equal(cleanVideoTitle('The Weeknd - Blinding Lights (Lyrics)', 'Lyrics Hub').title, 'Blinding Lights');
  assert.deepEqual(cleanVideoTitle('Some Random Upload', 'Random Channel'), { title: 'Some Random Upload', artists: [] });
  assert.deepEqual(cleanVideoTitle('Bohemian Rhapsody by Queen', 'x'), { title: 'Bohemian Rhapsody', artists: ['Queen'] });
});
