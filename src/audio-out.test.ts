import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createAudioOut, toMciVolume, toMilliseconds, toSeconds } from './audio-out.ts';

/** Present on stock Windows, and short enough that an end-to-end test stays quick. */
const SAMPLE_WAV = 'C:\\Windows\\Media\\Alarm01.wav';

test('a position in seconds survives the round trip through MCI milliseconds', () => {
  for (const seconds of [0, 0.001, 0.25, 1, 12.5, 3600]) {
    assert.equal(toSeconds(toMilliseconds(seconds)), seconds);
  }
});

test('a time MCI cannot be given collapses to the start rather than reaching it as text', () => {
  // MCI takes an unsigned millisecond count on a command line; a negative or a NaN
  // would arrive as the literal characters and be refused, losing the whole command.
  for (const seconds of [-1, -0.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(toMilliseconds(seconds), 0);
  }
  assert.equal(toMilliseconds(Number.POSITIVE_INFINITY), 0);
  assert.equal(toSeconds(Number.NaN), 0);
  assert.equal(toSeconds(-250), 0);
});

test('milliseconds are always whole, whatever fraction of a second is asked for', () => {
  for (const seconds of [0.0004, 0.0005, 1.23456, 9.9999]) {
    assert.ok(Number.isInteger(toMilliseconds(seconds)), `${seconds} gave a fraction`);
  }
});

test('a 0..1 level lands on MCI\u2019s 0..1000 at both ends and in the middle', () => {
  assert.equal(toMciVolume(0), 0);
  assert.equal(toMciVolume(0.5), 500);
  assert.equal(toMciVolume(1), 1000);
  assert.equal(toMciVolume(0.333), 333);
});

test('a volume outside the range is clamped rather than passed on to the device', () => {
  for (const level of [-5, -0.001, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(toMciVolume(level), 0);
  }
  for (const level of [1.0001, 2, 100, Number.POSITIVE_INFINITY]) {
    assert.equal(toMciVolume(level), 1000);
  }
});

test('volume is monotonic across the range and never leaves it', () => {
  let previous = -1;
  for (let level = 0; level <= 1.0001; level += 0.01) {
    const value = toMciVolume(level);
    assert.ok(value >= previous, `${level} went backwards`);
    assert.ok(value >= 0 && value <= 1000, `${level} gave ${value}`);
    previous = value;
  }
});

test('every call is harmless when the bridge was never started', async () => {
  // A daemon with no audio bridge still has to run: this must not throw and must not
  // hang on a reply that is never coming.
  const audio = createAudioOut();
  assert.equal(audio.status().ready, false);

  const settled = await Promise.race([
    (async () => {
      assert.equal(await audio.open(SAMPLE_WAV), 0);
      assert.equal(await audio.position(), 0);
      await audio.play();
      await audio.pause();
      await audio.resume();
      await audio.seek(10);
      await audio.setVolume(0.5);
      return 'done';
    })(),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 2000).unref()),
  ]);

  assert.equal(settled, 'done');
  audio.stop();
  assert.equal(audio.status().ready, false);
});

test('stopping a bridge that never started is not an error either', () => {
  const audio = createAudioOut();
  audio.stop();
  audio.stop();
  assert.equal(audio.status().ready, false);
});

test('a real wav opens, plays, advances, pauses and closes', async (t) => {
  if (!existsSync(SAMPLE_WAV)) {
    t.skip(`${SAMPLE_WAV} is not present on this machine`);
    return;
  }

  const audio = createAudioOut();
  try {
    const status = await audio.start();
    assert.equal(status.error, null);
    assert.ok(status.ready, 'bridge did not come up');

    const duration = await audio.open(SAMPLE_WAV);
    assert.ok(duration > 0, `expected a duration, got ${duration}`);

    // Quiet on purpose: the suite should not be audible across the room.
    await audio.setVolume(0.05);
    assert.equal(await audio.position(), 0);

    await audio.play();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const playing = await audio.position();
    assert.ok(playing > 0, 'position never advanced');
    assert.ok(playing < duration, `position ${playing} ran past the duration ${duration}`);

    await audio.pause();
    const paused = await audio.position();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await audio.position(), paused, 'a paused file kept moving');

    await audio.seek(0);
    assert.equal(await audio.position(), 0);
  } finally {
    // Whatever failed above, nothing may be left sounding after the suite exits.
    audio.stop();
  }

  assert.equal(audio.status().ready, false);
});
