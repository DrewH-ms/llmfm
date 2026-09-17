/** The user's volume is borrowed: the bridge restores the baseline when it can, the claim file covers a hard kill, and a level the user moved becomes the new baseline. */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { llmfmHome } from './paths.ts';

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
const ERROR_PREFIX = 'ERR ';
const ACTED_PREFIX = 'A ';
const SESSION_PREFIX = 'P ';
const SESSION_LIST_END_PREFIX = 'N ';
/** No gate of ours is in place: the state every path that gives the endpoint back returns to. */
const UNGATED = { gated: false, gatedSessions: 0 };

/** Level is 0–100, matching the Windows volume slider. */
export type VolumeLevel = { level: number; muted: boolean };

/** A playback stream on the endpoint, named as the volume mixer names it. */
export type AudioSession = { processId: number; name: string };

export type SystemVolumeStatus = {
  ready: boolean;
  /** Core Audio endpoint id of the device we hold, or null before the bridge reports. */
  deviceId: string | null;
  /** True while a mute we applied is in place — the silence downstream hears is ours. */
  gated: boolean;
  /** How many audio sessions that mute reached. Zero while the endpoint carries the gate. */
  gatedSessions: number;
  error: string | null;
};

/** What we would put back: the level as it was before we first touched it. */
type VolumeReading = { current: VolumeLevel; baseline: VolumeLevel };

/** Written before the first change and removed once the level is back, so a level left by a killed bridge is recoverable on the next start. */
type VolumeClaim = {
  deviceId: string;
  baseline: VolumeLevel;
  /** What we left the level at. The next start restores only if it is still there. */
  held: VolumeLevel;
  /** The session we muted instead of the endpoint; it outlives us because it belongs to the audio service. */
  sessionName: string | null;
  at: number;
};

export type SystemVolume = {
  /** Resolves once the bridge reports the endpoint or fails. Never rejects. */
  start(): Promise<SystemVolumeStatus>;
  status(): SystemVolumeStatus;
  read(): Promise<VolumeLevel | null>;
  /** Captures the baseline on the first call. Omitted fields keep their current value. */
  set(target: { level?: number; muted?: boolean }): Promise<VolumeLevel | null>;
  /** Gates every live session whose mixer name contains `name`, case-insensitively, and reports how many were acted on. */
  setSessionMute(options: { name: string; muted: boolean }): Promise<number | null>;
  /** The live playback streams on the endpoint. */
  sessions(): Promise<AudioSession[]>;
  /** What the level would return to, or null before anything has been read. */
  baseline(): VolumeLevel | null;
  restore(): Promise<VolumeLevel | null>;
  /** Restores the level and ends the bridge process. */
  stop(): Promise<void>;
};

export function claimPath(): string {
  return path.join(llmfmHome(), CLAIM_FILE_NAME);
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

/** The file may be hand-edited or truncated by a crash, so anything unexpected means no claim. */
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
  const sessionName = record['sessionName'];
  const baseline = asVolumeLevel(record['baseline']);
  const held = asVolumeLevel(record['held']);
  if (typeof deviceId !== 'string' || typeof at !== 'number' || !baseline || !held) return null;
  return { deviceId, baseline, held, sessionName: typeof sessionName === 'string' ? sessionName : null, at };
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
    // A claim we cannot persist only costs the post-kill recovery path; the bridge's own restore covers every other death.
  }
}

function clearClaim(): void {
  try {
    rmSync(claimPath(), { force: true });
  } catch {
    // Same reasoning as writeClaim: recovery is the backstop, not the mechanism.
  }
}

/** Which gate a restore confirmably reopened: an endpoint restore cannot lift a session mute, nor the reverse. */
type RestoredGate = { kind: 'endpoint' } | { kind: 'session'; name: string };

/** The claim is the last thing that can still unmute the user after a kill, so only a restore that undid the gate it records releases it. */
function releaseClaim(restored: RestoredGate): void {
  const claim = readClaim();
  if (!claim) return;
  const undone =
    restored.kind === 'session' ? claim.sessionName === restored.name : claim.sessionName === null;
  if (undone) clearClaim();
}

