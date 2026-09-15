/** Sends MIDI to the Windows system synth through a PowerShell winmm bridge, because
 *  Node has no MIDI output and Web MIDI does not enumerate the GS Wavetable Synth.
 *  Messages go to the installed synth only; no soundfont data is ever read or shipped. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { MidiStatus } from './types.ts';
import {
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  MIDI_CONTROL_CHANGE,
  MIDI_PROGRAM_CHANGE,
  CC_ALL_NOTES_OFF,
  CC_ALL_SOUND_OFF,
} from './constants.ts';

const BRIDGE_SCRIPT = path.join(import.meta.dirname, '..', 'bridge', 'midi-bridge.ps1');
/** Generous because the bridge's first run pays for an Add-Type compile. */
const BRIDGE_START_TIMEOUT_MS = 15000;
const DATA1_SHIFT = 8;
const DATA2_SHIFT = 16;
const CHANNEL_MASK = 0x0f;

export type MidiOut = {
  /** Resolves once the bridge reports a device or fails. Never rejects. */
  start(): Promise<MidiStatus>;
  /** Packed short message: status | data1 << 8 | data2 << 16. No-op when not ready. */
  send(message: number): void;
  status(): MidiStatus;
  /** Resets the synth and ends the bridge process. */
  stop(): void;
};

export function createMidiOut(): MidiOut {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let state: MidiStatus = { ready: false, device: null, error: null };

  const write = (line: string): void => {
    if (!proc) return;
    try {
      proc.stdin.write(line);
    } catch {
      state = { ready: false, device: state.device, error: 'bridge stdin closed' };
    }
  };

  return {
    start(): Promise<MidiStatus> {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (next: MidiStatus): void => {
          state = next;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(next);
        };

        const timer = setTimeout(
          () => settle({ ready: false, device: null, error: 'bridge did not report a device' }),
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
          settle({ ready: false, device: null, error: String(error) });
          return;
        }

        proc.stdin.on('error', () => {
          state = { ready: false, device: state.device, error: 'bridge stdin closed' };
        });

        let pending = '';
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk: string) => {
          pending += chunk;
          let breakAt = pending.indexOf('\n');
          while (breakAt >= 0) {
            const line = pending.slice(0, breakAt).trim();
            pending = pending.slice(breakAt + 1);
            if (line.startsWith('OK ')) {
              settle({ ready: true, device: line.slice('OK '.length), error: null });
            } else if (line.startsWith('ERR ')) {
              settle({ ready: false, device: null, error: line.slice('ERR '.length) });
            }
            breakAt = pending.indexOf('\n');
          }
        });

        proc.on('error', (error) => settle({ ready: false, device: null, error: error.message }));
        proc.on('exit', () => {
          proc = null;
          settle({ ready: false, device: null, error: state.error ?? 'bridge exited' });
        });
      });
    },

    send(message: number): void {
      if (!state.ready) return;
      write(`S ${message}\n`);
    },

    status(): MidiStatus {
      return state;
    },

    stop(): void {
      write('Q\n');
      state = { ready: false, device: state.device, error: state.error };
      proc?.stdin.end();
      proc = null;
    },
  };
}

export function noteOn(
  midi: MidiOut,
  options: { channel: number; note: number; velocity: number },
): void {
  midi.send(
    (MIDI_NOTE_ON | (options.channel & CHANNEL_MASK)) |
      (options.note << DATA1_SHIFT) |
      (options.velocity << DATA2_SHIFT),
  );
}

export function noteOff(midi: MidiOut, options: { channel: number; note: number }): void {
  midi.send((MIDI_NOTE_OFF | (options.channel & CHANNEL_MASK)) | (options.note << DATA1_SHIFT));
}

/** A channel held at zero volume keeps sounding whatever was on when the level fell, so
 *  silence is only real once both all-notes-off and all-sound-off have been sent. */
export function silenceChannel(midi: MidiOut, channel: number): void {
  controlChange(midi, { channel, controller: CC_ALL_NOTES_OFF, value: 0 });
  controlChange(midi, { channel, controller: CC_ALL_SOUND_OFF, value: 0 });
}

export function controlChange(
  midi: MidiOut,
  options: { channel: number; controller: number; value: number },
): void {
  midi.send(
    (MIDI_CONTROL_CHANGE | (options.channel & CHANNEL_MASK)) |
      (options.controller << DATA1_SHIFT) |
      (options.value << DATA2_SHIFT),
  );
}

export function programChange(midi: MidiOut, options: { channel: number; program: number }): void {
  midi.send(
    (MIDI_PROGRAM_CHANGE | (options.channel & CHANNEL_MASK)) | (options.program << DATA1_SHIFT),
  );
}
