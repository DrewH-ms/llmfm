import {
  DEFAULT_FADE_SECONDS,
  FOCUS_SESSION_ID,
  IGNORE_SUBAGENTS,
  SUBAGENT_GRACE_MS,
} from './constants.ts';
import type { GateMode } from './constants.ts';
import type { Mixer } from './mixer.ts';
import type { Scheduler } from './scheduler.ts';
import type { SessionRegistry } from './sessions.ts';
import type { Score, Session, SessionView } from './types.ts';

export type Orchestrator = {
  bindScore(score: Score): void;
  /** Recomputes part audibility from current session state and drives the transport. */
  refresh(): void;
  setMode(mode: GateMode): void;
  mode(): GateMode;
  setFadeSeconds(seconds: number): void;
  fadeSeconds(): number;
  sessionViews(): SessionView[];
};

/** Maps session state onto part audibility, and owns the rule that the transport runs
 *  whenever any part is audible and pauses only when all of them are silent. */
export function createOrchestrator(options: {
  registry: SessionRegistry;
  mixer: Mixer;
  scheduler: Scheduler;
}): Orchestrator {
  const { registry, mixer, scheduler } = options;

  let score: Score | null = null;
  let mode: GateMode = 'reward';
  let fade = DEFAULT_FADE_SECONDS;

  const shouldSound = (working: boolean): boolean => (mode === 'reward' ? working : !working);

  /** A sub-agent fires hooks but is never listed by the CLI, and it never waits on the
   *  user, so counting it would keep the orchestra playing over the silence that is the
   *  whole signal. New sessions are spared until the file has had time to list them. */
  const isSubAgent = (session: Session, now: number): boolean =>
    IGNORE_SUBAGENTS &&
    session.source === 'hook' &&
    !session.listedByCli &&
    now - session.startedAt >= SUBAGENT_GRACE_MS;

  const gatingSessions = (): Session[] => {
    const now = Date.now();
    const sessions = registry.list().filter((session) => !isSubAgent(session, now));
    if (!FOCUS_SESSION_ID) return sessions;
    return sessions.filter((session) => session.sessionId === FOCUS_SESSION_ID);
  };

  const refresh = (): void => {
    if (!score) return;

    const sessions = gatingSessions();
    // Until the voice tree lands, every part follows the aggregate session state, which is
    // exactly the single-session hold-music behaviour.
    const audible = sessions.length > 0 && sessions.some((session) => shouldSound(session.working));

    for (const part of score.parts) {
      mixer.setPartAudible({ partId: part.partId, audible, fadeSeconds: fade });
    }

    if (mixer.anyAudible()) scheduler.play();
    else scheduler.pause();
  };

  return {
    bindScore(next: Score): void {
      score = next;
      mixer.bindScore(next);
      scheduler.load(next);
      refresh();
    },
    refresh,
    setMode(next: GateMode): void {
      mode = next;
      refresh();
    },
    mode: (): GateMode => mode,
    setFadeSeconds(seconds: number): void {
      fade = seconds > 0 ? seconds : DEFAULT_FADE_SECONDS;
    },
    fadeSeconds: (): number => fade,
    sessionViews(): SessionView[] {
      return gatingSessions().map((session) => ({
        sessionId: session.sessionId,
        working: session.working,
        cwd: session.cwd,
        label: session.label,
        source: session.source,
        blockedMidTurn: session.blockedMidTurn,
        updatedAt: session.updatedAt,
        voiceName: null,
        audible: shouldSound(session.working),
      }));
    },
  };
}
