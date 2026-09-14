import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import type { Track } from '@tonejs/midi';
import { MAX_MIDI_VALUE, MELODIC_CHANNELS, MIN_NOTE_DURATION_SECONDS, PERCUSSION_CHANNEL } from './constants.ts';
import type { Part, Score, ScoredNote } from './types.ts';

/** @tonejs/midi ships a UMD bundle, so Node's ESM loader cannot see its named exports. */
const { Midi } = createRequire(import.meta.url)('@tonejs/midi') as typeof import('@tonejs/midi');

const MIN_MIDI_VELOCITY = 1;
/** Where melodic parts land once every channel is taken; they lose independent gating. */
const OVERFLOW_CHANNEL = MELODIC_CHANNELS.at(-1)!;
const PERCUSSION_PART_NAME = 'Percussion';

function partName(track: Track, index: number): string {
  const named = track.name.trim() || track.instrument.name?.trim();
  if (named) return named;
  return track.instrument.percussion ? PERCUSSION_PART_NAME : `Track ${index + 1}`;
}

/** Stable across runs of the same file: track order within a MIDI file is fixed, and the
 *  name and program distinguish parts a listener would confuse (Violin I vs Violin II). */
function partId(name: string, program: number, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `t${String(index).padStart(2, '0')}-${slug}-p${program}`;
}

function scoreNote(
  note: Track['notes'][number],
  channel: number,
  partIdentifier: string,
): ScoredNote {
  const velocity = Math.round(note.velocity * MAX_MIDI_VALUE);
  return {
    time: note.time,
    duration: Math.max(MIN_NOTE_DURATION_SECONDS, note.duration),
    midi: note.midi,
    velocity: Math.min(MAX_MIDI_VALUE, Math.max(MIN_MIDI_VELOCITY, velocity)),
    channel,
    partId: partIdentifier,
  };
}

/** Busiest first, so the parts that carry the piece are the ones that get a channel of
 *  their own. Ties break on track order to keep the allocation reproducible. */
function melodicChannels(tracks: { track: Track; index: number }[]): Map<number, number> {
  const byPresence = [...tracks].sort(
    (a, b) => b.track.notes.length - a.track.notes.length || a.index - b.index,
  );
  return new Map(
    byPresence.map(({ index }, rank) => [index, MELODIC_CHANNELS[rank] ?? OVERFLOW_CHANNEL]),
  );
}

/**
 * Reads a MIDI file into the scheduler's input form, binding every part to its own MIDI
 * channel so a part can be faded independently of the rest of the orchestra.
 *
 * Only 15 melodic channels exist. Parts past that still play, but share the overflow
 * channel and can only be gated together; callers see that as more than one part
 * reporting the same channel, which percussion parts always do.
 */
export function loadScore(filePath: string): Score {
  const midi = new Midi(readFileSync(filePath));
  const voiced = midi.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.notes.length > 0);
  const channelOf = melodicChannels(voiced.filter(({ track }) => !track.instrument.percussion));

  const parts = voiced.map(({ track, index }): Part => {
    const percussion = track.instrument.percussion;
    const channel = percussion ? PERCUSSION_CHANNEL : (channelOf.get(index) ?? OVERFLOW_CHANNEL);
    const name = partName(track, index);
    const id = partId(name, track.instrument.number, index);
    return {
      partId: id,
      name,
      program: track.instrument.number,
      channel,
      percussion,
      notes: track.notes.map((note) => scoreNote(note, channel, id)),
    };
  });

  const notes = parts.flatMap((part) => part.notes).sort((a, b) => a.time - b.time);
  return { name: basename(filePath), duration: midi.duration, parts, notes };
}
