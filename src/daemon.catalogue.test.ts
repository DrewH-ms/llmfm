import test from 'node:test';
import assert from 'node:assert/strict';
import { trackCatalogue, listTracks, playableTracks, resolveTrack } from './daemon.ts';
import { DEFAULT_TRACK } from './constants.ts';

const MAX_HOLD_MUSIC_VOICES = 2;

test('the catalogue covers every playable file exactly once', () => {
  const files = trackCatalogue().map((entry) => entry.file);
  assert.deepEqual([...files].sort(), [...playableTracks()].sort());
  assert.equal(new Set(files).size, files.length);
});

test('every shipped entry carries the provenance the UI shows', () => {
  const shipped = new Set(listTracks());
  for (const entry of trackCatalogue().filter((candidate) => shipped.has(candidate.file))) {
    assert.ok(entry.title, `${entry.file} has no title`);
    assert.ok(entry.composer, `${entry.file} has no composer`);
    assert.ok(entry.licenceId, `${entry.file} has no licence`);
    assert.equal(entry.format, 'mid', `${entry.file} is not a format the gate can work on`);
  }
});

/** A licence record describes bytes, not a filename. Overwriting a curated file leaves the
 *  record behind, still asserting a licence for music it was never written against. */
test('every shipped file still hashes to the record that licensed it', () => {
  const shipped = new Set(listTracks());
  for (const entry of trackCatalogue().filter((candidate) => shipped.has(candidate.file))) {
    assert.equal(
      entry.integrity,
      'verified',
      `${entry.file} is ${entry.integrity}: its licence record does not describe the bytes on disk`,
    );
  }
});

test('an unrecorded file is reported as unrecorded rather than as licensed bytes', () => {
  const recorded = new Set(listTracks());
  for (const entry of trackCatalogue().filter((candidate) => !recorded.has(candidate.file))) {
    assert.equal(entry.integrity, 'unrecorded', `${entry.file} claims a verified digest`);
  }
});

test('a name we do not offer never resolves to a path', () => {
  for (const attempt of [
    '../package.json',
    '..\\package.json',
    'C:\\Windows\\win.ini',
    '/etc/passwd',
    'tracks/../src/daemon.ts',
    '',
    'no-such-file.mid',
  ]) {
    assert.equal(resolveTrack(attempt), null, `${attempt} should not resolve`);
  }
});

test('every shipped name resolves to a file we can read', () => {
  for (const file of listTracks()) assert.ok(resolveTrack(file));
});

test('hold-music-only marks the files with too few voices, and hides none of them', () => {
  const catalogue = trackCatalogue();
  for (const entry of catalogue) {
    assert.equal(
      entry.holdMusicOnly,
      entry.voiceCount <= MAX_HOLD_MUSIC_VOICES,
      `${entry.file} is marked inconsistently with its ${entry.voiceCount} voices`,
    );
  }
  assert.ok(
    catalogue.some((entry) => !entry.holdMusicOnly),
    'nothing in the library can carry an ensemble',
  );
});

test('the default track is an ensemble, not hold music', () => {
  const entry = trackCatalogue().find((candidate) => candidate.file === DEFAULT_TRACK);
  assert.ok(entry, `${DEFAULT_TRACK} is missing from the catalogue`);
  assert.equal(entry.holdMusicOnly, false);
});
