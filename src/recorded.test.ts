import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordedPlayer } from './recorded.ts';
import type { AudioOut, AudioStatus } from './audio-out.ts';

const DURATION_SECONDS = 30;

function fakeAudio(): AudioOut & { calls: string[]; volume: number } {
  const calls: string[] = [];
  const audio = {
    calls,
    volume: -1,
    start: (): Promise<AudioStatus> => Promise.resolve({ ready: true, error: null }),
    open: (): Promise<number> => {
      calls.push('open');
      return Promise.resolve(DURATION_SECONDS);
    },
    play: (): Promise<void> => {
      calls.push('play');
      return Promise.resolve();
    },
    pause: (): Promise<void> => {
      calls.push('pause');
      return Promise.resolve();
    },
    resume: (): Promise<void> => {
      calls.push('resume');
      return Promise.resolve();
    },
    seek: (): Promise<void> => Promise.resolve(),
    setVolume: (level: number): Promise<void> => {
      audio.volume = level;
      return Promise.resolve();
    },
    position: (): Promise<number> => Promise.resolve(0),
    status: (): AudioStatus => ({ ready: true, error: null }),
    stop: (): void => {
      calls.push('stop');
    },
  };
  return audio;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Fades run on timers, and a loaded machine delivers those late. Waiting on the change
 *  rather than on a duration keeps the assertion about behaviour instead of about how
 *  busy the test runner happened to be. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  assert.fail(what);
}

/** The bug this guards was silent and total: the ramp climbed on a device that had never
 *  been told to play, so a recorded track arrived a whole fade late, or not at all. */
test('a fade-in starts the stream at once rather than when the ramp finishes', async () => {
  const audio = fakeAudio();
  const player = createRecordedPlayer(audio);
  await player.load('x.wav');

  player.setAudible({ audible: true, fadeSeconds: 5 });
  assert.ok(audio.calls.includes('play'), 'the stream was not started when the fade began');
  assert.equal(player.state().playing, true);
});

test('a fade-out holds the stream open until the level has actually reached zero', async () => {
  const audio = fakeAudio();
  const player = createRecordedPlayer(audio);
  await player.load('x.wav');
  player.setAudible({ audible: true, fadeSeconds: 0 });

  player.setAudible({ audible: false, fadeSeconds: 0.2 });
  assert.equal(player.state().playing, true, 'pausing this early would cut the fade off');
  assert.ok(!audio.calls.includes('pause'));

  await until(() => !player.state().playing, 'the stream never parked after the fade-out');
  assert.ok(audio.calls.includes('pause'));
  assert.equal(audio.volume, 0);
});

/** MCI refuses `resume` on a device that has never played, so getting this backwards
 *  leaves the first gate-open silent. */
test('the first start plays and a return from silence resumes', async () => {
  const audio = fakeAudio();
  const player = createRecordedPlayer(audio);
  await player.load('x.wav');

  player.setAudible({ audible: true, fadeSeconds: 0 });
  assert.deepEqual(audio.calls.filter((call) => call === 'play' || call === 'resume'), ['play']);

  player.setAudible({ audible: false, fadeSeconds: 0 });
  player.setAudible({ audible: true, fadeSeconds: 0 });
  assert.deepEqual(
    audio.calls.filter((call) => call === 'play' || call === 'resume'),
    ['play', 'resume'],
  );
});

test('a file is opened silent, so it cannot speak before the gate has been consulted', async () => {
  const audio = fakeAudio();
  const player = createRecordedPlayer(audio);
  player.setMasterVolume(100);
  await player.load('x.wav');
  assert.equal(audio.volume, 0);
  assert.equal(player.state().playing, false);
});

test('the master volume scales the gate rather than replacing it', async () => {
  const audio = fakeAudio();
  const player = createRecordedPlayer(audio);
  player.setMasterVolume(50);
  await player.load('x.wav');

  player.setAudible({ audible: true, fadeSeconds: 0 });
  assert.equal(audio.volume, 0.5);

  player.setMasterVolume(20);
  assert.equal(audio.volume, 0.2);

  player.setAudible({ audible: false, fadeSeconds: 0 });
  assert.equal(audio.volume, 0);
});

/** `mute` exists for streams whose transport we cannot pause. Recorded audio honours it
 *  the same way the score does: silent, but still running underneath. */
test('holding the transport keeps the stream running through its own silence', async () => {
  const audio = fakeAudio();
  const player = createRecordedPlayer(audio);
  await player.load('x.wav');
  player.setHoldTransport(true);
  player.setAudible({ audible: true, fadeSeconds: 0 });

  player.setAudible({ audible: false, fadeSeconds: 0 });
  assert.equal(audio.volume, 0, 'the gate still has to reach silence');
  assert.equal(player.state().playing, true, 'the transport should not have been paused');
  assert.ok(!audio.calls.includes('pause'));
});

test('a track that could not be opened never claims the transport', async () => {
  const audio = fakeAudio();
  audio.open = (): Promise<number> => Promise.resolve(0);
  const player = createRecordedPlayer(audio);

  assert.equal(await player.load('missing.wav'), false);
  player.setAudible({ audible: true, fadeSeconds: 0 });
  assert.equal(player.state().playing, false);
  assert.ok(!audio.calls.includes('play'));
});

test('stopping leaves nothing playing and nothing listening', async () => {
  const audio = fakeAudio();
  const player = createRecordedPlayer(audio);
  await player.load('x.wav');
  player.setAudible({ audible: true, fadeSeconds: 0 });

  let ended = 0;
  player.onEnd(() => (ended += 1));
  player.stop();

  assert.ok(audio.calls.includes('stop'));
  assert.equal(player.state().playing, false);
  assert.equal(ended, 0);
});