export function createSystemVolume(): SystemVolume {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let state: SystemVolumeStatus = { ready: false, deviceId: null, ...UNGATED, error: null };
  let last: VolumeReading | null = null;
  /** One in-flight command at a time; the bridge answers each line in order. */
  const waiting: Array<(line: string) => void> = [];

  const fail = (error: string): void => {
    state = { ready: false, deviceId: state.deviceId, ...UNGATED, error };
    while (waiting.length > 0) waiting.shift()?.(`${ERROR_PREFIX}${error}`);
  };

  /** Collects reply lines until `isLast` accepts one. Resolves empty when the bridge is not running. */
  const exchange = (options: {
    command: string;
    isLast: (line: string) => boolean;
  }): Promise<string[]> => {
    if (!state.ready || !proc) return Promise.resolve([]);
    return new Promise((resolve) => {
      const lines: string[] = [];
      let settled = false;

      const finish = (line: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.push(line);
        resolve(lines);
      };

      const receive = (line: string): void => {
        if (settled) return;
        if (line.startsWith(ERROR_PREFIX) || options.isLast(line)) {
          finish(line);
          return;
        }
        lines.push(line);
        waiting.push(receive);
      };

      const timer = setTimeout(
        () => finish(`${ERROR_PREFIX}bridge did not answer`),
        COMMAND_TIMEOUT_MS,
      );
      timer.unref();

      waiting.push(receive);
      try {
        proc?.stdin.write(`${options.command}\n`);
      } catch {
        fail('bridge stdin closed');
      }
    });
  };

  const refuse = (line: string): null => {
    state = {
      ...state,
      error: line.startsWith(ERROR_PREFIX) ? line.slice(ERROR_PREFIX.length) : line,
    };
    return null;
  };

  const request = async (command: string): Promise<VolumeReading | null> => {
    const line = (await exchange({ command, isLast: () => true }))[0];
    if (!line) return null;
    const parts = line.split(' ');
    const current = parseLevel(parts[1], parts[2]);
    const baseline = parseLevel(parts[3], parts[4]);
    if (parts[0] !== 'V' || !current || !baseline) return refuse(line);
    last = { current, baseline };
    // The bridge follows the default endpoint, so the claim's device can change under a running daemon.
    if (parts[5]) state = { ...state, deviceId: parts[5] };
    return last;
  };

  const gateSessions = async (options: { name: string; muted: boolean }): Promise<number | null> => {
    const command = `${options.muted ? 'M' : 'U'} ${options.name}`;
    const line = (await exchange({ command, isLast: () => true }))[0];
    if (!line) return null;
    if (!line.startsWith(ACTED_PREFIX)) return refuse(line);
    const acted = Number(line.slice(ACTED_PREFIX.length));
    return Number.isFinite(acted) ? acted : refuse(line);
  };

  /** Restores a killed-together level only if it is still exactly where we left it; if the user has moved it, the claim is stale. */
  const recover = async (): Promise<void> => {
    const claim = readClaim();
    if (!claim) return;
    if (claim.sessionName) {
      // A session mute belongs to no device level, so it is cleared whatever the endpoint has done since.
      const acted = await gateSessions({ name: claim.sessionName, muted: false });
      if (acted === null) return;
    } else if (claim.deviceId === state.deviceId && last && sameLevel(last.current, claim.held)) {
      const baseline = claim.baseline;
      if (!(await request(`B ${toScalar(baseline.level)} ${baseline.muted ? 1 : 0}`))) return;
    }
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
          () => settle({ ready: false, deviceId: null, ...UNGATED, error: 'bridge did not report an endpoint' }),
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
          settle({ ready: false, deviceId: null, ...UNGATED, error: String(error) });
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
                // Ready before the claim is honoured, because recovery goes through the same commands.
                state = { ready: true, deviceId, ...UNGATED, error: null };
                void recover().then(() => settle(state));
              } else {
                settle({ ready: false, deviceId: null, ...UNGATED, error: 'bridge reported no endpoint' });
              }
            } else if (line.startsWith('ERR ') && !settled) {
              settle({ ready: false, deviceId: null, ...UNGATED, error: line.slice(ERROR_PREFIX.length) });
            } else if (waiting.length > 0) {
              waiting.shift()?.(line);
            }
            breakAt = pending.indexOf('\n');
          }
        });

        proc.on('error', (error) => settle({ ready: false, deviceId: null, ...UNGATED, error: error.message }));
        proc.on('exit', () => {
          proc = null;
          fail(state.error ?? 'bridge exited');
          settle({ ready: false, deviceId: null, ...UNGATED, error: state.error });
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
      const deviceId = state.deviceId;
      if (!reading || !deviceId) return null;
      state = { ...state, gated: reading.current.muted, gatedSessions: 0 };
      writeClaim({
        deviceId,
        baseline: reading.baseline,
        held: reading.current,
        sessionName: null,
        at: Date.now(),
      });
      return reading.current;
    },

    async setSessionMute(options: { name: string; muted: boolean }): Promise<number | null> {
      const acted = await gateSessions(options);
      if (acted === null) return null;
      // A gate that reached nothing is published as open, not as silence somebody would go looking for.
      const held = options.muted && acted > 0;
      state = { ...state, gated: held, gatedSessions: held ? acted : 0 };
      if (!options.muted) {
        releaseClaim({ kind: 'session', name: options.name });
        return acted;
      }
      const reading = acted > 0 ? await request('G') : null;
      // A session gate leaves the endpoint untouched, so this claim exists only to clear the mute after a hard kill.
      if (reading && state.deviceId) {
        writeClaim({
          deviceId: state.deviceId,
          baseline: reading.current,
          held: reading.current,
          sessionName: options.name,
          at: Date.now(),
        });
      }
      return acted;
    },

    async sessions(): Promise<AudioSession[]> {
      const lines = await exchange({
        command: 'E',
        isLast: (line) => line.startsWith(SESSION_LIST_END_PREFIX),
      });
      const found: AudioSession[] = [];
      for (const line of lines) {
        if (!line.startsWith(SESSION_PREFIX)) continue;
        const parts = line.split(' ');
        const processId = Number(parts[1]);
        if (!Number.isFinite(processId)) continue;
        found.push({ processId, name: parts.slice(2).join(' ') });
      }
      return found;
    },

    baseline(): VolumeLevel | null {
      return last?.baseline ?? null;
    },

    async restore(): Promise<VolumeLevel | null> {
      const reading = await request('R');
      // An unconfirmed restore is when the claim matters most, so it outlives it and the next start puts the level back.
      if (reading) {
        state = { ...state, ...UNGATED };
        releaseClaim({ kind: 'endpoint' });
      }
      return reading?.current ?? null;
    },

    async stop(): Promise<void> {
      const restored = state.ready ? await request('R') : null;
      if (restored) releaseClaim({ kind: 'endpoint' });
      state = { ready: false, deviceId: state.deviceId, ...UNGATED, error: state.error };
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
