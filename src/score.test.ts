import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScore, remapProgram } from './score.ts';

const TRACKS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tracks');
const SOLO_VIOLIN = 40;
const STRING_ENSEMBLE = 48;
const ENGLISH_HORN = 69;
const FRENCH_HORN = 60;

test('a named string section moves off the solo patch', () => {
  for (const name of ['Violins I', 'Violini II', 'Violas', 'Violoncelli', 'Bassi', 'Vlns. 1']) {
    assert.equal(remapProgram(name, SOLO_VIOLIN), STRING_ENSEMBLE, name);
  }
});

/** The reason the remap reads names instead of substituting programs wholesale. */
test('a solo concerto part keeps the patch its score chose', () => {
  for (const name of ['Violino solo', 'Solo Violin', 'Violoncello solo', 'Viola Soli']) {
    assert.equal(remapProgram(name, SOLO_VIOLIN), SOLO_VIOLIN, name);
  }
});

test('a single desk without plurality is left alone', () => {
  for (const name of ['Violino I', 'Violin', 'Cello', 'Contrabass']) {
    assert.equal(remapProgram(name, SOLO_VIOLIN), SOLO_VIOLIN, name);
  }
});

test('a horn is brass whatever the file says', () => {
  for (const name of ['Corno I', 'Horns in F', 'Corni in Mi b', 'Waldhorn', 'Hrn. 2']) {
    assert.equal(remapProgram(name, ENGLISH_HORN), FRENCH_HORN, name);
  }
});

/** An English horn really is a woodwind, and shares most of its spellings with a horn. */
test('an English horn is not mistaken for brass', () => {
  for (const name of ['Corno inglese', 'English Horn', 'Cor anglais']) {
    assert.equal(remapProgram(name, ENGLISH_HORN), ENGLISH_HORN, name);
  }
});

test('a name that resolves to nothing changes nothing', () => {
  for (const name of ['', 'Track 4', 'Staff', 'Trk 11']) {
    assert.equal(remapProgram(name, 12), 12, name);
  }
});

test('a part that is not remapped reports the same program twice', () => {
  const part = { name: 'Piano', program: 0, scoredProgram: 0 };
  assert.equal(remapProgram(part.name, part.scoredProgram), part.program);
});

test('every bundled part keeps the program its file chose alongside the one it sounds', () => {
  const files = readdirSync(TRACKS_DIR).filter((file) => /\.midi?$/i.test(file));
  assert.ok(files.length > 0, 'no tracks to check');
  for (const file of files) {
    for (const part of loadScore(join(TRACKS_DIR, file)).parts) {
      assert.equal(typeof part.scoredProgram, 'number', `${file}/${part.name}`);
      if (part.program !== part.scoredProgram) {
        assert.equal(
          part.program,
          remapProgram(part.name, part.scoredProgram),
          `${file}/${part.name} was remapped by something other than its name`,
        );
      }
    }
  }
});
