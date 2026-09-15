import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_VOICE_CONTINUITY } from '../src/constants.ts';
import { parsePartName } from '../src/part-names.ts';
import { loadScore } from '../src/score.ts';
import { buildVoiceTree, classifyPart } from '../src/voices.ts';
import type { Voice } from '../src/types.ts';

/**
 * Measures how the voice tree behaves on every track in the library, so "does our
 * classification work?" becomes a number per file rather than an impression.
 *
 * Dev-time only, run by hand:
 *   node tools/classify-tracks.ts [--quiet]
 */

const TRACKS_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'tracks');
const MIDI_FILE_PATTERN = /\.midi?$/i;
/** Below this a track cannot carry a working session of agents: with one or two voices
 *  there is nothing to assign, and the ensemble reading of the signal collapses. */
const MIN_USABLE_VOICES = 3;

type Measurement = {
  file: string;
  trackCount: number;
  voicedCount: number;
  backingCount: number;
  programs: number[];
  sectionVoices: number;
  instrumentVoices: number;
  partVoices: number;
  namedTracks: number;
  programTracks: number;
  fallbackTracks: number;
  usable: boolean;
};

function distinct(voices: Voice[], depth: number): number {
  return new Set(voices.map((voice) => voice.path.slice(0, depth).join('/'))).size;
}

function measure(file: string, verbose: boolean): Measurement {
  const score = loadScore(join(TRACKS_DIR, file));
  const tree = buildVoiceTree(score);
  const finest = tree.voicesFor(score.parts.length);

  const classified = score.parts.map((part) => ({
    part,
    name: parsePartName(part.name),
    ...classifyPart(part),
  }));

  if (verbose) {
    console.log(`\n${file}  —  ${score.parts.length} tracks, ${Math.round(score.duration)}s`);
    for (const entry of classified) {
      const backing = tree.backingPartIds.includes(entry.part.partId) ? '  [backing]' : '';
      const evidence = entry.source === 'fallback' ? 'FALLBACK' : entry.source;
      const read = entry.name.placeholder ? '(no usable name)' : entry.name.label;
      console.log(
        `  ${entry.part.name.padEnd(28)} p${String(entry.part.program).padStart(3)}` +
          `  -> ${read.padEnd(20)} ${entry.section.padEnd(10)} (${evidence})${backing}`,
      );
    }
    console.log(`  voices offered: ${finest.map((voice) => voice.name).join(', ') || '(none)'}`);
  }

  return {
    file,
    trackCount: score.parts.length,
    voicedCount: score.parts.length - tree.backingPartIds.length,
    backingCount: tree.backingPartIds.length,
    programs: [...new Set(score.parts.map((part) => part.program))].sort((a, b) => a - b),
    sectionVoices: distinct(finest, 1),
    instrumentVoices: distinct(finest, 2),
    partVoices: finest.length,
    namedTracks: classified.filter((entry) => entry.source === 'name').length,
    programTracks: classified.filter((entry) => entry.source === 'program').length,
    fallbackTracks: classified.filter((entry) => entry.source === 'fallback').length,
    usable: finest.length >= MIN_USABLE_VOICES,
  };
}

const COLUMNS = [
  { heading: 'file', of: (row: Measurement) => row.file },
  { heading: 'trks', of: (row: Measurement) => String(row.trackCount) },
  { heading: 'voiced', of: (row: Measurement) => String(row.voicedCount) },
  { heading: 'programs', of: (row: Measurement) => row.programs.join(',') },
  { heading: 'by name', of: (row: Measurement) => String(row.namedTracks) },
  { heading: 'by prog', of: (row: Measurement) => String(row.programTracks) },
  { heading: 'unknown', of: (row: Measurement) => String(row.fallbackTracks) },
  { heading: 'sect', of: (row: Measurement) => String(row.sectionVoices) },
  { heading: 'instr', of: (row: Measurement) => String(row.instrumentVoices) },
  { heading: 'voices', of: (row: Measurement) => String(row.partVoices) },
  { heading: 'verdict', of: (row: Measurement) => (row.usable ? 'ok' : 'TOO FEW') },
];

function printTable(rows: Measurement[]): void {
  const cells = rows.map((row) => COLUMNS.map((column) => column.of(row)));
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.heading.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );
  const line = (values: string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ');

  console.log(`\n${line(COLUMNS.map((column) => column.heading))}`);
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of cells) console.log(line(row));
}

const verbose = !process.argv.includes('--quiet');
const files = readdirSync(TRACKS_DIR).filter((file) => MIDI_FILE_PATTERN.test(file)).sort();
const rows: Measurement[] = [];

for (const file of files) {
  try {
    rows.push(measure(file, verbose));
  } catch (error) {
    console.log(`\n${file}  —  failed to read: ${error instanceof Error ? error.message : error}`);
  }
}

printTable(rows);

const unusable = rows.filter((row) => !row.usable);
const unknown = rows.filter((row) => row.fallbackTracks > 0);
console.log(
  `\n${rows.length} tracks; ${unusable.length} yield fewer than ${MIN_USABLE_VOICES} voices; ` +
    `${unknown.length} have tracks that fell through to the default section.`,
);
console.log(
  `Parts are held back as backing below ${MIN_VOICE_CONTINUITY} continuity; ` +
    `'voiced' counts the rest.`,
);
