import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** COPILOT_HOME is what install.ts reads, so pointing it at a temp tree keeps the test off
 *  the real ~/.copilot folder — this one creates directories, and a test must never write
 *  into a user's actual install. */
const home = mkdtempSync(join(tmpdir(), 'llmfm-user-tracks-'));
process.env.COPILOT_HOME = home;

const { userTracksDir, ensureUserTracksDir, listUserTracks } = await import('./user-tracks.ts');

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

test('only MIDI files are listed, sorted, whatever else is in the folder', () => {
  const dir = ensureUserTracksDir();
  for (const name of ['b.mid', 'a.MIDI', 'notes.txt', 'cover.png']) {
    writeFileSync(join(dir, name), '');
  }
  mkdirSync(join(dir, 'subfolder'), { recursive: true });
  assert.deepEqual(listUserTracks(), ['a.MIDI', 'b.mid']);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
