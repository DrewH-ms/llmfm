import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelWithOrdinal, normalizePartName, parsePartName } from './part-names.ts';

test('folds case, punctuation and diacritics to one spelling', () => {
  assert.equal(normalizePartName('Vln. I'), 'vln i');
  assert.equal(normalizePartName('  VIOLIN   I  '), 'violin i');
  assert.equal(normalizePartName('Flöte'), 'flote');
  assert.equal(normalizePartName('Kontrabaß'), 'kontrabass');
});

test('restores word boundaries an engraver ran together', () => {
  assert.equal(normalizePartName(':SoloViolinI'), 'solo violin i');
  assert.equal(normalizePartName('violinone'), 'violin one');
  assert.equal(normalizePartName('violintwo'), 'violin two');
  assert.equal(normalizePartName('ViolinII'), 'violin ii');
});

test('reads abbreviations as the instrument they stand for', () => {
  for (const [name, instrument] of [
    ['Vln. 1', 'Violin'],
    ['Vc.', 'Cello'],
    ['Cl.', 'Clarinet'],
    ['Fl.', 'Flute'],
    ['Vla', 'Viola'],
    ['Ob.', 'Oboe'],
    ['Hn. 2', 'Horn'],
    ['Tpt.', 'Trumpet'],
    ['Tbn.', 'Trombone'],
    ['Timp.', 'Timpani'],
    ['Cb.', 'Contrabass'],
  ] as const) {
    assert.equal(parsePartName(name).instrument, instrument, name);
  }
});

test('reads the same instrument across languages', () => {
  for (const [name, instrument] of [
    ['Violini I', 'Violin'],
    ['Violine 1', 'Violin'],
    ['Violons', 'Violin'],
    ['Violoncelli', 'Cello'],
    ['Violoncelle', 'Cello'],
    ['Fagotti', 'Bassoon'],
    ['Fagott', 'Bassoon'],
    ['Basson', 'Bassoon'],
    ['Corni in Mi b', 'Horn'],
    ['Cor', 'Horn'],
    ['Waldhorn', 'Horn'],
    ['Flauti', 'Flute'],
    ['Querflöte', 'Flute'],
    ['Bratsche', 'Viola'],
    ['Pauken', 'Timpani'],
    ['Posaune', 'Trombone'],
    ['Clavecin', 'Harpsichord'],
    ['Klavier', 'Piano'],
  ] as const) {
    assert.equal(parsePartName(name).instrument, instrument, name);
  }
});

test('separates instruments whose names contain another instrument', () => {
  assert.equal(parsePartName('Cor Anglais').instrument, 'English Horn');
  assert.equal(parsePartName('Corno inglese').instrument, 'English Horn');
  assert.equal(parsePartName('Controfagotto').instrument, 'Contrabassoon');
  assert.equal(parsePartName('Basso continuo').instrument, 'Continuo');
  assert.equal(parsePartName('Violone').instrument, 'Contrabass');
  assert.equal(parsePartName('Trombone 1').instrument, 'Trombone');
  assert.equal(parsePartName('Tromba').instrument, 'Trumpet');
});

test('reads a desk number written in any of the usual forms', () => {
  for (const [name, ordinal] of [
    ['Violin I', 1],
    ['Violin II', 2],
    ['Violin 2', 2],
    ['2nd Violins', 2],
    ['Violino secondo', 2],
    ['Violino primo', 1],
    ['Zweite Violine', 2],
    ['Deuxième violon', 2],
    ['Horn 3', 3],
  ] as const) {
    assert.equal(parsePartName(name).ordinal, ordinal, name);
  }
  assert.equal(parsePartName('Viola').ordinal, null);
});

test('discounts the transposition printed after the instrument', () => {
  assert.equal(parsePartName('Clarinetti in Si b').ordinal, null);
  assert.equal(parsePartName('Trumpet in B flat 2').ordinal, 2);
  assert.equal(parsePartName('Corni in Mi b').instrument, 'Horn');
});

test('refuses to read an instrument out of a name that carries none', () => {
  for (const name of ['', 'Track 4', 'Trk 4', 'MIDI', 'Untitled', '\\new', 'RH:1', 'upper:', 'one:', '12']) {
    const read = parsePartName(name);
    assert.equal(read.instrument, null, name);
    assert.equal(read.section, null, name);
    assert.equal(read.placeholder, true, name);
  }
});

test('an unrecognised but meaningful name is kept rather than discarded', () => {
  const read = parsePartName('Ondes Martenot');
  assert.equal(read.instrument, null);
  assert.equal(read.placeholder, false);
  assert.equal(read.label, 'Ondes Martenot');
});

test('places the instrument in the section a listener would name', () => {
  assert.equal(parsePartName('Vln 1').section, 'Strings');
  assert.equal(parsePartName('Ob.').section, 'Woodwinds');
  assert.equal(parsePartName('Tuba').section, 'Brass');
  assert.equal(parsePartName('Pauken').section, 'Percussion');
  assert.equal(parsePartName('Cembalo').section, 'Keyboard');
  assert.equal(parsePartName('Soprano').section, 'Voices');
});

test('labels a part the way an orchestra numbers its desks', () => {
  assert.equal(parsePartName('vln. 2').label, 'Violin II');
  assert.equal(parsePartName('Violoncelli').label, 'Cello');
  assert.equal(labelWithOrdinal('Horn', 3), 'Horn III');
  assert.equal(labelWithOrdinal('Violin', 9), 'Violin 9');
});
