import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FATE_MOTIF } from './motif.ts';

const onsets = (): number[] => [...new Set(FATE_MOTIF.map((note) => note.time))].sort((a, b) => a - b);

const pitchesAt = (time: number): number[] =>
  [...new Set(FATE_MOTIF.filter((note) => note.time === time).map((note) => note.midi))].sort(
    (a, b) => a - b,
  );

test('the sting is three short notes and one held', () => {
  const times = onsets();
  assert.equal(times.length, 4);
  assert.equal(times[0], 0, 'a sting that opens with a rest reads as a fault');

  const last = times[3] as number;
  const held = FATE_MOTIF.filter((note) => note.time === last);
  const shorts = FATE_MOTIF.filter((note) => note.time !== last);
  for (const note of held) {
    for (const short of shorts) assert.ok(note.duration > short.duration);
  }
});

test('the sting is Beethoven, not whatever track is loaded', () => {
  const [first, second, third, fourth] = onsets().map(pitchesAt);
  assert.deepEqual(second, first, 'the first three notes are one repeated pitch');
  assert.deepEqual(third, first);
  // A major third down, which is the interval that makes the figure recognisable.
  assert.deepEqual(
    fourth,
    (first as number[]).map((pitch) => pitch - 4),
  );
});

test('the sting is doubled, so it does not sound like one thin line', () => {
  assert.ok(new Set(FATE_MOTIF.map((note) => note.channel)).size > 1);
  assert.ok(new Set(FATE_MOTIF.map((note) => note.program)).size > 1);
  assert.ok(pitchesAt(0).length > 1, 'unison alone carries less weight than octaves');
});
