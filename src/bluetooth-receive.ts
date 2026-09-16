/** Receives audio from a paired phone over Bluetooth A2DP, so LLMFM can hear what the
 *  user is already playing without asking them to move the music to this machine. The
 *  phone stays the transport; Windows renders what it sends into the default render
 *  endpoint, which is the endpoint duck mode already gates.
 *
 *  The sink is up for exactly as long as the bridge process holds the connection, so the
 *  process is the resource and its death is the release. There is no state to restore.
 *  What is worth persisting is the choice: the device the user picked is claimed on disk
 *  and re-opened by the next start. See `bridge/bt-receive-bridge.ps1`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { llmfmHome } from './paths.ts';

/** Generous because the bridge enumerates paired devices before it answers, and that
 *  enumeration waits on the radio rather than on this machine. */
const BRIDGE_START_TIMEOUT_MS = 45000;
/** A state reply can queue behind a re-open the bridge started on its own. */
const STATUS_TIMEOUT_MS = 10000;
const LIST_TIMEOUT_MS = 45000;
/** Opening an A2DP link waits on the radio and the phone, and the bridge retries a
 *  refused attempt that blocks for five seconds before it answers. */
const CONNECT_TIMEOUT_MS = 30000;
const CLAIM_FILE_NAME = 'llmfm-bluetooth-claim.json';

const CONNECTION_STATES = ['None', 'Closed', 'Opened'] as const;
type ConnectionState = (typeof CONNECTION_STATES)[number];

const LISTING_END_PREFIX = 'N ';
const ERROR_PREFIX = 'ERR ';

export type BluetoothDevice = { id: string; name: string };

export type BluetoothStatus = {
  ready: boolean;
  state: ConnectionState;
  /** The device we hold, or null when nothing is connected. */
  device: BluetoothDevice | null;
  error: string | null;
};

/** The device the user picked, so a restarted daemon re-opens it instead of asking
 *  again. There is nothing here to undo: a dead bridge has already released the sink. */
type BluetoothClaim = { device: BluetoothDevice; at: number };

export type BluetoothReceive = {
  /** Resolves once the bridge reports its device count or fails. Never rejects. */
  start(): Promise<BluetoothStatus>;
  status(): BluetoothStatus;
  list(): Promise<BluetoothDevice[]>;
  connect(device: { id: string }): Promise<BluetoothStatus>;
  disconnect(): Promise<BluetoothStatus>;
  /** Closes any connection and ends the bridge process. */
  stop(): Promise<void>;
};

export function bluetoothClaimPath(): string {
  return path.join(llmfmHome(), CLAIM_FILE_NAME);
}

/** The shipped bridge, unless a fake is named for a test that must run without a radio. */
function bridgeScript(): string {
  return (
    process.env['LLMFM_BT_BRIDGE'] ??
    path.join(import.meta.dirname, '..', 'bridge', 'bt-receive-bridge.ps1')
  );
}

/** `S <state> <id> <name>`, where the name is the remainder of the line because a
 *  device name may contain spaces and a device id may not. */
function parseState(line: string): { state: ConnectionState; device: BluetoothDevice | null } | null {
  const parts = line.split(' ');
  const state = CONNECTION_STATES.find((candidate) => candidate === parts[1]);
  const id = parts[2];
  if (parts[0] !== 'S' || !state || !id) return null;
  if (state === 'None') return { state, device: null };
  return { state, device: { id, name: parts.slice(3).join(' ') } };
}

/** `D <index> <id> <name>`, named on the same rule as the state line. */
function parseDevice(line: string): BluetoothDevice | null {
  const parts = line.split(' ');
  const id = parts[2];
  if (parts[0] !== 'D' || !id) return null;
  return { id, name: parts.slice(3).join(' ') };
}

/** The file is on disk between runs and may be hand-edited or truncated by a crash, so
 *  anything unexpected means no claim rather than a malformed one. */
