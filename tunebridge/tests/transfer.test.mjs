import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../js/providers/index.js';
import { runTransfer, summarize, missingAsCsv } from '../js/transfer.js';

test('demo providers implement the full interface', async () => {
  const spotify = createProvider('spotify', { demo: true });
  await spotify.connect();
  assert.equal(spotify.isConnected(), true);
  const profile = await spotify.getProfile();
  assert.match(profile.name, /Demo listener/);
  const playlists = await spotify.listPlaylists();
  assert.ok(playlists.length >= 3);
  const tracks = await spotify.getPlaylistTracks(playlists[0]);
  assert.equal(tracks.length, playlists[0].trackCount);
  assert.ok(tracks[0].isrc);
  const albums = await spotify.listAlbums();
  assert.ok(albums.length > 0);
  const artists = await spotify.listArtists();
  assert.ok(artists.length > 0);
});

test('a demo transfer Spotify → Apple Music produces a coherent report', async () => {
  const source = createProvider('spotify', { demo: true });
  const destination = createProvider('apple', { demo: true });
  await source.connect();
  await destination.connect();
  const playlists = await source.listPlaylists();
  const albums = await source.listAlbums();
  const events = [];
  const report = await runTransfer({
    source,
    destination,
    selection: { playlists: playlists.slice(0, 2), albums: albums.slice(0, 3), artists: [] },
    onEvent: (event) => events.push(event.type),
  });
  assert.equal(report.items.length, 5);
  const playlistItems = report.items.filter((i) => i.kind === 'playlist');
  for (const item of playlistItems) {
    assert.equal(item.status, 'done');
    assert.equal(item.total, item.matched + item.missing.length + item.failed.length);
    assert.ok(item.destinationId);
    assert.ok(item.matched > 0);
  }
  assert.ok(events.includes('item:progress'));
  assert.equal(events.at(-1), 'done');
  const summary = summarize(report);
  assert.equal(summary.items, 5);
  assert.equal(summary.tracksTotal, playlists[0].trackCount + playlists[1].trackCount);
  const csv = missingAsCsv(report);
  assert.match(csv, /^Item,Kind,Title/);
});

test('capabilities are respected: artists cannot be written to Apple Music', async () => {
  const source = createProvider('spotify', { demo: true });
  const destination = createProvider('apple', { demo: true });
  await source.connect();
  await destination.connect();
  const artists = await source.listArtists();
  const report = await runTransfer({ source, destination, selection: { playlists: [], albums: [], artists: artists.slice(0, 2) } });
  assert.equal(report.items.length, 2);
  for (const item of report.items) assert.equal(item.status, 'error');
});

test('transfers can be cancelled', async () => {
  const source = createProvider('deezer', { demo: true });
  const destination = createProvider('tidal', { demo: true });
  await source.connect();
  await destination.connect();
  const playlists = await source.listPlaylists();
  const controller = new AbortController();
  const report = await runTransfer({
    source,
    destination,
    selection: { playlists, albums: [], artists: [] },
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'item:progress') controller.abort();
    },
  });
  assert.equal(report.cancelled, true);
  assert.ok(report.items.some((item) => item.status === 'cancelled'));
});
