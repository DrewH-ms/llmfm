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
  /** Binds channels and sends the program change for each part. */
  bindScore(score: Score): void;
  /** Fades a part toward audible or silent. Safe to call repeatedly with the same target. */
  setPartAudible(options: { partId: string; audible: boolean; fadeSeconds: number }): void;
  isPartAudible(partId: string): boolean;
  /** True when at least one part is above silence — the transport's run condition. */
  anyAudible(): boolean;
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

/** The CC7 value for a part sitting at `level` (0–1) under `masterVolume` (0–100). This is
 *  the single point where a level becomes a MIDI value, so it also enforces the range: a
 *  gated-off part stays silent at any master volume, and master 100 is unscaled. */
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
        // Unassigned parts are the backing texture and start audible.
        const mix: PartMix = { channel: part.channel, audible: true, level: 1, fade: null };
        parts.set(part.partId, mix);
        if (!part.percussion) programChange(midi, { channel: part.channel, program: part.program });
        sendLevel(mix);
      }
    },

    setPartAudible(options: { partId: string; audible: boolean; fadeSeconds: number }): void {
      const mix = parts.get(options.partId);
      if (!mix) return;

      const target = options.audible ? 1 : 0;
      if (mix.audible === options.audible && mix.fade === null && mix.level === target) return;

      cancelFade(mix);
      mix.audible = options.audible;

      const steps = Math.max(1, Math.round(options.fadeSeconds * FADE_STEP_HZ));
      const from = mix.level;
      let step = 0;

      mix.fade = setInterval(
        () => {
          step += 1;
          mix.level = from + (target - from) * (step / steps);
          sendLevel(mix);
          if (step < steps) return;
          mix.level = target;
          cancelFade(mix);
          if (target === 0) silenceChannel(midi, mix.channel);
        },
        (options.fadeSeconds * MS_PER_SECOND) / steps,
      );
    },

    isPartAudible(partId: string): boolean {
      return parts.get(partId)?.audible ?? false;
    },

    anyAudible(): boolean {
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
