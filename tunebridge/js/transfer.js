// The transfer engine: reads from the source, matches on the destination, writes the result
// and streams progress events to the UI. Pure logic — no DOM access, so it is unit-testable.
import { mapLimit, isAbortError, throwIfAborted, unique, toCsv } from './util.js';

const describe = (sourceName) => `Transferred from ${sourceName} with TuneBridge`;

export async function runTransfer({ source, destination, selection, options = {}, onEvent = () => {}, signal }) {
  const report = {
    startedAt: Date.now(),
    finishedAt: null,
    source: source.id,
    destination: destination.id,
    items: [],
    cancelled: false,
  };
  const emit = (type, payload = {}) => onEvent({ type, ...payload });
  const playlists = selection.playlists || [];
  const albums = selection.albums || [];
  const artists = selection.artists || [];
  const totalUnits = playlists.length + (albums.length ? 1 : 0) + (artists.length ? 1 : 0);
  let doneUnits = 0;
  const overall = () => emit('overall', { done: doneUnits, total: totalUnits });

  try {
    for (const playlist of playlists) {
      throwIfAborted(signal);
      const entry = { kind: 'playlist', sourceId: playlist.id, name: playlist.name, status: 'running', message: 'Reading tracks…', total: 0, done: 0, matched: 0, missing: [], failed: [], url: '', destinationId: '', error: '' };
      report.items.push(entry);
      emit('item:start', { item: entry });
      try {
        const tracks = await source.getPlaylistTracks(playlist, {
          signal,
          onProgress: (count) => {
            entry.message = `Reading tracks… ${count}`;
            emit('item:update', { item: entry });
          },
        });
        entry.total = tracks.length;
        entry.message = tracks.length ? 'Matching tracks…' : 'Playlist is empty';
        emit('item:update', { item: entry });

        const matches = await mapLimit(tracks, destination.matchConcurrency || 3, async (track) => {
          throwIfAborted(signal);
          let match = null;
          let failure = null;
          try {
            match = await destination.findTrack(track, { signal });
          } catch (error) {
            if (isAbortError(error) || error.name === 'AuthError') throw error;
            failure = error;
          }
          entry.done += 1;
          if (match) entry.matched += 1;
          else if (failure) entry.failed.push({ track, error: failure.message });
          else entry.missing.push(track);
          entry.message = `Matching tracks… ${entry.done}/${entry.total}`;
          emit('item:progress', { item: entry, track, match, error: failure });
          return match;
        }, { signal });

        const ids = unique(matches.filter(Boolean).map((m) => m.id));
        entry.message = 'Creating playlist…';
        emit('item:update', { item: entry });
        const created = await destination.createPlaylist(
          {
            name: options.renamePlaylist ? options.renamePlaylist(playlist) : playlist.name,
            description: [playlist.description, describe(source.name)].filter(Boolean).join(' · '),
            isPublic: Boolean(options.publicPlaylists),
          },
          { signal },
        );
        entry.destinationId = created.id;
        entry.url = created.url || '';
        if (ids.length) {
          await destination.addTracks(created.id, ids, {
            signal,
            onProgress: (count) => {
              entry.message = `Adding tracks… ${count}/${ids.length}`;
              emit('item:update', { item: entry });
            },
          });
        }
        entry.status = 'done';
        entry.message = `${entry.matched} of ${entry.total} tracks transferred`;
      } catch (error) {
        if (isAbortError(error)) throw error;
        entry.status = 'error';
        entry.error = error.message || String(error);
        entry.message = entry.error;
        if (error.name === 'AuthError') {
          emit('item:done', { item: entry });
          throw error;
        }
      }
      doneUnits += 1;
      emit('item:done', { item: entry });
      overall();
    }

    if (albums.length) await transferGroup({ kind: 'album', items: albums, find: (a, o) => destination.findAlbum(a, o), write: (ids, o) => destination.saveAlbums(ids, o), label: (a) => `${a.title} — ${a.artists?.join(', ') || ''}`, report, emit, signal, concurrency: destination.matchConcurrency || 3 });
    doneUnits += albums.length ? 1 : 0;
    overall();
    if (artists.length) await transferGroup({ kind: 'artist', items: artists, find: (a, o) => destination.findArtist(a, o), write: (ids, o) => destination.followArtists(ids, o), label: (a) => a.name, report, emit, signal, concurrency: destination.matchConcurrency || 3 });
    doneUnits += artists.length ? 1 : 0;
    overall();
  } catch (error) {
    if (isAbortError(error)) {
      report.cancelled = true;
      for (const item of report.items) if (item.status === 'running') { item.status = 'cancelled'; item.message = 'Cancelled'; }
    } else {
      report.error = error.message || String(error);
      for (const item of report.items) if (item.status === 'running') { item.status = 'error'; item.message = report.error; }
    }
  }
  report.finishedAt = Date.now();
  emit('done', { report });
  return report;
}

