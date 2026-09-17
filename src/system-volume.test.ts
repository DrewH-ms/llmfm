/** Hits the real endpoint, so every case nudges the level a few points and puts it back. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSystemVolume, claimPath } from './system-volume.ts';
import type { ChildProcess } from 'node:child_process';
import type { SystemVolume, VolumeLevel } from './system-volume.ts';

const MODULE_PATH = path.join(import.meta.dirname, 'system-volume.ts');
/** Distinguishable from the starting level without being audible as a jump. */
const NUDGE_POINTS = 6;
/** Endpoints may quantize a scalar to their own steps, so a set never lands exactly. */
const READBACK_TOLERANCE = 1.5;
const RESTORE_TOLERANCE = 1.0;
/** Leaves no doubt that nothing restored the level before the next start did. */
const AFTER_KILL_SETTLE_MS = 2000;
/** A player with no display name of its own is listed under the host that started it. */
const PLAYER_SESSION_NAME = 'powershell';
const SESSION_SETTLE_TIMEOUT_MS = 20000;
/** Long enough to see the child exit, short enough to fail a test rather than hang it. */
const BRIDGE_DEATH_TIMEOUT_MS = 5000;

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
  // One case ends on a level the module must not take back, so the suite returns it via a claim.
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

/** Kept well inside the range, so no failed restore can leave a machine silent or deafening. */
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

/** A hard kill takes the bridge down too, so only the claim it left can restore the level. */
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

