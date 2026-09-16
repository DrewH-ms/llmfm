import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadScore } from './score.ts';
import { openingMotif } from './motif.ts';
import { MOTIF_ONSET_COUNT, DEFAULT_TRACK } from './constants.ts';

const TRACK = join(import.meta.dirname, '..', 'playlists', 'bundled', DEFAULT_TRACK);

test('the motif is the real opening of the bundled track', () => {
  const score = loadScore(TRACK);
  const motif = openingMotif(score);
  const onsets = [...new Set(motif.map((note) => note.time))].sort((a, b) => a - b);

  assert.equal(onsets.length, MOTIF_ONSET_COUNT);
  assert.equal(onsets[0], 0, 'the leading rest must be trimmed or the sting starts late');

  // Deliberately not asserting a rhythmic shape. "Three short notes and one held" is
  // Beethoven's opening, not a property of openingMotif, and pinning it here made the
  // suite fail whenever the default track changed — which says nothing about this code.
  // Counting attacks rather than notes: an orchestral opening is several parts moving
  // together, and taking four notes instead of four attacks would leave one bare line.
  const pitches = new Set(motif.map((note) => note.midi));
  assert.ok(pitches.size > 1);
  assert.ok(new Set(motif.map((note) => note.channel)).size > 1);
});

test('the motif borrows from the score without disturbing it', () => {
  const score = loadScore(TRACK);
  const before = score.notes.map((note) => note.time);
  openingMotif(score);
  assert.deepEqual(
    score.notes.map((note) => note.time),
    before,
  );
});

test('a score with no notes yields no motif rather than throwing', () => {
  assert.deepEqual(
    openingMotif({ name: 'empty', duration: 0, parts: [], notes: [] }),
    [],
  );
});
