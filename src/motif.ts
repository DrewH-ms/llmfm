/** The startup sting: the score's own opening figure, played once before the transport
 *  takes over. It is lifted from the loaded track rather than transcribed, so it is
 *  always the piece the listener is about to hear. */

import { CC_CHANNEL_VOLUME, MOTIF_ONSET_COUNT, MOTIF_TAIL_SECONDS } from './constants.ts';
import { channelVolume } from './mixer.ts';
import { controlChange, noteOff, noteOn, programChange, silenceChannel } from './midi-out.ts';
import type { MidiOut } from './midi-out.ts';
import type { Score, ScoredNote } from './types.ts';

export type StartupMotif = {
  /** Ends the sting early and hands over. Idempotent, and safe once it has finished. */
  cancel(): void;
};

const MS_PER_SECOND = 1000;

/**
 * The notes of the score's first `MOTIF_ONSET_COUNT` attacks, retimed to begin at zero.
 *
 * Counting attacks rather than notes keeps the doubling intact: Beethoven's opening is
 * six parts in unison and octaves, and taking four notes would leave a single line.
 */
export function openingMotif(score: Score): ScoredNote[] {
  const onsets: number[] = [];
  for (const note of score.notes) {
    if (onsets.at(-1) !== note.time) onsets.push(note.time);
    if (onsets.length > MOTIF_ONSET_COUNT) break;
  }
  const start = onsets[0];
  if (start === undefined) return [];
  const end = onsets[MOTIF_ONSET_COUNT] ?? Number.POSITIVE_INFINITY;
  return score.notes
    .filter((note) => note.time < end)
    .map((note) => ({ ...note, time: note.time - start }));
}

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
  score: Score;
  masterVolume: number;
  onDone: () => void;
}): StartupMotif {
  const { midi, score, masterVolume, onDone } = options;
  const notes = openingMotif(score);
  const partOf = new Map(score.parts.map((part) => [part.partId, part]));
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
    const part = partOf.get(note.partId);
    if (part && !part.percussion) {
      programChange(midi, { channel: note.channel, program: part.program });
    }
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
