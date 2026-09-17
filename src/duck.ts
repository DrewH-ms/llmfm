/** Gates audio LLMFM does not own: a named application's stream is muted alone, otherwise the whole endpoint. */

import type { SystemVolume, SystemVolumeStatus } from './system-volume.ts';

const MS_PER_SECOND = 1000;

export type Duck = {
  /** Brings up the volume bridge. Resolves to its status and never rejects. */
  start(): Promise<SystemVolumeStatus>;
  /** A mute flag has no ramp, so `fadeSeconds` is a hold-off before muting; unmuting is instant. */
  setAudible(options: { audible: boolean; fadeSeconds: number }): void;
  /** Unmutes and releases the bridge. */
  stop(): Promise<void>;
};

/** `sessionName` is read at each gate change because the application may arrive or leave under a running daemon. */
export function createDuck(options: {
  volume: SystemVolume;
  sessionName: () => string | null;
}): Duck {
  const { volume, sessionName } = options;
  let started = false;
  let audible = true;
  /** Held by name so the mute is released even after whatever named it has gone away. */
  let heldSession: string | null = null;
  /** At most one of the two is ever held: a flag the user cleared themselves is not set again behind them. */
  let heldEndpoint = false;
  /** Commands are queued, never concurrent: a mute racing the restore that should outlive it is the fatal ordering. */
  let queue: Promise<void> = Promise.resolve();
  /** Held rather than restarted while it runs, so a session flickering does not push the mute back indefinitely. */
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
    // Restore rather than clearing the flag: puts level and flag back as the user had them and releases the claim.
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
    // Muting the endpoint instead would silence the whole machine and still miss the target, so report the miss.
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
      // A dead bridge gates as a no-op, so start respawns; re-asserting its stale holds would block re-gating.
      if (started && volume.status().ready) return volume.status();
      started = false;
      heldSession = null;
      heldEndpoint = false;
      const status = await volume.start();
      if (!status.ready) return status;
      started = true;
      await apply();
      return status;
    },

    setAudible(gateOptions: { audible: boolean; fadeSeconds: number }): void {
      if (gateOptions.audible) {
        // The hold-off's whole point: a gap shorter than the fade never becomes a mute.
        cancelPending();
        audible = true;
        void apply();
        return;
      }
      // A repeat call is the orchestrator retrying a gate the bridge could not answer; the hold-off is already served.
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
      // A command already in flight has to land first, or it would mute after the release.
      await apply();
      started = false;
      await volume.restore();
      await volume.stop();
    },
  };
}
