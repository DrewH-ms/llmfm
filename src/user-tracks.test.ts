import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** LLMFM_HOME is what every path in the install hangs off, so pointing it at a temp tree
 *  keeps the test off the real install — this one creates directories, and a test must
 *  never write into a user's actual music folder. */
const home = mkdtempSync(join(tmpdir(), 'llmfm-user-tracks-'));
process.env['LLMFM_HOME'] = home;

const { ensurePlaylistsDir, listUserTracks, listUserPlaylists, listUserPlaylistTracks } =
  await import('./user-tracks.ts');
const { playlistsDir } = await import('./paths.ts');
const { PLAYLIST_README, PLAYLIST_EXAMPLE, PLAYLIST_BUNDLED } = await import('./constants.ts');

test('the music lives with the install, not in Copilot\'s own directory', () => {
  assert.equal(playlistsDir(), join(home, 'playlists'));
});

test('listing a folder that does not exist yet is empty, not an error', () => {
  // The daemon lists tracks before anything has created the folder.
  assert.deepEqual(listUserTracks(), []);
});

test('the folder is created so the instruction to drop files in it is not a dead end', () => {
  const dir = ensurePlaylistsDir();
  assert.equal(dir, playlistsDir());
  assert.deepEqual(listUserTracks(), []);
  assert.doesNotThrow(() => ensurePlaylistsDir());
});

test('only playable files are listed, sorted, whatever else is in the folder', () => {
  const dir = ensurePlaylistsDir();
  for (const name of ['b.mid', 'a.MIDI', 'd.WAV', 'c.mp3', 'notes.txt', 'cover.png', 'song.flac']) {
    writeFileSync(join(dir, name), '');
  }
  mkdirSync(join(dir, 'subfolder'), { recursive: true });
  assert.deepEqual(listUserTracks(), ['a.MIDI', 'b.mid', 'c.mp3', 'd.WAV']);
});

test('a folder convention nobody can see is no convention, so both are scaffolded', () => {
  const dir = ensurePlaylistsDir();
  assert.ok(existsSync(join(dir, PLAYLIST_README)));
  assert.ok(listUserPlaylists().includes(PLAYLIST_EXAMPLE));
  assert.deepEqual(listUserPlaylistTracks(PLAYLIST_EXAMPLE), []);
});

/** The shipped folder is listed by the branch that keeps its ids bare. Coming back a
 *  second time as a plain subfolder would offer every shipped track under two names. */
test('the bundled folder is not enumerated as a user playlist', () => {
  mkdirSync(join(playlistsDir(), PLAYLIST_BUNDLED), { recursive: true });
  assert.ok(!listUserPlaylists().includes(PLAYLIST_BUNDLED));
  assert.deepEqual(listUserPlaylistTracks(PLAYLIST_BUNDLED), []);
});

test('notes a user added to the README survive the next startup', () => {
  const dir = ensurePlaylistsDir();
  const readme = join(dir, PLAYLIST_README);
  writeFileSync(readme, 'my own notes');
  ensurePlaylistsDir();
  assert.equal(readFileSync(readme, 'utf8'), 'my own notes');
});

test('a playlist lists only playable files, and a stray name reads as no playlist', () => {
  const dir = ensurePlaylistsDir();
  mkdirSync(join(dir, 'roadtrip'), { recursive: true });
  writeFileSync(join(dir, 'roadtrip', 'b.mid'), '');
  writeFileSync(join(dir, 'roadtrip', 'a.wav'), '');
  writeFileSync(join(dir, 'roadtrip', 'sleeve.png'), '');
  assert.deepEqual(listUserPlaylistTracks('roadtrip'), ['a.wav', 'b.mid']);
  assert.deepEqual(listUserPlaylistTracks('..'), []);
  assert.deepEqual(listUserPlaylistTracks('nope'), []);
});

test('a loose file is not mistaken for a playlist, nor a playlist for a track', () => {
  assert.ok(!listUserPlaylists().includes('b.mid'));
  assert.ok(!listUserTracks().includes('roadtrip'));
});

test.after(() => rmSync(home, { recursive: true, force: true }));
