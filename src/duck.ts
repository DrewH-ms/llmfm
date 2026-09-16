/** The gate for music LLMFM does not own. Where the score has parts to silence, a stream
 *  coming out of someone else's application — a browser, a media player, a phone bridged
 *  in as system audio — has no parts and no transport we can reach, so the silence that
 *  means an agent needs you is carried by the output endpoint's mute flag.
 *
 *  Leaving that flag set is the one failure this module must not have. `system-volume.ts`
 *  owns every mechanism against it: the baseline, the restore on a clean stop, on lost
 *  stdin and on owner exit, and the claim file that recovers a flag left behind by a hard
 *  kill. What lives here is only which of them to call and when. */

import type { SystemVolume, SystemVolumeStatus } from './system-volume.ts';

export type Duck = {
  /** Brings up the volume bridge. Resolves to its status and never rejects. */
  start(): Promise<SystemVolumeStatus>;
  /** The gate. Audible is the user's audio as they left it; silent is the endpoint muted.
   *  `fadeSeconds` is not honoured: a mute flag is instantaneous and has no ramp. It is
   *  present because every sink the orchestrator drives is gated the same way. */
  setAudible(options: { audible: boolean; fadeSeconds: number }): void;
  /** Unmutes and releases the bridge. */
  stop(): Promise<void>;
};

export function createDuck(options: { volume: SystemVolume }): Duck {
  const { volume } = options;
  let started = false;
  let audible = true;
  /** Where we last left the endpoint, so a flag the user cleared themselves is not set
   *  again behind them. */
  let applied: boolean | null = null;
  /** Commands are queued rather than issued concurrently: the bridge answers one at a
   *  time, and a mute racing the restore that should outlive it is the one ordering this
   *  module cannot afford to get wrong. */
  let queue: Promise<void> = Promise.resolve();

  const apply = (): Promise<void> => {
    queue = queue.then(async () => {
      if (!started || applied === audible) return;
      // Restoring rather than clearing the flag ourselves puts the level and the flag back
      // exactly as the user had them and releases the claim, in one command.
      const reading = audible ? await volume.restore() : await volume.set({ muted: true });
      // A command the bridge could not answer leaves the gate to be retried.
      if (reading) applied = audible;
    });
    return queue;
  };

  return {
    async start(): Promise<SystemVolumeStatus> {
      if (started) return volume.status();
      const status = await volume.start();
      if (!status.ready) return status;
      started = true;
      applied = true;
      await apply();
      return status;
    },

    setAudible(gate: { audible: boolean; fadeSeconds: number }): void {
      audible = gate.audible;
      void apply();
    },

    async stop(): Promise<void> {
      audible = true;
      if (!started) return;
      started = false;
      // Queued commands see `started` false and do nothing, but one already in flight has
      // to land before the restore, or it would mute the endpoint after it.
      await queue;
      await volume.restore();
      await volume.stop();
      applied = null;
    },
  };
}
