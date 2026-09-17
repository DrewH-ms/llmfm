/** The gate for music LLMFM does not own. Where the score has parts to silence, a stream
 *  coming out of someone else's application — a browser, a media player, a phone bridged
 *  in as system audio — has no parts and no transport we can reach, so the silence that
 *  means an agent needs you is carried by a mute flag.
 *
 *  Which flag depends on how much we know. When the caller can name the application, only
 *  that stream is muted and a call or a notification still reaches the user. When it
 *  cannot, there is no well-defined stream to single out and the whole output endpoint is
 *  the gate.
 *
 *  Leaving either flag set is the one failure this module must not have. `system-volume.ts`
 *  owns every mechanism against it: the baseline, the restore on a clean stop, on lost
 *  stdin and on owner exit, and the claim file that recovers a flag left behind by a hard
 *  kill. What lives here is only which of them to call and when. */

import type { SystemVolume, SystemVolumeStatus } from './system-volume.ts';

const MS_PER_SECOND = 1000;

export type Duck = {
  /** Brings up the volume bridge. Resolves to its status and never rejects. */
  start(): Promise<SystemVolumeStatus>;
  /** The gate. Audible is the user's audio as they left it; silent is a mute flag.
   *
   *  A mute flag has no ramp, so `fadeSeconds` is spent before it rather than across it:
   *  the mute is held back that long, and an agent that comes back inside the window is
   *  never muted at all. Coming back is instant — a delay there would be the product
   *  lying about which agents are waiting on you. */
  setAudible(options: { audible: boolean; fadeSeconds: number }): void;
  /** Unmutes and releases the bridge. */
  stop(): Promise<void>;
};

/** `sessionName` names the application whose stream carries the audio, when one is known;
 *  it is read at each gate change because the application may arrive or leave under a
 *  running daemon. */
export function createDuck(options: {
  volume: SystemVolume;
  sessionName: () => string | null;
}): Duck {
  const { volume, sessionName } = options;
  let started = false;
  let audible = true;
  /** The session we are holding muted, so it is the one released even after whatever named
   *  it has gone away. */
  let heldSession: string | null = null;
  /** True while the endpoint carries the gate instead. At most one of the two is ever
   *  held: a flag the user cleared themselves is not set again behind them. */
  let heldEndpoint = false;
  /** Commands are queued rather than issued concurrently: the bridge answers one at a
   *  time, and a mute racing the restore that should outlive it is the one ordering this
   *  module cannot afford to get wrong. */
  let queue: Promise<void> = Promise.resolve();
  /** A mute waiting out its hold-off. Held rather than restarted while it runs, so a
   *  session flickering does not push the mute back indefinitely. */
  let pending: NodeJS.Timeout | null = null;

  const cancelPending = (): void => {
    if (pending) clearTimeout(pending);
    pending = null;
  };

  const release = async (): Promise<void> => {
    if (heldSession) {
      // A command the bridge could not answer leaves the gate to be retried.
      if ((await volume.setSessionMute({ name: heldSession, muted: false })) === null) return;
      heldSession = null;
    }
    // Restoring rather than clearing the flag ourselves puts the level and the flag back
    // exactly as the user had them and releases the claim, in one command.
    if (heldEndpoint && (await volume.restore())) heldEndpoint = false;
  };

  const gate = async (): Promise<void> => {
    if (heldSession || heldEndpoint) return;
    const name = sessionName();
    if (!name) {
      if (await volume.set({ muted: true })) heldEndpoint = true;
      return;
    }
    const acted = await volume.setSessionMute({ name, muted: true });
    if (acted === null) return;
    if (acted > 0) {
      heldSession = name;
      return;
    }
    // The audio is not where we think it is. Muting the endpoint in its place would
    // silence everything else on the machine and still not gate what we were aiming at,
    // so the miss is reported instead of covered up.
    const live = await volume.sessions();
    const names = live.map((session) => session.name).join(', ');
    console.log(`Duck matched no audio session for "${name}"; playing now: ${names || 'nothing'}`);
  };

  const apply = (): Promise<void> => {
    queue = queue.then(async () => {
      if (!started) return;
      await (audible ? release() : gate());
    });
    return queue;
  };

  return {
    async start(): Promise<SystemVolumeStatus> {
      if (started) return volume.status();
      const status = await volume.start();
      if (!status.ready) return status;
      started = true;
      await apply();
      return status;
    },

    setAudible(gateOptions: { audible: boolean; fadeSeconds: number }): void {
      if (gateOptions.audible) {
        // Cancelling here is the whole point of the hold-off: a gap shorter than the fade
        // never becomes a mute, so brief blocked moments do not chop the user's audio.
        cancelPending();
        audible = true;
        void apply();
        return;
      }
      // Already committed to silence: a repeat call is the orchestrator retrying a gate
      // the bridge could not answer, and the hold-off has already been served.
      if (!audible) {
        void apply();
        return;
      }
      if (pending) return;
      if (gateOptions.fadeSeconds <= 0) {
        audible = false;
        void apply();
        return;
      }
      pending = setTimeout(() => {
        pending = null;
        audible = false;
        void apply();
      }, gateOptions.fadeSeconds * MS_PER_SECOND);
    },

    async stop(): Promise<void> {
      if (!started) return;
      cancelPending();
      audible = true;
      // A command already in flight has to land before the release, or it would mute
      // after it.
      await apply();
      started = false;
      await volume.restore();
      await volume.stop();
      heldSession = null;
      heldEndpoint = false;
    },
  };
}
