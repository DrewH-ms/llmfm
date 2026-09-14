import {
  CC_ALL_NOTES_OFF,
  CC_ALL_SOUND_OFF,
  CC_CHANNEL_VOLUME,
  FADE_STEP_HZ,
  MAX_MIDI_VALUE,
} from './constants.ts';
import { controlChange, programChange } from './midi-out.ts';
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

export function createMixer(midi: MidiOut): Mixer {
  const parts = new Map<string, PartMix>();

  const sendLevel = (mix: PartMix): void => {
    controlChange(midi, {
      channel: mix.channel,
      controller: CC_CHANNEL_VOLUME,
      value: Math.round(mix.level * MAX_MIDI_VALUE),
    });
  };

  /** A channel left at zero volume keeps sounding notes that were on when the fade began,
   *  so silence is only real once both all-notes-off and all-sound-off have been sent. */
  const clearChannel = (channel: number): void => {
    controlChange(midi, { channel, controller: CC_ALL_NOTES_OFF, value: 0 });
    controlChange(midi, { channel, controller: CC_ALL_SOUND_OFF, value: 0 });
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
          if (target === 0) clearChannel(mix.channel);
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

    silenceAll(): void {
      for (const mix of parts.values()) {
        cancelFade(mix);
        mix.level = 0;
        sendLevel(mix);
        clearChannel(mix.channel);
      }
    },

    stop(): void {
      for (const mix of parts.values()) {
        cancelFade(mix);
        clearChannel(mix.channel);
      }
      parts.clear();
    },
  };
}