/** Silent, because a real render session must exist and someone may be listening. */
function writeSilentWav(file: string): void {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

function startPlayer(wav: string): ChildProcess {
  return spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$player = New-Object Media.SoundPlayer ${JSON.stringify(wav)}; $player.PlayLooping(); Start-Sleep -Seconds 120`,
    ],
    { stdio: 'ignore' },
  );
}

async function countMatching(volume: SystemVolume, name: string): Promise<number> {
  const sessions = await volume.sessions();
  return sessions.filter((session) => session.name.toLowerCase().includes(name)).length;
}

/** Two players, because one name covers several sessions and a gate stopping at the first leaves audio playing. */
test('gates every live session matching a name, and nothing when none does', async () => {
  const wav = path.join(home, 'silence.wav');
  writeSilentWav(wav);

  const volume = createSystemVolume();
  assert.equal((await volume.start()).ready, true);
  const players = [startPlayer(wav), startPlayer(wav)];

  try {
    const before = await countMatching(volume, PLAYER_SESSION_NAME);
    const deadline = Date.now() + SESSION_SETTLE_TIMEOUT_MS;
    let live = before;
    while (live < before + players.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      live = await countMatching(volume, PLAYER_SESSION_NAME);
    }
    assert.equal(live, before + players.length, 'the players never appeared as live sessions');
    console.log(
      `live sessions: ${(await volume.sessions()).map((s) => `${s.processId} ${s.name}`).join(' | ')}`,
    );

    const endpointBefore = await volume.read();
    assert.ok(endpointBefore);
    const muted = await volume.setSessionMute({ name: PLAYER_SESSION_NAME, muted: true });
    assert.equal(muted, live, 'not every live match was gated');
    assert.equal(volume.status().gated, true, 'a closed gate was not published');
    assert.equal(volume.status().gatedSessions, live);
    const endpoint = await volume.read();
    assert.deepEqual(endpoint, endpointBefore, 'a session gate must leave the endpoint where it was');

    const unmuted = await volume.setSessionMute({ name: PLAYER_SESSION_NAME, muted: false });
    assert.equal(unmuted, live);
    assert.equal(volume.status().gated, false, 'an open gate was still published as closed');
    assert.equal(volume.status().gatedSessions, 0);
    assert.equal(existsSync(claimPath()), false, 'the claim is released once the gate reopens');

    const missed = await volume.setSessionMute({ name: 'llmfm-no-such-session', muted: true });
    assert.equal(missed, 0, 'a name nothing answers to must report nothing gated');
    assert.equal(volume.status().gated, false, 'a gate that reached nothing reads as silence');
    assert.equal(existsSync(claimPath()), false, 'a gate that matched nothing claimed anyway');
  } finally {
    for (const player of players) player.kill();
    await volume.setSessionMute({ name: PLAYER_SESSION_NAME, muted: false });
    await volume.stop();
  }
});

/** Stands in for the bridge dying on its own while the daemon carries on and later stops tidily. */
function killBridges(): void {
  // Our own query process carries the script name too, so it must be told apart from the bridges.
  const found = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ` +
        `Where-Object { $_.CommandLine -like '*volume-bridge.ps1*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | ` +
        'Select-Object -ExpandProperty ProcessId',
    ],
    { encoding: 'utf8' },
  );
  for (const pid of found.trim().split(/\s+/).filter(Boolean)) {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`],
      { stdio: 'ignore' },
    );
  }
}

/** Nothing restored the level, so a stop that deletes the claim is how a mute becomes permanent. */
test('keeps the claim when the bridge died before the daemon stopped', async () => {
  const volume = createSystemVolume();
  assert.equal((await volume.start()).ready, true);

  const original = await volume.read();
  assert.ok(original);
  assert.ok(await volume.set({ level: nudged(original.level) }), 'set returned no level');
  assert.ok(existsSync(claimPath()), 'ducking the endpoint wrote no claim');

  killBridges();
  const deadline = Date.now() + BRIDGE_DEATH_TIMEOUT_MS;
  while (volume.status().ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(volume.status().ready, false, 'the killed bridge was never noticed');

  await volume.stop();
  assert.ok(existsSync(claimPath()), 'a stop that restored nothing threw the claim away');

  const restarted = createSystemVolume();
  assert.equal((await restarted.start()).ready, true);
  try {
    const recovered = await restarted.read();
    assert.ok(recovered && Math.abs(recovered.level - original.level) <= RESTORE_TOLERANCE);
    assert.equal(existsSync(claimPath()), false, 'the claim outlived the start that honoured it');
    console.log(`bridge killed holding a duck, next start recovered ${recovered.level.toFixed(1)}`);
  } finally {
    await restarted.stop();
  }
});

/** A session mute belongs to the audio service, so there is no level left to compare against. */
test('clears a session mute left behind by a killed daemon', async () => {
  const volume = createSystemVolume();
  const status = await volume.start();
  assert.equal(status.ready, true);
  const level = await volume.read();
  assert.ok(level && status.deviceId);
  await volume.stop();

  writeFileSync(
    claimPath(),
    JSON.stringify({
      deviceId: status.deviceId,
      baseline: level,
      held: level,
      sessionName: PLAYER_SESSION_NAME,
      at: Date.now(),
    }),
  );

  const restarted = createSystemVolume();
  assert.equal((await restarted.start()).ready, true);
  try {
    assert.equal(existsSync(claimPath()), false, 'the claim outlived the start that honoured it');
    const after = await restarted.read();
    assert.ok(after && Math.abs(after.level - level.level) <= RESTORE_TOLERANCE);
    assert.equal(after.muted, level.muted, 'clearing a session claim moved the endpoint');
  } finally {
    await restarted.stop();
  }
});

/** `R` moves a level and can never unmute a session, so it must not drop the session's claim. */
test('an endpoint restore does not release a session claim it cannot have lifted', async () => {
  const wav = path.join(home, 'silence.wav');
  writeSilentWav(wav);

  const volume = createSystemVolume();
  assert.equal((await volume.start()).ready, true);
  const player = startPlayer(wav);

  try {
    const before = await countMatching(volume, PLAYER_SESSION_NAME);
    const deadline = Date.now() + SESSION_SETTLE_TIMEOUT_MS;
    let live = before;
    while (live <= before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      live = await countMatching(volume, PLAYER_SESSION_NAME);
    }
    assert.ok(live > before, 'the player never appeared as a live session');

    const acted = await volume.setSessionMute({ name: PLAYER_SESSION_NAME, muted: true });
    assert.ok(acted !== null && acted > 0, 'nothing was gated');
    assert.ok(existsSync(claimPath()), 'gating a session wrote no claim');

    assert.ok(await volume.restore(), 'the endpoint restore did not answer');
    assert.ok(existsSync(claimPath()), 'an endpoint restore threw away a session claim');

    assert.ok((await volume.setSessionMute({ name: PLAYER_SESSION_NAME, muted: false })) !== null);
    assert.equal(existsSync(claimPath()), false, 'the claim outlived the unmute that honoured it');
  } finally {
    player.kill();
    await volume.setSessionMute({ name: PLAYER_SESSION_NAME, muted: false });
    await volume.stop();
  }
});
