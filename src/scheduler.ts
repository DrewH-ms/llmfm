import { LOOKAHEAD_SECONDS, SCHEDULER_TICK_MS } from './constants.ts';
import { noteOff, noteOn } from './midi-out.ts';
import type { MidiOut } from './midi-out.ts';
import type { Mixer } from './mixer.ts';
import type { Score, ScoredNote, TransportState } from './types.ts';

export type Scheduler = {
  load(score: Score): void;
  /** Resumes from the frozen position. */
  play(): void;
  /** Freezes position and stops scheduling. Does NOT fade — the mixer owns loudness. */
  pause(): void;
  state(): TransportState;
  stop(): void;
};

const MS_PER_SECOND = 1000;
const NS_PER_MS = 1000000n;
/** A note whose moment slipped past by more than a tick is stale; firing it would bunch
 *  several notes onto the same instant. */
const LATE_NOTE_TOLERANCE_MS = SCHEDULER_TICK_MS * 2;

const monotonicSeconds = (): number =>
  Number(process.hrtime.bigint() / NS_PER_MS) / MS_PER_SECOND;

export function createScheduler(options: { midi: MidiOut; mixer: Mixer }): Scheduler {
  const { midi, mixer } = options;

  let notes: ScoredNote[] = [];
  let duration = 0;

  let playing = false;
  /** Seconds into the piece, authoritative only while paused. */
  let position = 0;
  /** Monotonic time that the start of the piece maps to. */
  let anchor = 0;
  let cursor = 0;
  let tick: NodeJS.Timeout | null = null;

  const timers = new Set<NodeJS.Timeout>();
  const sounding = new Set<ScoredNote>();

  const elapsed = (): number => monotonicSeconds() - anchor;

  const releaseSounding = (): void => {
    for (const note of sounding) noteOff(midi, { channel: note.channel, note: note.midi });
    sounding.clear();
  };

  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  const scheduleNote = (note: ScoredNote, delayMs: number): void => {
    const onTimer = setTimeout(() => {
      timers.delete(onTimer);
      if (!playing || !mixer.isPartAudible(note.partId)) return;

      noteOn(midi, { channel: note.channel, note: note.midi, velocity: note.velocity });
      sounding.add(note);

      const offTimer = setTimeout(() => {
        timers.delete(offTimer);
        sounding.delete(note);
        noteOff(midi, { channel: note.channel, note: note.midi });
      }, note.duration * MS_PER_SECOND);
      timers.add(offTimer);
    }, Math.max(0, delayMs));
    timers.add(onTimer);
  };

  /** Commits only the next `LOOKAHEAD_SECONDS` of notes, so pausing is a matter of
   *  freezing the playhead rather than unwinding the whole piece. */
  const pump = (): void => {
    if (!playing) return;

    const now = monotonicSeconds();
    const horizon = now - anchor + LOOKAHEAD_SECONDS;

    while (cursor < notes.length) {
      const note = notes[cursor];
      if (!note || note.time > horizon) break;
      cursor += 1;

      const delayMs = (anchor + note.time - now) * MS_PER_SECOND;
      if (delayMs < -LATE_NOTE_TOLERANCE_MS) continue;
      if (!mixer.isPartAudible(note.partId)) continue;
      scheduleNote(note, delayMs);
    }

    if (cursor >= notes.length && now - anchor >= duration) {
      anchor = now;
      cursor = 0;
    }
    position = now - anchor;
  };

  const seekCursorTo = (seconds: number): void => {
    cursor = notes.findIndex((note) => note.time >= seconds);
    if (cursor === -1) cursor = notes.length;
  };

  return {
    load(score: Score): void {
      clearTimers();
      releaseSounding();
      notes = score.notes;
      duration = score.duration;
      position = 0;
      cursor = 0;
    },

    play(): void {
      if (playing || notes.length === 0) return;
      playing = true;
      anchor = monotonicSeconds() - position;
      seekCursorTo(position);
      if (tick === null) tick = setInterval(pump, SCHEDULER_TICK_MS);
    },

    pause(): void {
      if (!playing) return;
      position = elapsed();
      playing = false;
      if (tick !== null) {
        clearInterval(tick);
        tick = null;
      }
      clearTimers();
      releaseSounding();
    },

    state(): TransportState {
      return { playing, position: playing ? elapsed() : position, duration };
    },

    stop(): void {
      if (tick !== null) {
        clearInterval(tick);
        tick = null;
      }
      playing = false;
      clearTimers();
      releaseSounding();
      position = 0;
      cursor = 0;
    },
  };
}
