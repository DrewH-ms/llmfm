import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadScore } from './score.ts';
import { openingMotif } from './motif.ts';
import { MOTIF_ONSET_COUNT } from './constants.ts';

const TRACK = join(import.meta.dirname, '..', 'tracks', 'beethoven5.mid');

test('the motif is the real opening of the bundled track', () => {
  const score = loadScore(TRACK);
  const motif = openingMotif(score);
  const onsets = [...new Set(motif.map((note) => note.time))].sort((a, b) => a - b);

  assert.equal(onsets.length, MOTIF_ONSET_COUNT);
  assert.equal(onsets[0], 0, 'the leading rest must be trimmed or the sting starts late');

  // Three short repeated notes and a long one held: the shape is the whole point, so a
  // track whose opening is not that should be caught here rather than by ear.
  const heldStart = onsets[MOTIF_ONSET_COUNT - 1]!;
  const held = motif.filter((note) => note.time === heldStart);
  const short = motif.filter((note) => note.time < heldStart);
  const longestShort = Math.max(...short.map((note) => note.duration));
  assert.ok(held.every((note) => note.duration > longestShort * 2));

  // Beethoven's opening is six parts in unison and octaves; taking four notes rather than
  // four attacks would leave one bare line.
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
