import { HOOK_AUTHORITY_MS } from './constants.ts';
import { outcomeOf } from './intake.ts';
import type { HookEvent, Session } from './types.ts';

/** Enough of the session id to tell two sessions apart when there is no cwd. */
const SESSION_ID_LABEL_LENGTH = 8;

export type SessionRegistry = {
  /** Applies an already-narrowed hook event. Hook readings are authoritative. */
  applyHookEvent(event: HookEvent): void;
  /** Corroboration from open-sessions-state.json; must not override a fresh hook reading. */
  applyFileState(entries: { sessionId: string; working: boolean }[]): void;
  /** Drives simulation mode without pretending to be a real session source. */
  applySimulated(options: { sessionId: string; working: boolean; label: string }): void;
  removeSimulated(): void;
  list(): Session[];
  /** Notifies on any observable change. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
};

function labelOf(options: { cwd: string | null; sessionId: string }): string {
  const segments = options.cwd?.split(/[\\/]+/).filter((segment) => segment.length > 0) ?? [];
  return segments.at(-1) ?? options.sessionId.slice(0, SESSION_ID_LABEL_LENGTH);
}

export function createSessionRegistry(): SessionRegistry {
  const sessions = new Map<string, Session>();
  /** Sessions the open-sessions file has ever listed. Internal bookkeeping, not published. */
  const seenInFile = new Set<string>();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  return {
    applyHookEvent(event: HookEvent): void {
      const outcome = outcomeOf(event);
      const previous = sessions.get(event.sessionId);

      if (outcome === 'ended') {
        if (!previous) return;
        sessions.delete(event.sessionId);
        seenInFile.delete(event.sessionId);
        emit();
        return;
      }
      if (!previous && outcome === null) return;

      const cwd = event.cwd ?? previous?.cwd ?? null;
      const working = outcome === null ? (previous?.working ?? false) : outcome === 'working';
      const now = Date.now();
      const blockedMidTurn =
        outcome === null
          ? (previous?.blockedMidTurn ?? false)
          : event.name === 'notification' && outcome === 'awaiting-input';
      const next: Session = {
        sessionId: event.sessionId,
        working,
        cwd,
        label: labelOf({ cwd, sessionId: event.sessionId }),
        source: 'hook',
        blockedMidTurn,
        // Held across a repeated prompt: one prompt can fire `notification` twice, and
        // restarting the clock there would hide exactly the long block it exists to show.
        blockedSince: blockedMidTurn ? (previous?.blockedSince ?? now) : null,
        listedByCli: seenInFile.has(event.sessionId),
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      };
      sessions.set(event.sessionId, next);

      if (
        !previous ||
        previous.working !== next.working ||
        previous.cwd !== next.cwd ||
        previous.source !== next.source
      ) {
        emit();
      }
    },

    applyFileState(entries: { sessionId: string; working: boolean }[]): void {
      const now = Date.now();
      const present = new Set<string>();
      let changed = false;

      for (const entry of entries) {
        present.add(entry.sessionId);
        seenInFile.add(entry.sessionId);
        const previous = sessions.get(entry.sessionId);
        if (previous?.source === 'simulation') continue;
        // Being listed at all is the fact that separates a session the user is sitting in
        // front of from a sub-agent, so it is recorded even when nothing else changed.
        if (previous && !previous.listedByCli) {
          sessions.set(entry.sessionId, { ...previous, listedByCli: true });
          changed = true;
        }
        // The file's flag only flips at turn boundaries, so a recent hook reading outranks it.
        if (previous?.source === 'hook' && now - previous.updatedAt < HOOK_AUTHORITY_MS) continue;
        // Its authority is one-way. The file's `working: true` carries no information,
        // because the flag tracks *the CLI* being busy — it stays true while a background
        // shell runs and while an agent sits on a prompt. Only its `false`, and its word
        // on existence, mean anything. So a `true` registers the session but never asserts
        // work: asserting work is a hook's job alone. Otherwise a cold start, where the
        // file is the only signal, brings every already-open session up busy and holds the
        // music on indefinitely, since an idle agent fires no hook to correct it.
        // A known session is only ever silenced here, never started; an unknown one is
        // registered in the silent state, so existence is recorded without a claim.
        if (previous && (entry.working || !previous.working)) continue;

        const cwd = previous?.cwd ?? null;
        sessions.set(entry.sessionId, {
          sessionId: entry.sessionId,
          working: false,
          cwd,
          label: labelOf({ cwd, sessionId: entry.sessionId }),
          source: 'file',
          blockedMidTurn: false,
          blockedSince: null,
          listedByCli: true,
          startedAt: previous?.startedAt ?? now,
          updatedAt: now,
        });
        changed = true;
      }

      for (const [sessionId, session] of sessions) {
        if (present.has(sessionId) || session.source === 'simulation') continue;
        if (session.blockedMidTurn) continue;
        // The file may only evict what it once claimed: a session it never listed is one
        // it does not track, and only `sessionEnd` can retire that.
        if (!seenInFile.has(sessionId)) continue;
        // A hook session dropped by the file outlived its authority window: its
        // sessionEnd was missed, so the file's word on existence now stands.
        if (session.source === 'file' || now - session.updatedAt >= HOOK_AUTHORITY_MS) {
          sessions.delete(sessionId);
          seenInFile.delete(sessionId);
          changed = true;
        }
      }

      if (changed) emit();
    },

    applySimulated(options: { sessionId: string; working: boolean; label: string }): void {
      const previous = sessions.get(options.sessionId);
      sessions.set(options.sessionId, {
        sessionId: options.sessionId,
        working: options.working,
        cwd: null,
        label: options.label,
        source: 'simulation',
        blockedMidTurn: false,
        blockedSince: null,
        listedByCli: false,
        startedAt: previous?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      if (
        !previous ||
        previous.working !== options.working ||
        previous.label !== options.label ||
        previous.source !== 'simulation'
      ) {
        emit();
      }
    },

    removeSimulated(): void {
      let changed = false;
      for (const [sessionId, session] of sessions) {
        if (session.source !== 'simulation') continue;
        sessions.delete(sessionId);
        changed = true;
      }
      if (changed) emit();
    },

    list(): Session[] {
      return [...sessions.values()];
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
