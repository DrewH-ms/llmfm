import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** COPILOT_HOME is what install.ts reads, so pointing it at a temp tree keeps the test off
 *  the real ~/.copilot folder — this one creates directories, and a test must never write
 *  into a user's actual install. */
const home = mkdtempSync(join(tmpdir(), 'llmfm-user-tracks-'));
process.env.COPILOT_HOME = home;

const { userTracksDir, ensureUserTracksDir, listUserTracks, listUserPlaylists, listUserPlaylistTracks } =
  await import('./user-tracks.ts');
const { PLAYLIST_README, PLAYLIST_EXAMPLE } = await import('./constants.ts');

test('the folder sits beside the config, not inside the install', () => {
  assert.equal(userTracksDir(), join(home, 'llmfm-tracks'));
});

test('listing a folder that does not exist yet is empty, not an error', () => {
  // The daemon lists tracks before anything has created the folder.
  assert.deepEqual(listUserTracks(), []);
});

test('the folder is created so the instruction to drop files in it is not a dead end', () => {
  const dir = ensureUserTracksDir();
  assert.equal(dir, userTracksDir());
  assert.deepEqual(listUserTracks(), []);
  assert.doesNotThrow(() => ensureUserTracksDir());
});

test('only playable files are listed, sorted, whatever else is in the folder', () => {
  const dir = ensureUserTracksDir();
  for (const name of ['b.mid', 'a.MIDI', 'd.WAV', 'c.mp3', 'notes.txt', 'cover.png', 'song.flac']) {
    writeFileSync(join(dir, name), '');
  }
  mkdirSync(join(dir, 'subfolder'), { recursive: true });
  assert.deepEqual(listUserTracks(), ['a.MIDI', 'b.mid', 'c.mp3', 'd.WAV']);
});

test('a folder convention nobody can see is no convention, so both are scaffolded', () => {
  const dir = ensureUserTracksDir();
  assert.ok(existsSync(join(dir, PLAYLIST_README)));
  assert.ok(listUserPlaylists().includes(PLAYLIST_EXAMPLE));
  assert.deepEqual(listUserPlaylistTracks(PLAYLIST_EXAMPLE), []);
});

test('notes a user added to the README survive the next startup', () => {
  const dir = ensureUserTracksDir();
  const readme = join(dir, PLAYLIST_README);
  writeFileSync(readme, 'my own notes');
  ensureUserTracksDir();
  assert.equal(readFileSync(readme, 'utf8'), 'my own notes');
});

test('a playlist lists only playable files, and a stray name reads as no playlist', () => {
  const dir = ensureUserTracksDir();
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
