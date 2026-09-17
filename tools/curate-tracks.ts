import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { loadScore } from '../src/score.ts';
import { measureDynamics, isDynamic, MIN_DISTINCT_VELOCITIES } from './dynamics.ts';

/** Dev-time only, run by hand — `node tools/curate-tracks.ts [--refresh]`: downloads Mutopia tracks and records each licence; the daemon never reaches the network. */

const MUTOPIA_FTP = 'https://www.mutopiaproject.org/ftp/';
const MUTOPIA_ATTRIBUTION = 'The Mutopia Project (mutopiaproject.org)';
const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const TRACKS_DIR = join(PROJECT_ROOT, 'playlists', 'bundled');
const TRACKS_INDEX = join(TRACKS_DIR, 'tracks.json');
const ATTRIBUTION_FILE = join(TRACKS_DIR, 'ATTRIBUTION.md');
/** Keeps curated files out of the daemon's default-track pick, which is the first file in the directory. */
const CURATED_PREFIX = 'mutopia-';

/** Licences Mutopia states; anything outside this table is refused rather than guessed at. */
const LICENCES = [
  { stated: 'public domain', id: 'PD', attribution: false },
  { stated: 'creative commons attribution 2.0', id: 'CC BY 2.0', attribution: true },
  { stated: 'creative commons attribution 2.5', id: 'CC BY 2.5', attribution: true },
  { stated: 'creative commons attribution 3.0', id: 'CC BY 3.0', attribution: true },
  { stated: 'creative commons attribution 4.0', id: 'CC BY 4.0', attribution: true },
  { stated: 'creative commons attribution sharealike 2.0', id: 'CC BY-SA 2.0', attribution: true },
  { stated: 'creative commons attribution sharealike 2.5', id: 'CC BY-SA 2.5', attribution: true },
  { stated: 'creative commons attribution sharealike 3.0', id: 'CC BY-SA 3.0', attribution: true },
  { stated: 'creative commons attribution sharealike 4.0', id: 'CC BY-SA 4.0', attribution: true },
] as const;

/** Mutopia keys composers by an identifier ("BachJS"); a credit has to read as a name. */
const COMPOSER_NAMES = new Map<string, string>([
  ['BachJS', 'Johann Sebastian Bach'],
  ['BeethovenLv', 'Ludwig van Beethoven'],
  ['MozartWA', 'Wolfgang Amadeus Mozart'],
  ['VivaldiA', 'Antonio Vivaldi'],
  ['DvorakA', 'Antonín Dvořák'],
  ['GriegE', 'Edvard Grieg'],
  ['HaydnFJ', 'Franz Joseph Haydn'],
  ['Mendelssohn-BartholdyF', 'Felix Mendelssohn Bartholdy'],
]);

/** Every entry was measured to carry real dynamics: the signal is one part fading against the others. */
const CURATED = [
  { file: 'dvorak-symphony7.mid', piece: 'DvorakA/O70/DvorakSYMPH7' },
  { file: 'dvorak-symphony9-new-world.mid', piece: 'DvorakA/O95/Sym9' },
  { file: 'beethoven-egmont-overture.mid', piece: 'BeethovenLv/O84/Egmont' },
  { file: 'beethoven-coriolan-overture.mid', piece: 'BeethovenLv/O62/Coriolan' },
  { file: 'beethoven-fidelio-overture.mid', piece: 'BeethovenLv/O72b/fidelio' },
  { file: 'beethoven-piano-concerto3-1.mid', piece: 'BeethovenLv/O37/Concerto_No3' },
  { file: 'beethoven-symphony5-2.mid', piece: 'BeethovenLv/O67/Symphony5_2' },
  {
    file: 'mendelssohn-midsummer-nights-dream.mid',
    piece: 'Mendelssohn-BartholdyF/O61/Sommernachtstraum',
  },
  { file: 'grieg-aases-death.mid', piece: 'GriegE/O46/02-lamortdase-strings' },
  { file: 'mozart-wind-divertimento2.mid', piece: 'MozartWA/KV229/divertimento' },
  { file: 'mozart-piano-concerto23.mid', piece: 'MozartWA/KV488/Mozart-KV488' },
  { file: 'mozart-quartet-kv387.mid', piece: 'MozartWA/KV387/k387' },
  { file: 'mozart-requiem-dies-irae.mid', piece: 'MozartWA/KV626/dies_irae' },
  { file: 'mozart-eine-kleine-nachtmusik.mid', piece: 'MozartWA/KV525/MozartWA-KV525' },
  { file: 'haydn-quartet-op76-4.mid', piece: 'HaydnFJ/O76/op76-n4' },
  { file: 'bach-violin-concerto-e-major.mid', piece: 'BachJS/BWV1042/concerto-in-e-major' },
  { file: 'bach-brandenburg5-3.mid', piece: 'BachJS/BWV1050/brand5-3' },
] as const;