async function transferGroup({ kind, items, find, write, label, report, emit, signal, concurrency }) {
  const entries = items.map((item) => ({ kind, sourceId: item.id, name: label(item), status: 'running', message: 'Searching…', total: 1, done: 0, matched: 0, missing: [], failed: [], url: '', destinationId: '', error: '', source: item }));
  report.items.push(...entries);
  for (const entry of entries) emit('item:start', { item: entry });

  const found = await mapLimit(entries, concurrency, async (entry) => {
    throwIfAborted(signal);
    try {
      const match = await find(entry.source, { signal });
      entry.done = 1;
      if (match) {
        entry.matched = 1;
        entry.destinationId = match.id;
        entry.url = match.url || '';
        entry.message = 'Found, saving…';
        emit('item:update', { item: entry });
        return { entry, match };
      }
      entry.status = 'missing';
      entry.missing.push(entry.source);
      entry.message = kind === 'artist' ? 'Artist not found' : 'Album not found';
      emit('item:done', { item: entry });
      return null;
    } catch (error) {
      if (isAbortError(error) || error.name === 'AuthError') throw error;
      entry.done = 1;
      entry.status = 'error';
      entry.error = error.message;
      entry.message = error.message;
      emit('item:done', { item: entry });
      return null;
    }
  }, { signal });

  const pending = found.filter(Boolean);
  if (!pending.length) return;
  try {
    await write(unique(pending.map((p) => p.match.id)), { signal });
    for (const { entry } of pending) {
      entry.status = 'done';
      entry.message = kind === 'artist' ? 'Following' : 'Saved to library';
      emit('item:done', { item: entry });
    }
  } catch (error) {
    if (isAbortError(error) || error.name === 'AuthError') throw error;
    for (const { entry } of pending) {
      entry.status = 'error';
      entry.error = error.message;
      entry.message = error.message;
      emit('item:done', { item: entry });
    }
  }
}

export function summarize(report) {
  const summary = { items: report.items.length, done: 0, partial: 0, failed: 0, tracksTotal: 0, tracksMatched: 0, missing: 0 };
  for (const item of report.items) {
    if (item.status === 'done' && item.missing.length + item.failed.length === 0) summary.done += 1;
    else if (item.status === 'done') summary.partial += 1;
    else summary.failed += 1;
    if (item.kind === 'playlist') {
      summary.tracksTotal += item.total;
      summary.tracksMatched += item.matched;
    }
    summary.missing += item.missing.length + item.failed.length;
  }
  return summary;
}

export function missingAsCsv(report) {
  const rows = [['Item', 'Kind', 'Title', 'Artists', 'Album', 'Duration (s)', 'ISRC', 'Reason', 'Source URL']];
  for (const item of report.items) {
    for (const track of item.missing) {
      rows.push([item.name, item.kind, track.title || track.name || '', (track.artists || []).join('; '), track.album || '', track.durationMs ? Math.round(track.durationMs / 1000) : '', track.isrc || '', 'Not found', track.url || '']);
    }
    for (const { track, error } of item.failed) {
      rows.push([item.name, item.kind, track.title || track.name || '', (track.artists || []).join('; '), track.album || '', track.durationMs ? Math.round(track.durationMs / 1000) : '', track.isrc || '', `Error: ${error}`, track.url || '']);
    }
  }
  return toCsv(rows);
}
