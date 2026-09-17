import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import type { Track } from '@tonejs/midi';
import { MAX_MIDI_VALUE, MELODIC_CHANNELS, MIN_NOTE_DURATION_SECONDS, PERCUSSION_CHANNEL } from './constants.ts';
import { parsePartName, normalizePartName } from './part-names.ts';
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

/** Stable across runs: track order is fixed in the file, and name+program separate Violin I from Violin II. */
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

/** Fixes programs that misrepresent the score: LilyPond writes solo string patches for whole desks, and horns to 69. */
const STRING_SECTION_PROGRAM = 48;
const FRENCH_HORN_PROGRAM = 60;
const SECTION_STRINGS = new Set(['Violin', 'Viola', 'Cello', 'Contrabass']);

/** Plurality, not the ordinal, marks a section: "Violino I" also names a concerto soloist. */
const PLURAL_TOKENS = new Set([
  'violins', 'violini', 'violinen', 'violons', 'geigen', 'fiddles', 'vlns', 'vns', 'vni',
  'violas', 'viole', 'vle', 'bratschen', 'altos', 'vlas',
  'cellos', 'celli', 'violoncelli', 'violoncelles', 'vcs',
  'contrabasses', 'contrabassi', 'contrabbassi', 'kontrabasse', 'contrebasses',
  'basses', 'bassi', 'dbs',
]);
const SOLO_TOKENS = new Set(['solo', 'soli', 'solist', 'soloist']);

/** Both thresholds must be met: three winds with one violin is a wind serenade, four strings with no winds is chamber music. */
const MIN_ORCHESTRAL_WINDS = 3;
const MIN_ORCHESTRAL_STRINGS = 3;
const ORCHESTRAL_SECTIONS = new Set(['Woodwinds', 'Brass', 'Percussion']);

/** LilyPond glues the desk number onto the instrument (`violino1`), leaving no word boundary for the parser. */
const readable = (name: string): string => name.replace(/([a-z])(\d)/gi, '$1 $2');

export function isOrchestral(names: readonly string[]): boolean {
  let winds = 0;
  let strings = 0;
  for (const name of names) {
    const parsed = parsePartName(readable(name));
    if (parsed.instrument === null) continue;
    if (parsed.section !== null && ORCHESTRAL_SECTIONS.has(parsed.section)) winds += 1;
    if (SECTION_STRINGS.has(parsed.instrument)) strings += 1;
  }
  return winds >= MIN_ORCHESTRAL_WINDS && strings >= MIN_ORCHESTRAL_STRINGS;
}

/** Keeps the scored program unless the name shows it misrepresents the part; inside an orchestra a lone `violino1` is a desk. */
export function remapProgram(name: string, program: number, orchestral = false): number {
  const tokens = normalizePartName(readable(name)).split(' ');
  if (tokens.some((token) => SOLO_TOKENS.has(token))) return program;

  const parsed = parsePartName(readable(name));
  if (parsed.instrument === 'Horn') return FRENCH_HORN_PROGRAM;
  if (parsed.instrument !== null && SECTION_STRINGS.has(parsed.instrument)) {
    if (orchestral || tokens.some((token) => PLURAL_TOKENS.has(token))) {
      return STRING_SECTION_PROGRAM;
    }
  }
  return program;
}

/** Busiest first, so the parts that carry the piece get their own channel; ties break on track order for reproducibility. */
function melodicChannels(tracks: { track: Track; index: number }[]): Map<number, number> {
  const byPresence = [...tracks].sort(
    (a, b) => b.track.notes.length - a.track.notes.length || a.index - b.index,
  );
  return new Map(
    byPresence.map(({ index }, rank) => [index, MELODIC_CHANNELS[rank] ?? OVERFLOW_CHANNEL]),
  );
}

/** Binds each part to its own channel so it can be faded alone; parts past the 15 melodic channels share the overflow and gate together. */
export function loadScore(filePath: string): Score {
  const midi = new Midi(readFileSync(filePath));
  const voiced = midi.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.notes.length > 0);
  const channelOf = melodicChannels(voiced.filter(({ track }) => !track.instrument.percussion));
  const orchestral = isOrchestral(voiced.map(({ track, index }) => partName(track, index)));

  const parts = voiced.map(({ track, index }): Part => {
    const percussion = track.instrument.percussion;
    const channel = percussion ? PERCUSSION_CHANNEL : (channelOf.get(index) ?? OVERFLOW_CHANNEL);
    const name = partName(track, index);
    const scored = track.instrument.number;
    const program = percussion ? scored : remapProgram(name, scored, orchestral);
    const id = partId(name, scored, index);
    return {
      partId: id,
      name,
      program,
      scoredProgram: scored,
      channel,
      percussion,
      notes: track.notes.map((note) => scoreNote(note, channel, id)),
    };
  });

  const notes = parts.flatMap((part) => part.notes).sort((a, b) => a.time - b.time);
  if (notes.length === 0) {
    throw new Error(`Score ${basename(filePath)} carries no playable notes`);
  }
  return { name: basename(filePath), duration: midi.duration, parts, notes };
}
