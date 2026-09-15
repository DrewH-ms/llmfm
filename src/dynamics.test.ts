import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScore } from './score.ts';
import { measureDynamics, isDynamic, MIN_DISTINCT_VELOCITIES } from '../tools/dynamics.ts';

const TRACKS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'tracks');
const bundled = readdirSync(TRACKS_DIR).filter((file) => /\.midi?$/i.test(file));

/** The library was once mostly flat engravings, which sound like the music breaking when
 *  a part fades rather than like a voice leaving. Curation refuses them now; this is what
 *  stops one arriving by another route. */
test('every bundled track carries real dynamics', () => {
  assert.ok(bundled.length > 0, 'no tracks to check');
  for (const file of bundled) {
    const dynamics = measureDynamics(loadScore(join(TRACKS_DIR, file)).notes);
    assert.ok(
      isDynamic(dynamics),
      `${file} has ${dynamics.distinct} distinct velocities, below the ${MIN_DISTINCT_VELOCITIES} a fade needs to be audible against`,
    );
  }
});

test('the measurement reads velocity spread rather than note count', () => {
  const flat = measureDynamics([1, 1, 1, 1, 1, 1].map((velocity) => ({ velocity }) as never));
  assert.equal(flat.distinct, 1);
  assert.equal(flat.sd, 0);
  assert.equal(isDynamic(flat), false);

  const varied = measureDynamics([10, 30, 50, 70, 90].map((velocity) => ({ velocity }) as never));
  assert.equal(varied.distinct, 5);
  assert.ok(varied.sd > 0);
  assert.equal(varied.low, 10);
  assert.equal(varied.high, 90);
  assert.equal(isDynamic(varied), true);
});

test('an empty score is flat rather than a crash', () => {
  const empty = measureDynamics([]);
  assert.equal(empty.notes, 0);
  assert.equal(isDynamic(empty), false);
});
