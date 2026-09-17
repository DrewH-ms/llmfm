import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVoiceTree, classifyPart } from './voices.ts';
import type { Part, Score, ScoredNote } from './types.ts';

const DURATION = 200;

/** Notes fill `spans` one per second, so continuity comes from which stretches a part gets, not note count. */
function partOf(options: {
  partId: string;
  name: string;
  program: number;
  channel: number;
  spans: [number, number][];
  midi?: number;
  percussion?: boolean;
}): Part {
  const { partId, name, program, channel, spans, midi = 60, percussion = false } = options;
  const notes: ScoredNote[] = [];
  for (const [from, to] of spans) {
    for (let time = from; time < to; time += 1) {
      notes.push({ time, duration: 0.9, midi, velocity: 0.7, channel, partId });
    }
  }
  return { partId, name, program, scoredProgram: program, channel, percussion, notes };
}

function scoreOf(parts: Part[]): Score {
  return {
    name: 'test',
    duration: DURATION,
    parts,
    notes: parts.flatMap((part) => part.notes).sort((a, b) => a.time - b.time),
  };
}

test('an unrecognised melodic program is classified by range, not left unsorted', () => {
  const cases: [number, string][] = [
    [38, 'Bass'],
    [81, 'Synth'],
    [89, 'Synth'],
    [99, 'Synth'],
    [26, 'Guitar'],
    [48, 'Strings'],
    [71, 'Woodwinds'],
  ];
  for (const [program, expected] of cases) {
    const part = partOf({ partId: 'p', name: '', program, channel: 0, spans: [[0, 10]] });
    assert.equal(classifyPart(part).section, expected, `program ${program}`);
  }
});

test('sound effects stay unsorted, because a noise cue is not a line to follow', () => {
  const part = partOf({ partId: 'p', name: '', program: 123, channel: 0, spans: [[0, 10]] });
  assert.equal(classifyPart(part).section, 'Other');
});

/** Filtering parts before grouping silently loses a whole section to backing, so one session gates a line while the mix plays on. */
test('parts too gappy alone are still offered as the section they add up to', () => {
  const score = scoreOf([
    partOf({ partId: 'a', name: '', program: 81, channel: 0, spans: [[0, 70]], midi: 72 }),
    partOf({ partId: 'b', name: '', program: 81, channel: 1, spans: [[70, 140]], midi: 76 }),
    partOf({ partId: 'c', name: '', program: 81, channel: 2, spans: [[140, 200]], midi: 79 }),
  ]);

  for (const part of score.parts) {
    const alone = buildVoiceTree(scoreOf([part]));
    assert.deepEqual(alone.voicesFor(1), [], `${part.partId} should not carry a voice alone`);
  }

  const tree = buildVoiceTree(score);
  const voices = tree.voicesFor(1);
  assert.equal(voices.length, 1);
  assert.deepEqual(voices[0]?.partIds, ['a', 'b', 'c']);
  assert.deepEqual(tree.backingPartIds, []);
});

test('a section that cannot be assembled from gappy parts stays backing', () => {
  const tree = buildVoiceTree(
    scoreOf([
      partOf({ partId: 'lead', name: '', program: 81, channel: 0, spans: [[0, 200]], midi: 72 }),
      partOf({ partId: 'stab', name: '', program: 38, channel: 1, spans: [[0, 20]], midi: 40 }),
    ]),
  );
  assert.deepEqual(tree.voicesFor(1).map((voice) => voice.partIds), [['lead']]);
  assert.deepEqual(tree.backingPartIds, ['stab']);
});

test('a voice is never offered a part whose own rests would read as a blocked agent', () => {
  const tree = buildVoiceTree(
    scoreOf([
      partOf({ partId: 'steady', name: '', program: 81, channel: 0, spans: [[0, 200]], midi: 72 }),
      partOf({ partId: 'gappy', name: '', program: 81, channel: 1, spans: [[0, 40]], midi: 76 }),
    ]),
  );
  const offered = tree.voicesFor(8);
  assert.ok(
    offered.every((voice) => voice.partIds.length !== 1 || voice.partIds[0] !== 'gappy'),
    'the gappy part must never stand as a voice of its own',
  );
});
