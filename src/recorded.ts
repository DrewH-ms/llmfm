/** The transport for a track that has no parts. Where the scheduler gates a score channel
 *  by channel, this gates one finished stream, because that is all a mixdown allows: the
 *  fade, the pause and the position all apply to the whole file or to nothing.
 *
 *  It deliberately mirrors `Scheduler` where it can, so the daemon can publish a
 *  `TransportState` without caring which kind of track is loaded. */

import type { AudioOut } from './audio-out.ts';
import type { TransportState } from './types.ts';
import { MASTER_VOLUME_MAX } from './constants.ts';

/** How often the position is read back while playing. MCI quantises `status position`
 *  coarsely, so asking faster buys nothing but bridge traffic. */
const POSITION_POLL_MS = 500;
/** Steps in a fade. Enough that a ramp is heard as a ramp rather than a staircase,
 *  without flooding the bridge with a command per frame. */
const FADE_STEPS = 20;
/** Treated as the end of the file. MCI reports a position a little short of the stated
 *  length at the end of playback, so an exact comparison would never fire. */
const END_MARGIN_SECONDS = 0.35;

export type RecordedPlayer = {
  /** Opens a file and holds it ready. Resolves false if it could not be opened. */
  load(path: string): Promise<boolean>;
  /** The gate. Ramps to full or to silence over `fadeSeconds`, pausing once silent
   *  unless the caller wants the stream left running underneath. */
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
    // Reported once. The listener decides what follows, and a second report for the same
    // ending would rotate the library twice.
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
    // MCI refuses `resume` on a device that has never played, so the first start and a
    // return from pause are not the same command.
    if (started) void audio.resume();
    else void audio.play();
    started = true;
    startPolling();
  };

  /** Pausing the moment the gate shuts would cut the fade off mid-ramp, so the stream is
   *  only stopped once the level has actually reached zero. A fade-in is the mirror of
   *  that: the stream has to be running before the ramp, or the level would climb on a
   *  device that is not playing and the track would arrive late by the whole fade. */
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
      // Opened silent on purpose: the gate has not been consulted yet, and a file that
      // announced itself at full volume before the first refresh would speak for a
      // session that may well be blocked.
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
