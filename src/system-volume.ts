/** Controls the Windows system output volume, so LLMFM can ride whatever the user is
 *  already playing — Spotify, a browser, a phone bridged in as system audio — and duck
 *  or mute it when an agent needs them. We can only change the level of someone else's
 *  stream, never pause it.
 *
 *  The level belongs to the user, so it is borrowed rather than owned:
 *  - The level at the moment of the first change is the baseline, and the bridge restores
 *    it whenever it is given the chance to run: a clean stop, a lost stdin, or the
 *    process that owns it exiting. See `bridge/volume-bridge.ps1`.
 *  - A hard kill of the daemon takes the bridge down with it and no restore can run, so
 *    the baseline is also written to a claim file and put back by the next start.
 *  - A level the user moved themselves is never restored over, and becomes the new
 *    baseline instead. Fighting a user for their own volume slider is worse than
 *    leaving the music loud.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { copilotHooksDir } from './install.ts';

const BRIDGE_SCRIPT = path.join(import.meta.dirname, '..', 'bridge', 'volume-bridge.ps1');
/** Generous because the bridge's first run pays for an Add-Type compile. */
const BRIDGE_START_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 5000;
/** The Core Audio scalar is 0..1; the product speaks in percent. */
const LEVEL_SCALE = 100;
const SCALAR_DIGITS = 6;
/** Half a percentage point, below any step the volume keys or the slider take. */
const MANUAL_CHANGE_TOLERANCE = 0.5;
const CLAIM_FILE_NAME = 'llmfm-volume-claim.json';

/** Level is 0–100, matching the Windows volume slider. */
export type VolumeLevel = { level: number; muted: boolean };

export type SystemVolumeStatus = {
  ready: boolean;
  /** Core Audio endpoint id of the device we hold, or null before the bridge reports. */
  deviceId: string | null;
  error: string | null;
};

/** What we would put back: the level as it was before we first touched it. */
type VolumeReading = { current: VolumeLevel; baseline: VolumeLevel };

/** Written before the first change and removed once the level is back, so a level left
 *  behind by a killed bridge can be recovered on the next start. */
type VolumeClaim = {
  deviceId: string;
  baseline: VolumeLevel;
  /** What we left the level at. The next start restores only if it is still there. */
  held: VolumeLevel;
  at: number;
};

export type SystemVolume = {
  /** Resolves once the bridge reports the endpoint or fails. Never rejects. */
  start(): Promise<SystemVolumeStatus>;
  status(): SystemVolumeStatus;
  read(): Promise<VolumeLevel | null>;
  /** Captures the baseline on the first call. Omitted fields keep their current value. */
  set(target: { level?: number; muted?: boolean }): Promise<VolumeLevel | null>;
  /** What the level would return to, or null before anything has been read. */
  baseline(): VolumeLevel | null;
  restore(): Promise<VolumeLevel | null>;
  /** Restores the level and ends the bridge process. */
  stop(): Promise<void>;
};

export function claimPath(): string {
  return path.join(path.dirname(copilotHooksDir()), CLAIM_FILE_NAME);
}

function toScalar(level: number): string {
  return Math.min(1, Math.max(0, level / LEVEL_SCALE)).toFixed(SCALAR_DIGITS);
}

function parseLevel(scalar: string | undefined, mute: string | undefined): VolumeLevel | null {
  const value = Number(scalar);
  if (!Number.isFinite(value) || (mute !== '0' && mute !== '1')) return null;
  return { level: value * LEVEL_SCALE, muted: mute === '1' };
}

function sameLevel(a: VolumeLevel, b: VolumeLevel): boolean {
  return Math.abs(a.level - b.level) <= MANUAL_CHANGE_TOLERANCE && a.muted === b.muted;
}

/** The file is on disk between runs and may be hand-edited or truncated by a crash, so
 *  anything unexpected means no claim rather than a malformed one. */
function readClaim(): VolumeClaim | null {
  const file = claimPath();
  if (!existsSync(file)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const deviceId = record['deviceId'];
  const at = record['at'];
  const baseline = asVolumeLevel(record['baseline']);
  const held = asVolumeLevel(record['held']);
  if (typeof deviceId !== 'string' || typeof at !== 'number' || !baseline || !held) return null;
  return { deviceId, baseline, held, at };
}

function asVolumeLevel(value: unknown): VolumeLevel | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const level = record['level'];
  const muted = record['muted'];
  if (typeof level !== 'number' || !Number.isFinite(level) || typeof muted !== 'boolean') {
    return null;
  }
  return { level, muted };
}