function readClaim(): BluetoothClaim | null {
  const file = bluetoothClaimPath();
  if (!existsSync(file)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const at = record['at'];
  const device = record['device'];
  if (typeof at !== 'number' || typeof device !== 'object' || device === null) return null;
  const fields = device as Record<string, unknown>;
  const id = fields['id'];
  const name = fields['name'];
  if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string') return null;
  return { device: { id, name }, at };
}

function writeClaim(device: BluetoothDevice): void {
  const file = bluetoothClaimPath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ device, at: Date.now() } satisfies BluetoothClaim, null, 2)}\n`);
  } catch {
    // A choice we cannot persist only costs the user picking their phone again.
  }
}

function clearClaim(): void {
  try {
    rmSync(bluetoothClaimPath(), { force: true });
  } catch {
    // Same reasoning as writeClaim.
  }
}

export function createBluetoothReceive(): BluetoothReceive {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let state: BluetoothStatus = { ready: false, state: 'None', device: null, error: null };
  /** One in-flight command at a time; the bridge answers each line in order. */
  const waiting: Array<(line: string) => void> = [];

  const fail = (error: string): void => {
    state = { ready: false, state: 'None', device: null, error };
    while (waiting.length > 0) waiting.shift()?.(`${ERROR_PREFIX}${error}`);
  };

  /** Collects reply lines until `isLast` accepts one. Resolves empty when the bridge is
   *  not running, so no caller has to know whether it is. */
  const request = (options: {
    command: string;
    timeoutMs: number;
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
        options.timeoutMs,
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

  /** The bridge answers every connection command with the state it reached. */
  const requestState = async (command: string, timeoutMs: number): Promise<BluetoothStatus> => {
    const lines = await request({ command, timeoutMs, isLast: () => true });
    const line = lines[lines.length - 1];
    if (!line) return state;
    const parsed = parseState(line);
    if (!parsed) {
      state = {
        ...state,
        error: line.startsWith(ERROR_PREFIX) ? line.slice(ERROR_PREFIX.length) : line,
      };
      return state;
    }
    state = { ready: true, state: parsed.state, device: parsed.device, error: null };
    return state;
  };

  /** The device the user chose on an earlier run. A device that is no longer paired or
   *  no longer in range is not an error worth keeping: the claim goes with it. */
  const reopenClaimed = async (): Promise<void> => {
    const claim = readClaim();
    if (!claim) return;
    const reopened = await requestState(`C ${claim.device.id}`, CONNECT_TIMEOUT_MS);
    if (!reopened.device) clearClaim();
  };

  return {
    start(): Promise<BluetoothStatus> {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (next: BluetoothStatus): void => {
          state = next;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(next);
        };

        const timer = setTimeout(
          () =>
            settle({
              ready: false,
              state: 'None',
              device: null,
              error: 'bridge did not report its devices',
            }),
          BRIDGE_START_TIMEOUT_MS,
        );
        timer.unref();

        try {
          proc = spawn(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              bridgeScript(),
              '-ParentPid',
              String(process.pid),
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
        } catch (error) {
          settle({ ready: false, state: 'None', device: null, error: String(error) });
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
              clearTimeout(timer);
              // Ready before the claim is honoured, because re-opening goes through the
              // same commands; start() still only resolves once the link has settled.
              state = { ready: true, state: 'None', device: null, error: null };
              void reopenClaimed().then(() => settle(state));
            } else if (waiting.length > 0) {
              // A command answered before start() resolves is the claimed device being
              // re-opened, and a device that refuses is not a bridge that failed.
              waiting.shift()?.(line);
            } else if (line.startsWith(ERROR_PREFIX) && !settled) {
              settle({
                ready: false,
                state: 'None',
                device: null,
                error: line.slice(ERROR_PREFIX.length),
              });
            }
            breakAt = pending.indexOf('\n');
          }
        });

        proc.on('error', (error) =>
          settle({ ready: false, state: 'None', device: null, error: error.message }),
        );
        proc.on('exit', () => {
          proc = null;
          fail(state.error ?? 'bridge exited');
          settle(state);
        });
      });
    },

    status(): BluetoothStatus {
      return state;
    },

    async list(): Promise<BluetoothDevice[]> {
      const lines = await request({
        command: 'L',
        timeoutMs: LIST_TIMEOUT_MS,
        isLast: (line) => line.startsWith(LISTING_END_PREFIX),
      });
      const devices: BluetoothDevice[] = [];
      for (const line of lines) {
        const device = parseDevice(line);
        if (device) devices.push(device);
      }
      return devices;
    },

    async connect(device: { id: string }): Promise<BluetoothStatus> {
      const connected = await requestState(`C ${device.id}`, CONNECT_TIMEOUT_MS);
      if (connected.device) writeClaim(connected.device);
      return connected;
    },

    async disconnect(): Promise<BluetoothStatus> {
      // Giving the device up is the user changing their mind, so the choice goes too.
      clearClaim();
      return requestState('X', STATUS_TIMEOUT_MS);
    },

    async stop(): Promise<void> {
      if (state.ready) await requestState('X', STATUS_TIMEOUT_MS);
      state = { ready: false, state: 'None', device: null, error: state.error };
      try {
        proc?.stdin.write('Q\n');
        proc?.stdin.end();
      } catch {
        // The bridge releases the sink on lost stdin regardless of whether Q arrives.
      }
      proc = null;
    },
  };
}
