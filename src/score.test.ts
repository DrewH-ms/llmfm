import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScore, remapProgram, isOrchestral } from './score.ts';

const TRACKS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'playlists', 'bundled');
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

const CORIOLAN_PARTS = [
  'flauti', 'oboi', 'clarinetti', 'fagotti', 'corni', 'trombe', 'timpani',
  'violino1', 'violino2', 'viole', 'violoncello', 'contrabasso',
];
const QUARTET_PARTS = ['violino1', 'violino2', 'viola', 'violoncello'];
const BAROQUE_CONCERTO_PARTS = [
  'flauto', 'violino principale', 'violino', 'viola', 'violoncello', 'contrabasso', 'cembalo',
];

test('an orchestra is told apart from an ensemble by its wind complement', () => {
  assert.equal(isOrchestral(CORIOLAN_PARTS), true);
  assert.equal(isOrchestral(QUARTET_PARTS), false);
  assert.equal(isOrchestral(BAROQUE_CONCERTO_PARTS), false);
  assert.equal(isOrchestral(['oboe', 'clarinet', 'bassoon']), false, 'winds alone are not an orchestra');
  assert.equal(isOrchestral([]), false);
});

/** The gap the plurality rule left: in a full orchestra the singular names are desks, and
 *  they are most of the strings. */
test('a singular string name is a desk inside an orchestra', () => {
  for (const name of ['violino1', 'violino2', 'violoncello', 'contrabasso']) {
    assert.equal(remapProgram(name, SOLO_VIOLIN, true), STRING_ENSEMBLE, name);
  }
});

test('the same name in a quartet is left alone', () => {
  for (const name of QUARTET_PARTS) {
    assert.equal(remapProgram(name, SOLO_VIOLIN, false), SOLO_VIOLIN, name);
  }
});

test('a name saying solo wins even inside an orchestra', () => {
  for (const name of ['Violino solo', 'Solo Violin', 'Violoncello Solo']) {
    assert.equal(remapProgram(name, SOLO_VIOLIN, true), SOLO_VIOLIN, name);
  }
});

test('chamber music keeps its solo patches when actually loaded', () => {
  const chamber = [
    'mutopia-mozart-quartet-kv387.mid',
    'mutopia-haydn-quartet-op76-4.mid',
    'mutopia-mozart-eine-kleine-nachtmusik.mid',
    'mutopia-bach-brandenburg5-3.mid',
    'mutopia-bach-violin-concerto-e-major.mid',
  ];
  for (const file of chamber) {
    for (const part of loadScore(join(TRACKS_DIR, file)).parts) {
      assert.equal(
        part.program,
        part.scoredProgram,
        `${file}/${part.name} was remapped; chamber scoring must keep the patch it chose`,
      );
    }
  }
});

test('the orchestral strings of a real score do reach the section patch', () => {
  // The negative case above passes trivially if the flag is never wired into loadScore.
  const parts = loadScore(join(TRACKS_DIR, 'mutopia-beethoven-coriolan-overture.mid')).parts;
  const strings = parts.filter((part) => /violino|viole|violoncello|contrabasso/i.test(part.name));
  assert.equal(strings.length, 5, 'the five string desks were found');
  for (const part of strings) {
    assert.equal(part.program, STRING_ENSEMBLE, `${part.name} sounds as a section`);
  }
  const winds = parts.filter((part) => /flauti|oboi|clarinetti|fagotti/i.test(part.name));
  for (const part of winds) {
    assert.equal(part.program, part.scoredProgram, `${part.name} was left alone`);
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
    const parts = loadScore(join(TRACKS_DIR, file)).parts;
    const orchestral = isOrchestral(parts.map((part) => part.name));
    for (const part of parts) {
      assert.equal(typeof part.scoredProgram, 'number', `${file}/${part.name}`);
      if (part.program !== part.scoredProgram) {
        assert.equal(
          part.program,
          remapProgram(part.name, part.scoredProgram, orchestral),
          `${file}/${part.name} was remapped by something other than its name`,
        );
      }
    }
  }
});

/** Tempo- or lyric-only exports carry track headers and no note events. Loading one as a
 *  playable score puts the transport on silence that means nothing, so it is refused here
 *  and the caller keeps the track it already has. */
test('a MIDI with tracks but no notes is refused rather than loaded silent', (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'llmfm-score-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { Midi } = createRequire(import.meta.url)('@tonejs/midi') as typeof import('@tonejs/midi');
  const midi = new Midi();
  midi.addTrack().name = 'Lyrics';
  const path = join(dir, 'noteless.mid');
  writeFileSync(path, Buffer.from(midi.toArray()));

  assert.throws(() => loadScore(path), /no playable notes/);
});
