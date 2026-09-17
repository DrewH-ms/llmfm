/** Transport for a mixdown: gates one finished stream, and mirrors `Scheduler` so the daemon can publish `TransportState` either way. */

import type { AudioOut } from './audio-out.ts';
import type { TransportState } from './types.ts';
import { MASTER_VOLUME_MAX } from './constants.ts';

/** MCI quantises `status position` coarsely, so polling faster buys nothing but bridge traffic. */
const POSITION_POLL_MS = 500;
/** Enough steps to hear a ramp rather than a staircase, without a bridge command per frame. */
const FADE_STEPS = 20;
/** MCI reports a position a little short of the stated length at the end, so an exact comparison never fires. */
const END_MARGIN_SECONDS = 0.35;

export type RecordedPlayer = {
  /** Resolves false if the file could not be opened. */
  load(path: string): Promise<boolean>;
  /** Ramps to full or to silence over `fadeSeconds`, pausing once silent unless the stream is held. */
  setAudible(options: { audible: boolean; fadeSeconds: number }): void;
  setMasterVolume(volume: number): void;
  /** Leave the stream running through its own silence instead of pausing it. */
  setHoldTransport(hold: boolean): void;
  onEnd(listener: () => void): () => void;
  state(): TransportState;
  stop(): void;
};

export function createRecordedPlayer(audio: AudioOut): RecordedPlayer {
  let duration = 0;
  let position = 0;
  let playing = false;
  let loaded = false;
  /** MCI distinguishes starting from resuming, and only the device knows which it is. */
  let started = false;
  let holdTransport = false;
  let master = MASTER_VOLUME_MAX;
  /** Where the ramp is now, 0..1, independent of master volume. */
  let level = 0;
  let target = 0;
  let fadeTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const endListeners = new Set<() => void>();

  const applyLevel = (): void => {
    void audio.setVolume((level * master) / MASTER_VOLUME_MAX);
  };

  const clearFade = (): void => {
    if (fadeTimer) clearInterval(fadeTimer);
    fadeTimer = null;
  };

  const stopPolling = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const reachedEnd = (): boolean => duration > 0 && position >= duration - END_MARGIN_SECONDS;

  const poll = async (): Promise<void> => {
    if (!loaded) return;
    position = await audio.position();
    if (!reachedEnd()) return;
    // Reported once: a second report for the same ending would rotate the library twice.
    stopPolling();
    playing = false;
    for (const listener of [...endListeners]) listener();
  };

  const startPolling = (): void => {
    if (pollTimer) return;
    pollTimer = setInterval(() => void poll(), POSITION_POLL_MS);
    pollTimer.unref();
  };

  const ensurePlaying = (): void => {
    if (playing) return;
    playing = true;
    // MCI refuses `resume` on a device that has never played.
    if (started) void audio.resume();
    else void audio.play();
    started = true;
    startPolling();
  };

  /** Pause only once the level reaches zero, or the fade is cut off mid-ramp; a fade-in needs the stream running first. */
  const settle = (): void => {
    if (level > 0 || target > 0) {
      ensurePlaying();
      return;
    }
    if (holdTransport || !playing) return;
    playing = false;
    void audio.pause();
    stopPolling();
  };

  const stepFade = (delta: number): void => {
    level = delta > 0 ? Math.min(target, level + delta) : Math.max(target, level + delta);
    applyLevel();
    if (level === target) {
      clearFade();
      settle();
    }
  };

  return {
    async load(path: string): Promise<boolean> {
      clearFade();
      stopPolling();
      playing = false;
      started = false;
      position = 0;
      level = 0;
      target = 0;
      const seconds = await audio.open(path);
      loaded = seconds > 0;
      duration = seconds;
      // Opened silent: the gate has not been consulted yet, so full volume would speak for a session that may be blocked.
      applyLevel();
      return loaded;
    },

    setAudible(options: { audible: boolean; fadeSeconds: number }): void {
      if (!loaded) return;
      const next = options.audible ? 1 : 0;
      if (next === target && !fadeTimer) {
        settle();
        return;
      }
      target = next;
      clearFade();
      // A fade shorter than one step is a jump, and an interval of zero would spin.
      if (options.fadeSeconds <= 0) {
        level = target;
        applyLevel();
        settle();
        return;
      }
      // Coming out of silence the stream has to be running before the ramp is audible.
      if (target > 0) settle();
      const stepMs = Math.max(1, Math.round((options.fadeSeconds * 1000) / FADE_STEPS));
      const delta = (target - level) / FADE_STEPS;
      fadeTimer = setInterval(() => stepFade(delta), stepMs);
      fadeTimer.unref();
    },

    setMasterVolume(volume: number): void {
      master = volume;
      applyLevel();
    },

    setHoldTransport(hold: boolean): void {
      holdTransport = hold;
      settle();
    },

    onEnd(listener: () => void): () => void {
      endListeners.add(listener);
      return () => endListeners.delete(listener);
    },

    state(): TransportState {
      return { playing, position, duration };
    },

    stop(): void {
      clearFade();
      stopPolling();
      endListeners.clear();
      playing = false;
      loaded = false;
      audio.stop();
    },
  };
}
