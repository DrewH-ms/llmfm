import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrackRotation, listTracks } from './daemon.ts';

const LIBRARY = ['a.mid', 'b.mid', 'c.mid', 'd.mid'];

/** Fixed draws make the shuffle reproducible without making it trivial. */
const cyclingRandom = (values: number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
};

test('autoplay off never advances', () => {
  const rotation = createTrackRotation();
  assert.equal(rotation.next({ library: LIBRARY, current: 'a.mid', mode: 'off' }), null);
});

test('a library with nothing to move to never advances', () => {
  const rotation = createTrackRotation();
  assert.equal(rotation.next({ library: ['a.mid'], current: 'a.mid', mode: 'random' }), null);
  assert.equal(rotation.next({ library: [], current: null, mode: 'sequential' }), null);
});

test('sequential walks the library and wraps', () => {
  const rotation = createTrackRotation();
  const heard = ['c.mid'];
  for (let step = 0; step < 4; step += 1) {
    const current = heard[heard.length - 1] ?? null;
    const next = rotation.next({ library: LIBRARY, current, mode: 'sequential' });
    assert.ok(next);
    heard.push(next);
  }
  assert.deepEqual(heard, ['c.mid', 'd.mid', 'a.mid', 'b.mid', 'c.mid']);
});

test('sequential starts at the top when the current track is not in the library', () => {
  const rotation = createTrackRotation();
  assert.equal(rotation.next({ library: LIBRARY, current: 'gone.mid', mode: 'sequential' }), 'a.mid');
  assert.equal(rotation.next({ library: LIBRARY, current: null, mode: 'sequential' }), 'a.mid');
});

test('random covers the library before repeating anything', () => {
  const rotation = createTrackRotation(cyclingRandom([0.1, 0.9, 0.5, 0.3, 0.7]));
  let current = 'a.mid';
  const firstPass: string[] = [];
  for (let step = 0; step < LIBRARY.length - 1; step += 1) {
    const next = rotation.next({ library: LIBRARY, current, mode: 'random' });
    assert.ok(next);
    firstPass.push(next);
    current = next;
  }
  // The bag was filled without the track already playing, so a pass is the rest of it.
  assert.deepEqual([...firstPass].sort(), ['b.mid', 'c.mid', 'd.mid']);
});

test('random never plays the current track twice in a row, across refills', () => {
  const rotation = createTrackRotation(cyclingRandom([0.01, 0.99, 0.42, 0.66, 0.23, 0.87]));
  let current = 'a.mid';
  for (let step = 0; step < 200; step += 1) {
    const next = rotation.next({ library: LIBRARY, current, mode: 'random' });
    assert.ok(next, 'random should always find somewhere to go in a library of four');
    assert.notEqual(next, current, `repeated ${current} at step ${step}`);
    current = next;
  }
});

test('random drops tracks that have left the library', () => {
  const rotation = createTrackRotation(cyclingRandom([0.5]));
  rotation.next({ library: LIBRARY, current: 'a.mid', mode: 'random' });
  const shrunk = ['a.mid', 'b.mid'];
  for (let step = 0; step < 10; step += 1) {
    const next = rotation.next({ library: shrunk, current: 'a.mid', mode: 'random' });
    assert.equal(next, 'b.mid');
  }
});

test('the shipped library is big enough for autoplay to have somewhere to go', () => {
  assert.ok(listTracks().length >= 2);
});