type CuratedTrack = {
  file: string;
  title: string;
  composer: string;
  forces: string;
  date: string;
  style: string;
  licence: string;
  licenceId: string;
  requiresAttribution: boolean;
  maintainer: string;
  source: string;
  sha256: string;
  retrieved: string;
};

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_RECORD_LENGTH = 22;
const ZIP_CENTRAL_HEADER_LENGTH = 46;
const ZIP_LOCAL_HEADER_LENGTH = 30;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

function zipEntries(archive: Buffer): { name: string; data: Buffer }[] {
  let end = archive.length - ZIP_END_RECORD_LENGTH;
  while (end >= 0 && archive.readUInt32LE(end) !== ZIP_END_OF_CENTRAL_DIRECTORY) end -= 1;
  if (end < 0) throw new Error('not a zip archive');

  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries: { name: string; data: Buffer }[] = [];

  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_HEADER) break;
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + ZIP_CENTRAL_HEADER_LENGTH, offset + ZIP_CENTRAL_HEADER_LENGTH + nameLength);

    const dataStart =
      localOffset +
      ZIP_LOCAL_HEADER_LENGTH +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === ZIP_STORED) entries.push({ name, data: stored });
    if (method === ZIP_DEFLATED) entries.push({ name, data: inflateRawSync(stored) });

    offset += ZIP_CENTRAL_HEADER_LENGTH + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function rdfField(document: string, field: string): string {
  const match = new RegExp(`<mp:${field}>([\\s\\S]*?)</mp:${field}>`).exec(document);
  return match?.[1]?.trim() ?? '';
}

function licenceOf(stated: string): (typeof LICENCES)[number] {
  const normalized = stated.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  const known = LICENCES.find((licence) => normalized.startsWith(licence.stated));
  if (!known) throw new Error(`unrecognised licence "${stated}" — not shipping this file`);
  return known;
}

/** The longest movement is the one worth playing, and is a good proxy for the fullest scoring. */
function largestMidi(archive: Buffer): Buffer {
  const midis = zipEntries(archive).filter((entry) => /\.midi?$/i.test(entry.name));
  const largest = midis.sort((a, b) => b.data.length - a.data.length)[0];
  if (!largest) throw new Error('archive contains no MIDI file');
  return largest.data;
}

/** Runs before the file is kept: a flat score cannot carry the signal. Returns the reason, or null to keep. */
function screen(path: string): string | null {
  let score;
  try {
    score = loadScore(path);
  } catch (error) {
    return `does not parse as MIDI: ${error instanceof Error ? error.message : error}`;
  }
  if (score.parts.length === 0 || score.notes.length === 0 || score.duration <= 0) {
    return 'parses but contains no playable music';
  }
  const dynamics = measureDynamics(score.notes);
  if (!isDynamic(dynamics)) {
    return `dynamically flat: ${dynamics.distinct} distinct velocities, need ${MIN_DISTINCT_VELOCITIES}`;
  }
  return null;
}

