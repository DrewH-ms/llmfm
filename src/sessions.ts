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
      const next: Session = {
        sessionId: event.sessionId,
        working,
        cwd,
        label: labelOf({ cwd, sessionId: event.sessionId }),
        source: 'hook',
        blockedMidTurn:
          outcome === null
            ? (previous?.blockedMidTurn ?? false)
            : event.name === 'notification' && outcome === 'awaiting-input',
        updatedAt: Date.now(),
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
        // The file's flag only flips at turn boundaries, so a recent hook reading outranks it.
        if (previous?.source === 'hook' && now - previous.updatedAt < HOOK_AUTHORITY_MS) continue;
        // Its authority is directional: it can see a turn end, but never a mid-turn block,
        // so it may clear `working` but may not restore it over a blocked session.
        if (entry.working && previous?.blockedMidTurn) continue;
        if (previous && previous.working === entry.working) continue;

        const cwd = previous?.cwd ?? null;
        sessions.set(entry.sessionId, {
          sessionId: entry.sessionId,
          working: entry.working,
          cwd,
          label: labelOf({ cwd, sessionId: entry.sessionId }),
          source: 'file',
          blockedMidTurn: false,
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
