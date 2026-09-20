import test from 'node:test';
import assert from 'node:assert/strict';
import { trackCatalogue, listTracks, playableTracks, resolveTrack, shouldDuck } from './daemon.ts';
import { DEFAULT_TRACK } from './constants.ts';

const PHONE = { name: 'Pixel' };

/** v0.9.0 shipped ducking as a default, so every fresh install was silent until the user found a setting. */
test('nothing to gate means we play our own score', () => {
  assert.equal(shouldDuck({ bluetoothReceive: false, device: null }), false);
  assert.equal(shouldDuck({ bluetoothReceive: true, device: null }), false);
  assert.equal(shouldDuck({ bluetoothReceive: false, device: PHONE }), false);
});

/** The claim outlives the toggle on purpose, so the toggle alone has to be a way back to the score. */
test('only a phone we are both receiving and connected to takes the score away', () => {
  assert.equal(shouldDuck({ bluetoothReceive: true, device: PHONE }), true);
});

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
    assert.ok(
      ['mid', 'mp3', 'wav'].includes(entry.format),
      `${entry.file} is not a format the daemon can play`,
    );
  }
});

/** Recorded audio arrives as one finished stereo mix, so there is no part to hold back for a session. */
test('a recorded track is never offered as an ensemble', () => {
  for (const entry of trackCatalogue().filter((candidate) => candidate.format !== 'mid')) {
    assert.equal(entry.voiceCount, 0, `${entry.file} claims voices it cannot gate`);
    assert.ok(entry.holdMusicOnly, `${entry.file} is not marked hold-music-only`);
  }
});

/** A licence record describes bytes: overwriting a curated file leaves it asserting a licence for music it never covered. */
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
