import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from './scheduler.ts';
import { MIDI_NOTE_OFF, MIDI_NOTE_ON } from './constants.ts';
import type { MidiOut } from './midi-out.ts';
import type { Mixer } from './mixer.ts';
import type { Score, ScoredNote } from './types.ts';

const STATUS_MASK = 0xf0;
const CHANNEL_MASK = 0x0f;
const DATA1_SHIFT = 8;
const DATA1_MASK = 0x7f;

type Sent = { status: number; channel: number; note: number };

function recordingMidi(): { midi: MidiOut; sent: Sent[] } {
  const sent: Sent[] = [];
  const midi: MidiOut = {
    start: () => Promise.resolve({ ready: true, device: 'test', error: null }),
    send(message: number): void {
      sent.push({
        status: message & STATUS_MASK,
        channel: message & CHANNEL_MASK,
        note: (message >> DATA1_SHIFT) & DATA1_MASK,
      });
    },
    status: () => ({ ready: true, device: 'test', error: null }),
    stop: () => {},
  };
  return { midi, sent };
}

/** Everything audible: the gate is the orchestrator's business, not the transport's. */
const openMixer: Mixer = {
  bindScore: () => {},
  setPartAudible: () => {},
  isPartAudible: () => true,
  anyAudible: () => true,
  anyGateOpen: () => true,
  setMasterVolume: () => {},
  silenceAll: () => {},
  stop: () => {},
};

const note = (overrides: Partial<ScoredNote>): ScoredNote => ({
  time: 0,
  duration: 1,
  midi: 60,
  velocity: 80,
  channel: 0,
  partId: 'p1',
  ...overrides,
});

const score = (name: string, notes: ScoredNote[], duration: number): Score => ({
  name,
  duration,
  parts: [
    { partId: 'p1', name: 'Test', program: 0, scoredProgram: 0, channel: 0, percussion: false, notes },
  ],
  notes,
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every note-on must be answered on the same channel and pitch, or the synth holds it until restart. */
const unmatched = (sent: Sent[]): Sent[] => {
  const held: Sent[] = [];
  for (const message of sent) {
    if (message.status === MIDI_NOTE_ON) held.push(message);
    if (message.status === MIDI_NOTE_OFF) {
      const index = held.findIndex(
        (on) => on.channel === message.channel && on.note === message.note,
      );
      if (index >= 0) held.splice(index, 1);
    }
  }
  return held;
};

test('a score that runs out fires onEnd and keeps looping', async () => {
  const { midi } = recordingMidi();
  const scheduler = createScheduler({ midi, mixer: openMixer });
  let ends = 0;
  scheduler.onEnd(() => {
    ends += 1;
  });

  try {
    scheduler.load(score('short', [note({ time: 0, duration: 0.02 })], 0.05));
    scheduler.play();
    await wait(250);
  } finally {
    scheduler.stop();
  }

  assert.ok(ends >= 1, `expected onEnd to fire, got ${ends}`);
});

test('onEnd listeners can be removed', async () => {
  const { midi } = recordingMidi();
  const scheduler = createScheduler({ midi, mixer: openMixer });
  let ends = 0;
  const unsubscribe = scheduler.onEnd(() => {
    ends += 1;
  });
  unsubscribe();

  try {
    scheduler.load(score('short', [note({ time: 0, duration: 0.02 })], 0.05));
    scheduler.play();
    await wait(200);
  } finally {
    scheduler.stop();
  }

  assert.equal(ends, 0);
});

test('swapping scores mid-note leaves nothing sounding', async () => {
  const { midi, sent } = recordingMidi();
  const scheduler = createScheduler({ midi, mixer: openMixer });
  try {
    const longNotes = [
      note({ time: 0, duration: 30, midi: 60, channel: 0 }),
      note({ time: 0, duration: 30, midi: 67, channel: 1 }),
    ];
    scheduler.load(score('current', longNotes, 30));
    scheduler.play();
    await wait(120);
    assert.ok(
      sent.some((message) => message.status === MIDI_NOTE_ON),
      'expected the first score to be sounding before the swap',
    );

    scheduler.load(score('next', [note({ time: 0, duration: 30, midi: 72, channel: 2 })], 30));
    assert.deepEqual(unmatched(sent), [], 'notes from the outgoing score were never released');

    scheduler.play();
    await wait(120);
  } finally {
    scheduler.stop();
  }
  assert.deepEqual(unmatched(sent), [], 'notes were left sounding after stop');
});

test('an end-of-score listener that loads another score does not strand its notes', async () => {
  const { midi, sent } = recordingMidi();
  const scheduler = createScheduler({ midi, mixer: openMixer });
  const outgoing = { channel: 0, midi: 60 };
  let swapped = false;
  try {
    const nextScore = score('next', [note({ time: 0, duration: 30, midi: 72, channel: 2 })], 30);
    scheduler.onEnd(() => {
      if (swapped) return;
      swapped = true;
      scheduler.pause();
      scheduler.load(nextScore);
      scheduler.play();
    });

    scheduler.load(
      score('current', [note({ time: 0, duration: 30, ...outgoing })], 0.05),
    );
    scheduler.play();
    await wait(300);

    assert.ok(swapped, 'expected the end of the score to trigger the swap');
    assert.ok(scheduler.state().playing, 'the next score should still be running');
    // The incoming note is meant to be sounding; only the one swapped away from must have been let go.
    assert.deepEqual(
      unmatched(sent).filter(
        (held) => held.channel === outgoing.channel && held.note === outgoing.midi,
      ),
      [],
      'the note from the outgoing score was left hanging',
    );
  } finally {
    scheduler.stop();
  }
  assert.deepEqual(unmatched(sent), []);
});

/** An empty note list used to return from play() without starting the tick, killing autoplay rotation for the rest of the process. */
test('a score with no notes still runs the transport so rotation survives', async () => {
  const { midi } = recordingMidi();
  const scheduler = createScheduler({ midi, mixer: openMixer });
  let ends = 0;
  scheduler.onEnd(() => {
    ends += 1;
  });

  try {
    scheduler.load(score('empty', [], 0));
    scheduler.play();
    assert.ok(scheduler.state().playing, 'the transport never started');
    await wait(150);
  } finally {
    scheduler.stop();
  }

  assert.ok(ends >= 1, `expected onEnd to fire so the next track can load, got ${ends}`);
});
