/** Drives the real Core Audio endpoint. The risk this module carries is entirely in the
 *  COM interop and in the restore paths, neither of which a stubbed test would touch.
 *
 *  Every case moves the level a few points from wherever it already sits and puts it
 *  back: someone may be listening to something on this machine. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSystemVolume, claimPath } from './system-volume.ts';
import type { VolumeLevel } from './system-volume.ts';

const MODULE_PATH = path.join(import.meta.dirname, 'system-volume.ts');
/** Distinguishable from the starting level without being audible as a jump. */
const NUDGE_POINTS = 6;
/** Endpoints may quantize a scalar to their own steps, so a set never lands exactly. */
const READBACK_TOLERANCE = 1.5;
const RESTORE_TOLERANCE = 1.0;
/** Leaves no doubt that nothing restored the level before the next start did. */
const AFTER_KILL_SETTLE_MS = 2000;

let home: string;
let startedFrom: VolumeLevel;
let deviceId: string;

before(async () => {
  // Keeps the claim file out of the real install while the daemon is running.
  home = mkdtempSync(path.join(tmpdir(), 'llmfm-volume-'));
  process.env['LLMFM_HOME'] = home;

  const volume = createSystemVolume();
  const status = await volume.start();
  assert.ok(status.ready && status.deviceId, status.error ?? 'no endpoint');
  deviceId = status.deviceId;
  const level = await volume.read();
  assert.ok(level);
  startedFrom = level;
  await volume.stop();
});

after(async () => {
  // One case deliberately ends with a level the module must not take back, so the suite
  // returns the machine itself — through the same claim a hard-killed daemon leaves.
  const volume = createSystemVolume();
  const status = await volume.start();
  const current = status.ready ? await volume.read() : null;
  await volume.stop();
  if (current) {
    writeFileSync(
      claimPath(),
      JSON.stringify({ deviceId, baseline: startedFrom, held: current, at: Date.now() }),
    );
    const recovering = createSystemVolume();
    await recovering.start();
    await recovering.stop();
  }
  rmSync(home, { recursive: true, force: true });
});

/** A level a few points from `from`, kept well inside the range so no test can leave a
 *  machine silent or deafening even if a restore fails. */
function nudged(from: number): number {
  return from > 20 ? from - NUDGE_POINTS : from + NUDGE_POINTS;
}

test('reads, sets and restores the system volume', async () => {
  const volume = createSystemVolume();
  const startedAt = Date.now();
  const status = await volume.start();
  console.log(`bridge start: ${Date.now() - startedAt}ms, endpoint ${status.deviceId}`);
  assert.equal(status.ready, true, status.error ?? '');

  try {
    const original = await volume.read();
    assert.ok(original, 'read returned a level');

    const target = nudged(original.level);
    const applied = await volume.set({ level: target });
    assert.ok(applied, 'set returned a level');
    const observed = await volume.read();
    assert.ok(observed && Math.abs(observed.level - target) <= READBACK_TOLERANCE);

    const baseline = volume.baseline();
    assert.ok(baseline && Math.abs(baseline.level - original.level) <= RESTORE_TOLERANCE);

    const restored = await volume.restore();
    assert.ok(restored && Math.abs(restored.level - original.level) <= RESTORE_TOLERANCE);
    console.log(
      `before ${original.level.toFixed(1)} -> set ${observed.level.toFixed(1)} -> restored ${restored.level.toFixed(1)}`,
    );
  } finally {
    await volume.stop();
  }
});

test('leaves a level the user moved themselves alone', async () => {
  const ours = createSystemVolume();
  const user = createSystemVolume();
  assert.equal((await ours.start()).ready, true);
  assert.equal((await user.start()).ready, true);

  try {
    const original = await ours.read();
    assert.ok(original);
    await ours.set({ level: nudged(original.level) });

    // Stands in for the user reaching for the volume keys while we hold it ducked.
    const chosen = nudged(nudged(original.level));
    await user.set({ level: chosen });

    const afterRestore = await ours.restore();
    assert.ok(afterRestore && Math.abs(afterRestore.level - chosen) <= READBACK_TOLERANCE);
    console.log(`user chose ${chosen.toFixed(1)}, restore left ${afterRestore.level.toFixed(1)}`);
  } finally {
    await user.stop();
    await ours.stop();
  }
});

/** The crash case the product actually has to survive: a hard-killed daemon takes the
 *  bridge down with it on Windows, so nothing can restore the level at the time. What
 *  must hold is that the claim it left behind brings the level back on the next start. */
test('recovers a level left behind by a hard-killed daemon', async () => {
  const script = path.join(home, 'duck-and-die.ts');
  writeFileSync(
    script,
    `import { createSystemVolume } from ${JSON.stringify(pathToFileURL(MODULE_PATH).href)};\n` +
      `const volume = createSystemVolume();\n` +
      `await volume.start();\n` +
      `const original = await volume.read();\n` +
      `const held = await volume.set({ level: original.level > 20 ? original.level - ${NUDGE_POINTS} : original.level + ${NUDGE_POINTS} });\n` +
      `console.log(JSON.stringify({ original, held }));\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  const ducked = await new Promise<{ original: VolumeLevel; held: VolumeLevel }>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.includes('\n')) resolve(JSON.parse(out.trim()));
    });
    child.on('exit', () => reject(new Error(`child exited early: ${out}`)));
  });

  child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, AFTER_KILL_SETTLE_MS));

  const claim = JSON.parse(readFileSync(claimPath(), 'utf8')) as { baseline: VolumeLevel };
  assert.ok(Math.abs(claim.baseline.level - ducked.original.level) <= RESTORE_TOLERANCE);

  const restarted = createSystemVolume();
  assert.equal((await restarted.start()).ready, true);
  try {
    const recovered = await restarted.read();
    assert.ok(recovered && Math.abs(recovered.level - ducked.original.level) <= RESTORE_TOLERANCE);
    assert.equal(existsSync(claimPath()), false, 'the claim is cleared once it is honoured');
    console.log(
      `daemon killed holding ${ducked.held.level.toFixed(1)}, next start recovered ${recovered.level.toFixed(1)} (was ${ducked.original.level.toFixed(1)})`,
    );
  } finally {
    await restarted.stop();
  }
});
