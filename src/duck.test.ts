import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDuck } from './duck.ts';
import type { SystemVolume, SystemVolumeStatus, VolumeLevel } from './system-volume.ts';

const DEVICE_ID = 'fake-endpoint';
/** Half a percentage point, matching what the bridge treats as the user's own move. */
const TOLERANCE = 0.5;

type FakeVolume = SystemVolume & {
  /** The endpoint as the user hears it. Assigning to it is the user taking it back. */
  current: VolumeLevel;
  /** Every level the duck asked for. It must never ask for one. */
  levelWrites: number[];
  muteWrites: boolean[];
  restores: number;
  fail: boolean;
  /** How long the bridge takes to answer a `set`, so a command can be genuinely in
   *  flight when teardown arrives. */
  delayMs: number;
};

/** Mirrors `bridge/volume-bridge.ps1`: the state at the first change is the baseline, a
 *  state that has drifted from what we last set belongs to the user again, and a restore
 *  only puts back what is still ours. */
function fakeVolume(startLevel: number): FakeVolume {
  let baseline: VolumeLevel = { level: startLevel, muted: false };
  let held: VolumeLevel | null = null;

  const ours = (): boolean =>
    held !== null &&
    Math.abs(volume.current.level - held.level) <= TOLERANCE &&
    volume.current.muted === held.muted;

  const volume: FakeVolume = {
    current: { level: startLevel, muted: false },
    levelWrites: [],
    muteWrites: [],
    restores: 0,
    fail: false,
    delayMs: 0,
    start: (): Promise<SystemVolumeStatus> => Promise.resolve(volume.status()),
    status: (): SystemVolumeStatus => ({ ready: true, deviceId: DEVICE_ID, error: null }),
    read: (): Promise<VolumeLevel | null> =>
      Promise.resolve(volume.fail ? null : { ...volume.current }),
    set: async ({ level, muted }): Promise<VolumeLevel | null> => {
      if (volume.delayMs > 0) await wait(volume.delayMs);
      if (volume.fail) return null;
      if (level !== undefined) volume.levelWrites.push(level);
      if (muted !== undefined) volume.muteWrites.push(muted);
      if (!ours()) baseline = { ...volume.current };
      volume.current = {
        level: level ?? volume.current.level,
        muted: muted ?? volume.current.muted,
      };
      held = { ...volume.current };
      return { ...volume.current };
    },
    baseline: (): VolumeLevel | null => ({ ...baseline }),
    restore: (): Promise<VolumeLevel | null> => {
      if (volume.fail) return Promise.resolve(null);
      volume.restores += 1;
      if (ours()) volume.current = { ...baseline };
      held = null;
      return Promise.resolve({ ...volume.current });
    },
    stop: (): Promise<void> => {
      if (ours()) volume.current = { ...baseline };
      held = null;
      return Promise.resolve();
    },
  };
  return volume;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The bridge is asked asynchronously, so waiting on the change rather than on a duration
 *  keeps the assertion about behaviour instead of about how busy the runner was. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail(what);
}

test('a closed gate mutes the endpoint, and an open one gives it back', async () => {
  const volume = fakeVolume(70);
  const duck = createDuck({ volume });
  await duck.start();
  assert.equal(volume.current.muted, false, 'starting must not change anything');

  duck.setAudible({ audible: false, fadeSeconds: 1 });
  await until(() => volume.current.muted, 'the gate closing never muted the endpoint');
  assert.equal(volume.current.level, 70, 'the level is not ours to move');

  duck.setAudible({ audible: true, fadeSeconds: 1 });
  await until(() => !volume.current.muted, 'the gate opening never unmuted the endpoint');
  assert.equal(volume.current.level, 70);

  await duck.stop();
});

/** Muting is the whole signal, and it was chosen over a level of zero deliberately: the
 *  tray icon shows a muted speaker, where silence at full level reads as broken hardware.
 *  A ramp down to zero must not creep back in. */
test('the level is never written, at zero or at anything else', async () => {
  const volume = fakeVolume(55);
  const duck = createDuck({ volume });
  await duck.start();

  for (let round = 0; round < 3; round += 1) {
    duck.setAudible({ audible: false, fadeSeconds: 2 });
    await until(() => volume.current.muted, 'the gate never closed');
    duck.setAudible({ audible: true, fadeSeconds: 2 });
    await until(() => !volume.current.muted, 'the gate never opened');
  }

  assert.deepEqual(volume.levelWrites, [], 'the duck asked for a level');
  assert.equal(volume.current.level, 55, 'the level drifted');
  await duck.stop();
});

