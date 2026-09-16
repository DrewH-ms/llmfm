/** Plays recorded audio (.mp3/.wav) through a PowerShell MCI bridge, because Node cannot
 *  render audio and the daemon may not add dependencies. MCI lives in winmm.dll, the same
 *  library the MIDI bridge already drives, so recorded playback costs nothing new.
 *
 *  This is the seam where units change. The app speaks seconds and 0..1 levels, as
 *  `TransportState` does; MCI speaks milliseconds and 0..1000. Conversion happens here
 *  and nowhere else.
 *
 *  Nothing on this API throws or hangs. A missing or wedged bridge is a daemon that plays
 *  no recordings, never a daemon that falls over, so every method resolves to a harmless
 *  value — zero, or nothing at all — when the bridge is absent, failed, or slow to answer.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const BRIDGE_SCRIPT = path.join(import.meta.dirname, '..', 'bridge', 'audio-bridge.ps1');
/** Generous because the bridge's first run pays for an Add-Type compile. */
const BRIDGE_START_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 5000;
/** Opening a file touches the disk and may spin up a codec, so it is given longer. */
const OPEN_TIMEOUT_MS = 20000;
const MS_PER_SECOND = 1000;
/** MCI's `setaudio volume` range. */
const MCI_VOLUME_MAX = 1000;

export type AudioStatus = { ready: boolean; error: string | null };

export type AudioOut = {
  /** Resolves once the bridge reports itself ready or fails. Never rejects. */
  start(): Promise<AudioStatus>;
  /** Absolute path. Resolves to the duration in seconds, or 0 if it could not be opened. */
  open(file: string): Promise<number>;
  play(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(seconds: number): Promise<void>;
  /** 0..1, mapped onto MCI's 0..1000. Out-of-range levels are clamped. */
  setVolume(level: number): Promise<void>;
  /** Current position in seconds, or 0 when nothing is open. */
  position(): Promise<number>;
  status(): AudioStatus;
  /** Closes the media and ends the bridge, leaving nothing playing. */
  stop(): void;
};

/** Seconds to whole milliseconds. Negative and non-finite inputs collapse to 0: MCI
 *  takes an unsigned position, and a NaN would reach it as the literal text "NaN". */
export function toMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * MS_PER_SECOND);
}

export function toSeconds(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return milliseconds / MS_PER_SECOND;
}

/** A 0..1 level as an MCI volume. */
export function toMciVolume(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.round(Math.min(1, level) * MCI_VOLUME_MAX);
}

export function createAudioOut(): AudioOut {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let state: AudioStatus = { ready: false, error: null };
  let nextId = 0;
  /** Replies are matched by echoed id rather than by arrival order, so a slow answer
   *  can never be read as the reply to the command that followed it. */
  const waiting = new Map<string, (reply: string | null) => void>();

  const fail = (error: string): void => {
    state = { ready: false, error };
    for (const settle of [...waiting.values()]) settle(null);
    waiting.clear();
  };

  /** Resolves to the reply payload, or null on any failure: not ready, refused by MCI,
   *  or no answer within the timeout. */
  const request = (verb: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string | null> => {
    if (!state.ready || !proc) return Promise.resolve(null);
    const id = `c${nextId++}`;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (reply: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiting.delete(id);
        resolve(reply);
      };

      const timer = setTimeout(() => settle(null), timeoutMs);
      timer.unref();

      waiting.set(id, settle);
      try {
        proc?.stdin.write(`${id} ${verb}\n`);
      } catch {
        fail('bridge stdin closed');
      }
    });
  };

  const handleReply = (line: string): void => {
    const space = line.indexOf(' ');
    if (space < 0) return;
    const settle = waiting.get(line.slice(0, space));
    if (!settle) return;
    const rest = line.slice(space + 1);
    if (rest === 'OK') settle('');
    else if (rest.startsWith('OK ')) settle(rest.slice('OK '.length));
    else {
      if (rest.startsWith('ERR ')) state = { ready: state.ready, error: rest.slice('ERR '.length) };
      settle(null);
    }
  };

  return {
    start(): Promise<AudioStatus> {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (next: AudioStatus): void => {
          state = next;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(next);
        };

        const timer = setTimeout(
          () => settle({ ready: false, error: 'bridge did not report ready' }),
          BRIDGE_START_TIMEOUT_MS,
        );
        timer.unref();

        try {
          proc = spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE_SCRIPT],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
        } catch (error) {
          settle({ ready: false, error: String(error) });
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
            if (!settled && line === 'OK ready') {
              settle({ ready: true, error: null });
            } else if (!settled && line.startsWith('ERR ')) {
              settle({ ready: false, error: line.slice('ERR '.length) });
            } else if (line.length > 0) {
              handleReply(line);
            }
            breakAt = pending.indexOf('\n');
          }
        });

        proc.on('error', (error) => {
          fail(error.message);
          settle({ ready: false, error: error.message });
        });
        proc.on('exit', () => {
          proc = null;
          const error = state.error ?? 'bridge exited';
          fail(error);
          settle({ ready: false, error });
        });
      });
    },

    async open(file: string): Promise<number> {
      const reply = await request(`OPEN ${file}`, OPEN_TIMEOUT_MS);
      // Payload is "<lengthMs> <device type>"; the type is only of diagnostic interest.
      const length = Number(reply?.split(' ')[0]);
      return Number.isFinite(length) ? toSeconds(length) : 0;
    },

    async play(): Promise<void> {
      await request('PLAY');
    },

    async pause(): Promise<void> {
      await request('PAUSE');
    },

    async resume(): Promise<void> {
      await request('RESUME');
    },

    async seek(seconds: number): Promise<void> {
      await request(`SEEK ${toMilliseconds(seconds)}`);
    },

    async setVolume(level: number): Promise<void> {
      await request(`VOLUME ${toMciVolume(level)}`);
    },

    async position(): Promise<number> {
      const reply = await request('POSITION');
      const ms = Number(reply);
      return reply !== null && Number.isFinite(ms) ? toSeconds(ms) : 0;
    },

    status(): AudioStatus {
      return state;
    },

    stop(): void {
      const write = (line: string): void => {
        try {
          proc?.stdin.write(line);
        } catch {
          // The bridge closes its device from a finally block when stdin goes away.
        }
      };
      write(`s${nextId++} CLOSE\n`);
      write(`s${nextId++} QUIT\n`);
      state = { ready: false, error: state.error };
      fail('audio stopped');
      proc?.stdin.end();
      proc = null;
    },
  };
}
