import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_TRACK } from './constants.ts';

const TRACKS_DIR = join(import.meta.dirname, '..', 'tracks');
const index = JSON.parse(readFileSync(join(TRACKS_DIR, 'tracks.json'), 'utf8'));
const attribution = readFileSync(join(TRACKS_DIR, 'ATTRIBUTION.md'), 'utf8');
const files = readdirSync(TRACKS_DIR).filter((file) => /\.midi?$/i.test(file));

/** A public-domain composition does not put its MIDI sequence in the public domain: the
 *  sequence is a separately copyrightable arrangement. These run over the shipped files
 *  rather than over the curation script, so a file dragged into the folder by hand is
 *  caught too — which is how the one unverified track got there in the first place. */
const ALLOWED = new Set([
  'PD',
  'CC BY 2.0',
  'CC BY 2.5',
  'CC BY 3.0',
  'CC BY 4.0',
  'CC BY-SA 2.0',
  'CC BY-SA 2.5',
  'CC BY-SA 3.0',
  'CC BY-SA 4.0',
]);

test('every shipped MIDI file states a licence we are allowed to redistribute', () => {
  for (const file of files) {
    const entry = index.tracks.find((track: { file: string }) => track.file === file);
    assert.ok(entry, `${file} ships with no entry in tracks.json`);
    assert.ok(ALLOWED.has(entry.licenceId), `${file} states "${entry.licenceId}"`);
    assert.ok(entry.source, `${file} records no source to verify against`);
  }
});

test('a shipped file is the one its licence record was written for', () => {
  // A licence record describes specific bytes. Copying another file over a verified name
  // inherits its licence, its attribution and its provenance while being none of them —
  // which has happened here once already, with a file we may not redistribute at all.
  for (const file of files) {
    const entry = index.tracks.find((track: { file: string }) => track.file === file);
    assert.ok(entry?.sha256, `${file} records no hash, so its licence proves nothing`);
    const actual = createHash('sha256').update(readFileSync(join(TRACKS_DIR, file))).digest('hex');
    assert.equal(actual, entry.sha256, `${file} is not the file ${entry.licenceId} was verified for`);
  }
});

test('a licence requiring attribution gets it, in the file a user can find', () => {
  const credited = index.tracks.filter((track: { licenceId: string }) =>
    track.licenceId.startsWith('CC BY'),
  );
  assert.ok(credited.length > 0);
  for (const track of credited) {
    assert.ok(attribution.includes(track.file), `${track.file} is credited nowhere`);
    assert.ok(attribution.includes(track.source), `${track.file} credits no source`);
  }
});

test('the default track is present and licensed', () => {
  assert.ok(files.includes(DEFAULT_TRACK), `${DEFAULT_TRACK} is missing from tracks/`);
});