test('stopping leaves the endpoint unmuted', async () => {
  const volume = fakeVolume(42);
  const duck = createDuck({ volume });
  await duck.start();

  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await until(() => volume.current.muted, 'the gate never closed');

  await duck.stop();
  assert.equal(volume.current.muted, false, 'a muted machine outlived the daemon');
  assert.equal(volume.current.level, 42);
});

/** The failure that matters: a mute the bridge is still working on must not land after the
 *  restore that was supposed to undo it, or the machine is left silent. */
test('a mute still in flight cannot outlive the stop that follows it', async () => {
  const volume = fakeVolume(80);
  const duck = createDuck({ volume });
  await duck.start();
  volume.delayMs = 80;

  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await wait(20);
  assert.equal(volume.current.muted, false, 'the mute should still be in flight here');

  await duck.stop();
  assert.deepEqual(volume.muteWrites, [true], 'the mute never actually reached the bridge');
  assert.equal(volume.current.muted, false, 'the endpoint was left muted');
  assert.equal(volume.current.level, 80);

  await wait(200);
  assert.equal(volume.current.muted, false, 'a queued command muted the endpoint after stop');
});

test('a duck that never started leaves the endpoint alone', async () => {
  const volume = fakeVolume(33);
  const duck = createDuck({ volume });

  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await wait(50);
  assert.deepEqual(volume.muteWrites, []);
  assert.equal(volume.restores, 0, 'a claim we never made is not ours to release');

  await duck.stop();
  assert.equal(volume.current.muted, false);
  assert.equal(volume.current.level, 33);
});

test('switching the gate repeatedly settles where the last switch asked', async () => {
  const volume = fakeVolume(60);
  const duck = createDuck({ volume });
  await duck.start();

  for (let round = 0; round < 6; round += 1) {
    duck.setAudible({ audible: false, fadeSeconds: 0 });
    duck.setAudible({ audible: true, fadeSeconds: 0 });
  }
  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await until(() => volume.current.muted, 'the last switch never landed');
  await wait(100);
  assert.equal(volume.current.muted, true, 'a stale command undid the last switch');

  duck.setAudible({ audible: true, fadeSeconds: 0 });
  await until(() => !volume.current.muted, 'the gate never reopened');
  await wait(100);
  assert.equal(volume.current.muted, false);
  assert.equal(volume.current.level, 60, 'the level survived the toggling');

  await duck.stop();
  assert.equal(volume.current.muted, false);
});

test('a gate that has not moved is not reissued to the bridge', async () => {
  const volume = fakeVolume(50);
  const duck = createDuck({ volume });
  await duck.start();

  for (let round = 0; round < 5; round += 1) duck.setAudible({ audible: false, fadeSeconds: 0 });
  await until(() => volume.current.muted, 'the gate never closed');
  await wait(50);
  assert.deepEqual(volume.muteWrites, [true], 'the same gate was sent more than once');

  await duck.stop();
});

test('a bridge that fails leaves the gate to be retried, not assumed applied', async () => {
  const volume = fakeVolume(90);
  const duck = createDuck({ volume });
  await duck.start();

  volume.fail = true;
  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await wait(50);
  assert.equal(volume.current.muted, false, 'a failed command must not change the endpoint');

  volume.fail = false;
  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await until(() => volume.current.muted, 'the gate was never retried once the bridge came back');

  await duck.stop();
  assert.equal(volume.current.muted, false);
});

test('a flag the user cleared themselves is not set again behind them', async () => {
  const volume = fakeVolume(25);
  const duck = createDuck({ volume });
  await duck.start();

  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await until(() => volume.current.muted, 'the gate never closed');

  // The user unmutes from the tray while the agent is still waiting on them.
  volume.current = { level: 25, muted: false };
  duck.setAudible({ audible: false, fadeSeconds: 0 });
  await wait(50);
  assert.equal(volume.current.muted, false, 'we muted over the user unmuting themselves');

  await duck.stop();
  assert.equal(volume.current.muted, false);
});
