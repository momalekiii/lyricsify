import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, normalizeText, scoreTrack, scoreAlbum, scoreArtist, bestMatch, trackQueries, parseArtistTitle, cleanChannelName, titleFlags, THRESHOLDS, splitArtists } from '../js/matching.js';

test('cleanTitle strips features, remaster notes and video decorations', () => {
  assert.equal(cleanTitle('Get Lucky (feat. Pharrell Williams & Nile Rodgers)'), 'get lucky');
  assert.equal(cleanTitle('Dreams - 2004 Remaster'), 'dreams');
  assert.equal(cleanTitle('Blinding Lights (Official Video)'), 'blinding lights');
  assert.equal(cleanTitle('Running Up That Hill (A Deal With God) - 2018 Remaster'), 'running up that hill a deal with god');
  assert.equal(cleanTitle('Nights'), 'nights');
  assert.equal(cleanTitle('Shape of You [Official Audio]'), 'shape of you');
  assert.equal(cleanTitle("Harry's House"), 'harrys house');
});

test('normalizeText removes accents and punctuation', () => {
  assert.equal(normalizeText('Beyoncé – Déjà Vu!'), 'beyonce deja vu');
  assert.equal(normalizeText('AC/DC & Friends'), 'ac dc and friends');
});

test('splitArtists handles the common separators', () => {
  assert.deepEqual(splitArtists('Daft Punk feat. Pharrell Williams, Nile Rodgers'), ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']);
  assert.deepEqual(splitArtists(['Silk Sonic', 'Bruno Mars & Anderson .Paak']), ['Silk Sonic', 'Bruno Mars', 'Anderson .Paak']);
});

test('ISRC equality is a perfect match', () => {
  const source = { title: 'Blinding Lights', artists: ['The Weeknd'], isrc: 'USUG11904206', durationMs: 200040 };
  const candidate = { title: 'Blinding Lights - Live', artists: ['Someone'], isrc: 'usug11904206', durationMs: 1 };
  assert.equal(scoreTrack(source, candidate), 1);
});

test('the right track wins over remixes, covers and karaoke versions', () => {
  const source = { title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 200040 };
  const candidates = [
    { id: 'karaoke', title: 'Blinding Lights (Originally Performed by The Weeknd) [Karaoke Version]', artists: ['Karaoke Hits'], durationMs: 200000 },
    { id: 'remix', title: 'Blinding Lights (Major Lazer Remix)', artists: ['The Weeknd', 'Major Lazer'], durationMs: 188000 },
    { id: 'cover', title: 'Blinding Lights', artists: ['Piano Covers Club'], durationMs: 201000 },
    { id: 'right', title: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 200040 },
    { id: 'live', title: 'Blinding Lights - Live', artists: ['The Weeknd'], durationMs: 230000 },
  ];
  const match = bestMatch(source, candidates, scoreTrack, THRESHOLDS.track);
  assert.equal(match.candidate.id, 'right');
  assert.ok(match.score > 0.95, `score was ${match.score}`);
});

test('tracks with slightly different metadata still match', () => {
  const source = { title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artists: ['Daft Punk'], durationMs: 369626, album: 'Random Access Memories' };
  const candidate = { title: 'Get Lucky', artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'], durationMs: 369000, album: 'Random Access Memories' };
  assert.ok(scoreTrack(source, candidate) > 0.85);
  const ytCandidate = { title: 'Get Lucky', artists: ['Daft Punk'], durationMs: 0 };
  assert.ok(scoreTrack(source, ytCandidate) > THRESHOLDS.track);
});

test('unrelated tracks do not match', () => {
  const source = { title: 'Dreams', artists: ['Fleetwood Mac'], durationMs: 257800 };
  const candidate = { title: 'Dreams', artists: ['The Cranberries'], durationMs: 272000 };
  assert.ok(scoreTrack(source, candidate) < THRESHOLDS.track, `score ${scoreTrack(source, candidate)}`);
  const candidate2 = { title: 'Dream On', artists: ['Aerosmith'], durationMs: 265000 };
  assert.ok(scoreTrack(source, candidate2) < THRESHOLDS.track);
});

test('albums match by UPC, title and artist', () => {
  const source = { title: 'Random Access Memories', artists: ['Daft Punk'], upc: '886443927087', trackCount: 13 };
  assert.equal(scoreAlbum(source, { title: 'x', artists: ['y'], upc: '0886443927087' }), 1);
  assert.ok(scoreAlbum(source, { title: 'Random Access Memories', artists: ['Daft Punk'], trackCount: 13 }) > 0.95);
  assert.ok(scoreAlbum(source, { title: 'Random Access Memories (Live)', artists: ['Tribute Band'] }) < THRESHOLDS.album);
});

test('artists match on normalised names', () => {
  assert.equal(scoreArtist({ name: 'Beyoncé' }, { name: 'Beyonce' }), 1);
  assert.ok(scoreArtist({ name: 'The Weeknd' }, { name: 'The Weekend' }) < 0.95);
  assert.ok(scoreArtist({ name: 'M83' }, { name: 'MGMT' }) < THRESHOLDS.artist);
});

test('trackQueries produce clean, deduplicated search strings', () => {
  const queries = trackQueries({ title: 'Dreams - 2004 Remaster', artists: ['Fleetwood Mac'] });
  assert.equal(queries[0], 'dreams Fleetwood Mac');
  assert.ok(queries.includes('dreams 2004 remaster Fleetwood Mac'));
  assert.equal(new Set(queries).size, queries.length);
});

test('YouTube style titles are parsed into artist and title', () => {
  assert.deepEqual(parseArtistTitle('Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams'), { artists: ['Daft Punk'], title: 'Get Lucky (Official Audio) ft. Pharrell Williams' });
  assert.deepEqual(parseArtistTitle('Blinding Lights', 'The Weeknd'), { artists: ['The Weeknd'], title: 'Blinding Lights' });
  assert.equal(cleanChannelName('The Weeknd - Topic'), 'The Weeknd');
  assert.equal(cleanChannelName('TheWeekndVEVO'), 'TheWeeknd');
});

test('titleFlags detect versions that should not be confused', () => {
  assert.deepEqual([...titleFlags('Song (Live at Wembley)')], ['live']);
  assert.ok(titleFlags('Song (Sped Up)').has('spedup'));
  assert.equal(titleFlags('Alive').size, 0);
  assert.equal(titleFlags('Olive Tree').size, 0);
});
