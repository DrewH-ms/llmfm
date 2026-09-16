import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** LLMFM_HOME is what every path in the install hangs off. Set anything else and this test
 *  writes playlists into the user's real install — which it did, once. Pointing it at a
 *  temp tree also means the bundled folder here is one this test made, so what it asserts
 *  does not change every time a track is added to the shipped library. */
const home = mkdtempSync(join(tmpdir(), 'llmfm-playlists-'));
process.env['LLMFM_HOME'] = home;

const {
  listPlaylists,
  tracksIn,
  libraryFor,
  resolveTrack,
  playableTracks,
  listTracks,
  isPlaylist,
  playlistOf,
} = await import('./playlists.ts');
const { playlistsDir, bundledDir } = await import('./paths.ts');

const dir = playlistsDir();
mkdirSync(bundledDir(), { recursive: true });
writeFileSync(join(bundledDir(), 'shipped.mid'), 'not really a midi');
mkdirSync(join(dir, 'roadtrip'), { recursive: true });
mkdirSync(join(dir, 'empty-one'), { recursive: true });
writeFileSync(join(dir, 'roadtrip', 'one.mid'), 'not really a midi');
writeFileSync(join(dir, 'roadtrip', 'two.wav'), 'not really a wav');
writeFileSync(join(dir, 'roadtrip', 'notes.txt'), 'ignored');
writeFileSync(join(dir, 'loose.mid'), 'not really a midi');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('a folder is a playlist, and only playable files count', () => {
  const names = listPlaylists().map((entry) => entry.name);
  assert.deepEqual(names, ['all', 'bundled', 'empty-one', 'roadtrip']);
  assert.deepEqual(tracksIn('roadtrip'), ['roadtrip/one.mid', 'roadtrip/two.wav']);
});

/** Bundled is a folder like any other, so it must be listed once, by the branch that
 *  knows its tracks keep bare ids — not a second time as a plain subfolder. */
test('bundled is listed once, as itself', () => {
  const names = listPlaylists().map((entry) => entry.name);
  assert.equal(names.filter((name) => name === 'bundled').length, 1);
  assert.deepEqual(tracksIn('bundled'), ['shipped.mid']);
  assert.ok(!playableTracks().includes('bundled/shipped.mid'));
});

test('an empty playlist is still offered, so the README can point at one', () => {
  const empty = listPlaylists().find((entry) => entry.name === 'empty-one');
  assert.equal(empty?.count, 0);
  assert.ok(isPlaylist('empty-one'));
});

/** The product's one premise is that a silence means an agent needs you. A playlist that
 *  played nothing would be a silence that means nothing, which is worse than ignoring the
 *  setting — so an empty choice falls back rather than going quiet. */
test('an empty playlist falls back to the bundled music instead of silence', () => {
  assert.equal(tracksIn('empty-one').length, 0);
  assert.deepEqual(libraryFor('empty-one'), listTracks());
  assert.ok(libraryFor('empty-one').length > 0);
});

test('a playlist that was deleted under us falls back too', () => {
  assert.equal(tracksIn('deleted-while-running').length, 0);
  assert.deepEqual(libraryFor('deleted-while-running'), listTracks());
});

test('a track inside a playlist resolves, and loose files still do', () => {
  assert.equal(resolveTrack('roadtrip/one.mid'), join(dir, 'roadtrip', 'one.mid'));
  assert.equal(resolveTrack('loose.mid'), join(dir, 'loose.mid'));
  assert.equal(resolveTrack('shipped.mid'), join(bundledDir(), 'shipped.mid'));
});

/** resolveTrack is the boundary between a name a client sent and a file we read. It has to
 *  answer by recognising the name, never by joining it onto a directory and hoping. */
test('a request that is a path rather than a name resolves to nothing', () => {
  for (const attempt of [
    '../tracks.json',
    'roadtrip/../../tracks.json',
    '../../../../Windows/win.ini',
    'roadtrip/notes.txt',
    'roadtrip/missing.mid',
    'no-such-playlist/one.mid',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'roadtrip\\one.mid',
    '',
    '/one.mid',
  ]) {
    assert.equal(resolveTrack(attempt), null, `${attempt} resolved to a real path`);
  }
});

test('a playlist name that is a traversal attempt is not a playlist', () => {
  assert.equal(isPlaylist('..'), false);
  assert.deepEqual(tracksIn('..'), []);
  assert.deepEqual(tracksIn('../..'), []);
});

test('shipped files keep their bare names so their licence records still apply', () => {
  const shipped = listTracks();
  const everything = playableTracks();
  assert.ok(shipped.length > 0);
  for (const file of shipped) assert.ok(everything.includes(file));
  assert.deepEqual(everything.slice(0, shipped.length), shipped);
  assert.equal(playlistOf(shipped[0] as string), 'bundled');
  assert.equal(playlistOf('roadtrip/one.mid'), 'roadtrip');
});

test('everything in a playlist is offered by the combined view', () => {
  const everything = playableTracks();
  assert.ok(everything.includes('roadtrip/one.mid'));
  assert.ok(everything.includes('loose.mid'));
  assert.deepEqual(libraryFor('all'), everything);
});