function writeAttribution(tracks: CuratedTrack[]): void {
  const lines = [
    '# Music credits',
    '',
    `Every file in this directory was obtained from ${MUTOPIA_ATTRIBUTION} and is`,
    'redistributed under the licence its publisher states for that file. Typesetting and',
    'sequencing are the work of the Mutopia contributors named below.',
    '',
    '| File | Work | Composer | Licence | Typeset by | Source |',
    '| --- | --- | --- | --- | --- | --- |',
    ...tracks.map((track) =>
      `| \`${track.file}\` | ${track.title} | ${track.composer} | ${track.licenceId} | ${track.maintainer || '—'} | ${track.source} |`,
    ),
    '',
    'Files licensed CC BY-SA may be redistributed only with this credit intact and under',
    'the same licence.',
    '',
  ];
  writeFileSync(ATTRIBUTION_FILE, lines.join('\n'), 'utf8');
}

async function curate(track: (typeof CURATED)[number], refresh: boolean): Promise<CuratedTrack> {
  const slug = track.piece.split('/').at(-1);
  const rdfUrl = `${MUTOPIA_FTP}${track.piece}/${slug}.rdf`;
  const document = (await fetchBytes(rdfUrl)).toString('utf8');

  const licence = licenceOf(rdfField(document, 'licence'));
  const midFile = rdfField(document, 'midFile');
  if (!midFile) throw new Error('piece publishes no MIDI');

  const destination = join(TRACKS_DIR, `${CURATED_PREFIX}${track.file}`);
  if (refresh || !existsSync(destination) || screen(destination) !== null) {
    const downloaded = await fetchBytes(`${MUTOPIA_FTP}${track.piece}/${midFile}`);
    const midi = midFile.toLowerCase().endsWith('.zip') ? largestMidi(downloaded) : downloaded;
    writeFileSync(destination, midi);
  }
  const rejected = screen(destination);
  if (rejected !== null) {
    rmSync(destination, { force: true });
    throw new Error(rejected);
  }

  const composerKey = rdfField(document, 'composer');

  return {
    file: `${CURATED_PREFIX}${track.file}`,
    title: rdfField(document, 'title').replace(/\s+/g, ' '),
    composer: COMPOSER_NAMES.get(composerKey) ?? composerKey,
    forces: rdfField(document, 'for').replace(/\s+/g, ' '),
    date: rdfField(document, 'date'),
    style: rdfField(document, 'style'),
    licence: rdfField(document, 'licence'),
    licenceId: licence.id,
    requiresAttribution: licence.attribution,
    maintainer: rdfField(document, 'maintainer'),
    source: `${MUTOPIA_FTP}${track.piece}/`,
    sha256: createHash('sha256').update(readFileSync(destination)).digest('hex'),
    retrieved: new Date().toISOString().slice(0, 'YYYY-MM-DD'.length),
  };
}

const refresh = process.argv.includes('--refresh');
mkdirSync(TRACKS_DIR, { recursive: true });

const kept: CuratedTrack[] = [];
const refused: { file: string; reason: string }[] = [];

for (const track of CURATED) {
  try {
    const curated = await curate(track, refresh);
    kept.push(curated);
    console.log(`kept    ${curated.file}  ${curated.licenceId}  ${curated.title}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    refused.push({ file: track.file, reason });
    console.log(`refused ${track.file}  ${reason}`);
  }
}

const existing = existsSync(TRACKS_INDEX)
  ? (JSON.parse(readFileSync(TRACKS_INDEX, 'utf8')) as { tracks?: unknown[] })
  : {};
const carried = (existing.tracks ?? []).filter(
  (entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && !String((entry as { file?: unknown }).file ?? '').startsWith(CURATED_PREFIX),
);

writeFileSync(
  TRACKS_INDEX,
  `${JSON.stringify({ tracks: [...carried, ...kept.sort((a, b) => a.file.localeCompare(b.file))] }, null, 2)}\n`,
  'utf8',
);
writeAttribution(kept);

console.log(`\n${kept.length} kept, ${refused.length} refused.`);
for (const entry of refused) console.log(`  ${entry.file}: ${entry.reason}`);