function writeClaim(claim: VolumeClaim): void {
  const file = claimPath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`);
  } catch {
    // A claim we cannot persist only costs us the recovery path after a kill; the
    // bridge's own restore still covers every other way the daemon can die.
  }
}

function clearClaim(): void {
  try {
    rmSync(claimPath(), { force: true });
  } catch {
    // Same reasoning as writeClaim: recovery is the backstop, not the mechanism.
  }
}

export function createSystemVolume(): SystemVolume {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let state: SystemVolumeStatus = { ready: false, deviceId: null, error: null };
  let last: VolumeReading | null = null;
  /** One in-flight command at a time; the bridge answers each line in order. */
  const waiting: Array<(line: string) => void> = [];

  const fail = (error: string): void => {
    state = { ready: false, deviceId: state.deviceId, error };
    while (waiting.length > 0) waiting.shift()?.(`ERR ${error}`);
  };

  const request = (command: string): Promise<VolumeReading | null> => {
    if (!state.ready || !proc) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => settle('ERR bridge did not answer'), COMMAND_TIMEOUT_MS);
      timer.unref();

      const settle = (line: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parts = line.split(' ');
        const current = parseLevel(parts[1], parts[2]);
        const baseline = parseLevel(parts[3], parts[4]);
        if (parts[0] !== 'V' || !current || !baseline) {
          state = { ...state, error: line.startsWith('ERR ') ? line.slice('ERR '.length) : line };
          resolve(null);
          return;
        }
        last = { current, baseline };
        resolve(last);
      };

      waiting.push(settle);
      try {
        proc?.stdin.write(`${command}\n`);
      } catch {
        fail('bridge stdin closed');
      }
    });
  };

  /** A level left behind when the daemon and its bridge were killed together. Restored
   *  only when it is still exactly where we left it — if the user has since moved it,
   *  that is their choice and the claim is stale. */
  const recover = async (): Promise<void> => {
    const claim = readClaim();
    if (!claim) return;
    if (claim.deviceId !== state.deviceId || !last || !sameLevel(last.current, claim.held)) {
      clearClaim();
      return;
    }
    const baseline = claim.baseline;
    await request(`B ${toScalar(baseline.level)} ${baseline.muted ? 1 : 0}`);
    clearClaim();
  };

  return {
    start(): Promise<SystemVolumeStatus> {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (next: SystemVolumeStatus): void => {
          state = next;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(next);
        };

        const timer = setTimeout(
          () => settle({ ready: false, deviceId: null, error: 'bridge did not report an endpoint' }),
          BRIDGE_START_TIMEOUT_MS,
        );
        timer.unref();

        try {
          proc = spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE_SCRIPT, '-ParentPid', String(process.pid)],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
        } catch (error) {
          settle({ ready: false, deviceId: null, error: String(error) });
          return;
        }

        proc.stdin.on('error', () => fail('bridge stdin closed'));

        let pending = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk: string) => {
          pending += chunk;
          let breakAt = pending.indexOf('\n');
          while (breakAt >= 0) {
            const line = pending.slice(0, breakAt).trim();
            pending = pending.slice(breakAt + 1);
            if (line.startsWith('OK ')) {
              const parts = line.split(' ');
              const current = parseLevel(parts[1], parts[2]);
              const deviceId = parts[3];
              if (current && deviceId) {
                last = { current, baseline: current };
                // Ready before the claim is honoured, because recovery goes through the
                // same commands; start() still only resolves once the level is settled.
                state = { ready: true, deviceId, error: null };
                void recover().then(() => settle(state));
              } else {
                settle({ ready: false, deviceId: null, error: 'bridge reported no endpoint' });
              }
            } else if (line.startsWith('ERR ') && !settled) {
              settle({ ready: false, deviceId: null, error: line.slice('ERR '.length) });
            } else if (waiting.length > 0) {
              waiting.shift()?.(line);
            }
            breakAt = pending.indexOf('\n');
          }
        });

        proc.on('error', (error) => settle({ ready: false, deviceId: null, error: error.message }));
        proc.on('exit', () => {
          proc = null;
          fail(state.error ?? 'bridge exited');
          settle({ ready: false, deviceId: null, error: state.error });
        });
      });
    },

    status(): SystemVolumeStatus {
      return state;
    },

    async read(): Promise<VolumeLevel | null> {
      return (await request('G'))?.current ?? null;
    },

    async set(target: { level?: number; muted?: boolean }): Promise<VolumeLevel | null> {
      const current = await request('G');
      if (!current) return null;
      const level = target.level ?? current.current.level;
      const muted = target.muted ?? current.current.muted;
      const reading = await request(`S ${toScalar(level)} ${muted ? 1 : 0}`);
      if (!reading || !state.deviceId) return null;
      writeClaim({
        deviceId: state.deviceId,
        baseline: reading.baseline,
        held: reading.current,
        at: Date.now(),
      });
      return reading.current;
    },

    baseline(): VolumeLevel | null {
      return last?.baseline ?? null;
    },

    async restore(): Promise<VolumeLevel | null> {
      const reading = await request('R');
      clearClaim();
      return reading?.current ?? null;
    },

    async stop(): Promise<void> {
      if (state.ready) await request('R');
      clearClaim();
      state = { ready: false, deviceId: state.deviceId, error: state.error };
      try {
        proc?.stdin.write('Q\n');
        proc?.stdin.end();
      } catch {
        // The bridge restores on lost stdin regardless of whether Q arrives.
      }
      proc = null;
    },
  };
}
