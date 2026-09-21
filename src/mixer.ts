import {
  CC_CHANNEL_VOLUME,
  DEFAULT_MASTER_VOLUME,
  FADE_STEP_HZ,
  MASTER_VOLUME_CURVE_EXPONENT,
  MASTER_VOLUME_MAX,
  MAX_MIDI_VALUE,
} from './constants.ts';
import { controlChange, programChange, silenceChannel } from './midi-out.ts';
import type { MidiOut } from './midi-out.ts';
import type { Score } from './types.ts';

export type Mixer = {
  bindScore(score: Score): void;
  /** Fades a part toward audible or silent. Safe to call repeatedly with the same target. */
  setPartAudible(options: { partId: string; audible: boolean; fadeSeconds: number }): void;
  isPartAudible(partId: string): boolean;
  /** Whether anything is still sounding, fade-outs included. This, not the gate, is the transport's run condition. */
  anyAudible(): boolean;
  /** Whether any part is gated on, ignoring where its fade has got to. */
  anyGateOpen(): boolean;
  /** Overall scale over every part, 0–100. Takes effect on sounding parts at once. */
  setMasterVolume(volume: number): void;
  /** Immediate: silences every channel and clears hanging notes. */
  silenceAll(): void;
  stop(): void;
};

type PartMix = {
  channel: number;
  /** The gate: what the part is being faded toward, which the scheduler reads. */
  audible: boolean;
  level: number;
  fade: NodeJS.Timeout | null;
};

const MS_PER_SECOND = 1000;

/** The single point where a level becomes a MIDI value, so it also clamps: gated-off stays silent, master 100 is unscaled. */
export function channelVolume(options: { level: number; masterVolume: number }): number {
  const level = Number.isFinite(options.level) ? Math.min(Math.max(options.level, 0), 1) : 0;
  const volume = Number.isFinite(options.masterVolume) ? options.masterVolume : MASTER_VOLUME_MAX;
  const master = Math.min(Math.max(volume, 0), MASTER_VOLUME_MAX) / MASTER_VOLUME_MAX;
  const value = Math.round(level * master ** MASTER_VOLUME_CURVE_EXPONENT * MAX_MIDI_VALUE);
  return Math.min(Math.max(value, 0), MAX_MIDI_VALUE);
}

export function createMixer(midi: MidiOut): Mixer {
  const parts = new Map<string, PartMix>();
  let masterVolume = DEFAULT_MASTER_VOLUME;

  const sendLevel = (mix: PartMix): void => {
    controlChange(midi, {
      channel: mix.channel,
      controller: CC_CHANNEL_VOLUME,
      value: channelVolume({ level: mix.level, masterVolume }),
    });
  };

  const cancelFade = (mix: PartMix): void => {
    if (mix.fade === null) return;
    clearInterval(mix.fade);
    mix.fade = null;
  };

  return {
    bindScore(score: Score): void {
      for (const mix of parts.values()) cancelFade(mix);
      parts.clear();

      for (const part of score.parts) {
        // Bound silent: the gate has not been consulted yet, and starting at full level is a burst of music on every track change.
        const mix: PartMix = { channel: part.channel, audible: false, level: 0, fade: null };
        parts.set(part.partId, mix);
        if (!part.percussion) programChange(midi, { channel: part.channel, program: part.program });
        sendLevel(mix);
      }
    },

    setPartAudible(options: { partId: string; audible: boolean; fadeSeconds: number }): void {
      const mix = parts.get(options.partId);
      if (!mix) return;

      const target = options.audible ? 1 : 0;
      // The gate is recomputed on every refresh, so repeat calls are routine. Restarting a fade already heading here is what stops it ever arriving.
      if (mix.audible === options.audible && (mix.fade !== null || mix.level === target)) return;

      cancelFade(mix);
      mix.audible = options.audible;

      const durationMs = Math.max(1, options.fadeSeconds * MS_PER_SECOND);
      const from = mix.level;
      const startedAt = Date.now();

      mix.fade = setInterval(
        () => {
          // Driven by the clock rather than a step count: timer drift stretched a 3s fade to nearly 4s, outliving the settle that waits on it.
          const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
          mix.level = from + (target - from) * progress;
          sendLevel(mix);
          if (progress < 1) return;
          cancelFade(mix);
          if (target === 0) silenceChannel(midi, mix.channel);
        },
        MS_PER_SECOND / FADE_STEP_HZ,
      );
    },

    isPartAudible(partId: string): boolean {
      const mix = parts.get(partId);
      if (!mix) return false;
      // Mid fade-out a part must keep taking notes, or the fade has nothing left to act on and cuts abruptly.
      return mix.audible || mix.level > 0;
    },

    anyAudible(): boolean {
      for (const mix of parts.values()) {
        if (mix.audible || mix.level > 0) return true;
      }
      return false;
    },

    anyGateOpen(): boolean {
      for (const mix of parts.values()) {
        if (mix.audible) return true;
      }
      return false;
    },

    setMasterVolume(volume: number): void {
      masterVolume = volume;
      for (const mix of parts.values()) sendLevel(mix);
    },

    silenceAll(): void {
      for (const mix of parts.values()) {
        cancelFade(mix);
        mix.level = 0;
        sendLevel(mix);
        silenceChannel(midi, mix.channel);
      }
    },

    stop(): void {
      for (const mix of parts.values()) {
        cancelFade(mix);
        silenceChannel(midi, mix.channel);
      }
      parts.clear();
    },
  };
}
