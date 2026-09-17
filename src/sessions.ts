import { HOOK_AUTHORITY_MS } from './constants.ts';
import { outcomeOf } from './intake.ts';
import type { HookEvent, OpenSessionEntry, Session } from './types.ts';

/** Enough of the session id to tell two sessions apart when there is no cwd. */
const SESSION_ID_LABEL_LENGTH = 8;

export type SessionRegistry = {
  /** Applies an already-narrowed hook event. Hook readings are authoritative. */
  applyHookEvent(event: HookEvent): void;
  /** Corroboration from open-sessions-state.json; must not override a fresh hook reading. */
  applyFileState(entries: OpenSessionEntry[]): void;
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
  const seenInFile = new Set<string>();
  /** Ids a `sessionEnd` retired; the CLI leaves ended sessions in its file for days, so the next poll would re-add them. */
  const endedByHook = new Set<string>();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  return {
    applyHookEvent(event: HookEvent): void {
      const outcome = outcomeOf(event);
      const previous = sessions.get(event.sessionId);

      if (outcome === 'ended') {
        endedByHook.add(event.sessionId);
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
        // Held across a repeat `notification` for one prompt: restarting the clock would hide the long block.
        blockedSince: blockedMidTurn ? (previous?.blockedSince ?? now) : null,
        listedByCli: seenInFile.has(event.sessionId),
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      };
      sessions.set(event.sessionId, next);
      endedByHook.delete(event.sessionId);

      if (
        !previous ||
        previous.working !== next.working ||
        previous.cwd !== next.cwd ||
        previous.source !== next.source ||
        previous.blockedMidTurn !== next.blockedMidTurn
      ) {
        emit();
      }
    },

    applyFileState(entries: OpenSessionEntry[]): void {
      const now = Date.now();
      const present = new Set<string>();
      let changed = false;

      for (const entry of entries) {
        present.add(entry.sessionId);
        // `sessionEnd` is authoritative and the file outlives it by days; honouring the file would undo the hook.
        if (endedByHook.has(entry.sessionId)) continue;
        seenInFile.add(entry.sessionId);
        const previous = sessions.get(entry.sessionId);
        if (previous?.source === 'simulation') continue;
        // Being listed at all is what separates a real session from a sub-agent, so record it even if nothing else changed.
        if (previous && !previous.listedByCli) {
          sessions.set(entry.sessionId, { ...previous, listedByCli: true });
          changed = true;
        }
        // The file's flag only flips at turn boundaries, so a recent hook reading outranks it.
        if (previous?.source === 'hook' && now - previous.updatedAt < HOOK_AUTHORITY_MS) continue;
        // One-way authority: the file's `working: true` only means the CLI is busy, so it may silence a known session
        // or register an unknown one silent, but never assert work — else a cold start holds the music on forever.
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
          // The CLI's own timestamp: dating from daemon start gives a terminal closed days ago a full idle window.
          startedAt: previous?.startedAt ?? entry.refreshedAt ?? now,
          updatedAt: previous?.updatedAt ?? entry.refreshedAt ?? now,
        });
        changed = true;
      }

      for (const [sessionId, session] of sessions) {
        if (present.has(sessionId) || session.source === 'simulation') continue;
        if (session.blockedMidTurn) continue;
        // The file may only evict what it once claimed; anything else is retired by `sessionEnd` alone.
        if (!seenInFile.has(sessionId)) continue;
        // A hook session dropped by the file outlived its authority window: its `sessionEnd` was missed.
        if (session.source === 'file' || now - session.updatedAt >= HOOK_AUTHORITY_MS) {
          sessions.delete(sessionId);
          seenInFile.delete(sessionId);
          changed = true;
        }
      }

      // Once the CLI has dropped the entry there is nothing left to suppress.
      for (const sessionId of endedByHook) {
        if (!present.has(sessionId)) endedByHook.delete(sessionId);
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
