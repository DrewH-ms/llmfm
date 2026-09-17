/** The startup sting: Beethoven's fate motif, played once before the transport takes over.
 *
 *  It is transcribed here rather than lifted from the loaded track, so the sting is the
 *  same four notes whatever is about to play — a signature, not a preview. Lifting it
 *  meant the sting changed with the playlist, and a track with no parsed score got none.
 *
 *  Licensing: the 1808 composition is public domain, and four notes written as MIDI
 *  numbers copy nobody's engraving. */

import { CC_CHANNEL_VOLUME, MOTIF_TAIL_SECONDS } from './constants.ts';
import { channelVolume } from './mixer.ts';
import { controlChange, noteOff, noteOn, programChange, silenceChannel } from './midi-out.ts';
import type { MidiOut } from './midi-out.ts';

export type StartupMotif = {
  /** Ends the sting early and hands over. Idempotent, and safe once it has finished. */
  cancel(): void;
};

export type MotifNote = {
  time: number;
  duration: number;
  midi: number;
  velocity: number;
  channel: number;
  program: number;
};

const MS_PER_SECOND = 1000;

const G = 67;
const E_FLAT = 63;
const OCTAVE = 12;
const HELD_INDEX = 3;

const STRING_ENSEMBLE = 48;
const CLARINET = 71;

/** Three shorts and a long, with the rests either side left out: a sting announces itself
 *  at once rather than opening with silence, and the held note carries the fermata. */
const SHORT_GAP = 0.17;
const SHORT_LENGTH = 0.15;
const HELD_LENGTH = 1.5;
const FORTISSIMO = 112;

/** Unison and octaves across three voices, as Beethoven scores it. A single line on a
 *  General MIDI synth is thin enough to read as a fault. */
const VOICES: readonly { channel: number; program: number; transpose: number }[] = [
  { channel: 0, program: STRING_ENSEMBLE, transpose: 0 },
  { channel: 1, program: STRING_ENSEMBLE, transpose: -OCTAVE },
  { channel: 2, program: CLARINET, transpose: 0 },
];

export const FATE_MOTIF: readonly MotifNote[] = VOICES.flatMap((voice) =>
  [G, G, G, E_FLAT].map((pitch, index) => ({
    time: index * SHORT_GAP,
    duration: index === HELD_INDEX ? HELD_LENGTH : SHORT_LENGTH,
    midi: pitch + voice.transpose,
    velocity: FORTISSIMO,
    channel: voice.channel,
    program: voice.program,
  })),
);


/**
 * Plays the opening figure and then calls `onDone`, which is where the caller starts the
 * real performance. Returns immediately; nothing here blocks startup, and a dead MIDI
 * bridge only means the sting is inaudible rather than that the daemon fails.
 *
 * The motif drives its channels directly, before the mixer holds any part, so the caller
 * must not bind the score until `onDone` — otherwise the mixer's opening fade would write
 * CC7 over the sting mid-phrase.
 */
export function playStartupMotif(options: {
  midi: MidiOut;
  masterVolume: number;
  onDone: () => void;
  notes?: readonly MotifNote[];
}): StartupMotif {
  const { midi, masterVolume, onDone, notes = FATE_MOTIF } = options;
  const channels = new Set(notes.map((note) => note.channel));

  const timers = new Set<NodeJS.Timeout>();
  let finished = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const channel of channels) silenceChannel(midi, channel);
    onDone();
  };

  if (notes.length === 0) {
    finish();
    return { cancel: finish };
  }

  for (const channel of channels) {
    controlChange(midi, {
      channel,
      controller: CC_CHANNEL_VOLUME,
      value: channelVolume({ level: 1, masterVolume }),
    });
  }
  for (const note of notes) {
    programChange(midi, { channel: note.channel, program: note.program });
  }

  for (const note of notes) {
    const onTimer = setTimeout(() => {
      timers.delete(onTimer);
      noteOn(midi, { channel: note.channel, note: note.midi, velocity: note.velocity });
      const offTimer = setTimeout(() => {
        timers.delete(offTimer);
        noteOff(midi, { channel: note.channel, note: note.midi });
      }, note.duration * MS_PER_SECOND);
      timers.add(offTimer);
    }, note.time * MS_PER_SECOND);
    timers.add(onTimer);
  }

  const last = notes.reduce((latest, note) => Math.max(latest, note.time + note.duration), 0);
  const endTimer = setTimeout(finish, (last + MOTIF_TAIL_SECONDS) * MS_PER_SECOND);
  timers.add(endTimer);

  return { cancel: finish };
}
