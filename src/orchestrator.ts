import {
  DEFAULT_FADE_SECONDS,
  FOCUS_SESSION_ID,
  IGNORE_SUBAGENTS,
  PROMPT_GAP_RESUME_MS,
  SUBAGENT_GRACE_MS,
  VOICE_RESPLIT_DEBOUNCE_MS,
} from './constants.ts';
import type { GateMode } from './constants.ts';
import { assignVoices } from './assignment.ts';
import { handleFor, isMuted } from './config.ts';
import type { ConfigStore } from './config.ts';
import { buildVoiceTree } from './voices.ts';
import type { Mixer } from './mixer.ts';
import type { Scheduler } from './scheduler.ts';
import type { SessionRegistry } from './sessions.ts';
import type { Score, Session, SessionView, Voice, VoiceAssignment, VoiceTree } from './types.ts';

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
  config: ConfigStore;
}): Orchestrator {
  const { registry, mixer, scheduler, config } = options;

  let score: Score | null = null;
  let tree: VoiceTree | null = null;
  let mode: GateMode = 'reward';
  let fade = DEFAULT_FADE_SECONDS;
  /** How far the voice tree is currently subdivided. */
  let voiceCount = 0;
  let coarsenTimer: ReturnType<typeof setTimeout> | null = null;

  const shouldSound = (session: Session): boolean => {
    // Nothing is emitted when a permission prompt is answered, so a session can sit
    // blocked-looking while the tool it authorised runs. `resume` guesses the prompt was
    // answered; the default keeps faith with silence meaning "needed".
    const stale =
      config.current().promptGap === 'resume' &&
      session.blockedMidTurn &&
      Date.now() - session.updatedAt >= PROMPT_GAP_RESUME_MS;
    const working = session.working || stale;
    return mode === 'reward' ? working : !working;
  };

  /** A sub-agent fires hooks but is never listed by the CLI, and it never waits on the
   *  user, so counting it would keep the orchestra playing over the silence that is the
   *  whole signal. New sessions are spared until the file has had time to list them. */
  const isSubAgent = (session: Session, now: number): boolean =>
    IGNORE_SUBAGENTS &&
    session.source === 'hook' &&
    !session.listedByCli &&
    now - session.startedAt >= SUBAGENT_GRACE_MS;

  /** Sessions that may hold a voice. A muted session is deliberately excluded here rather
   *  than gated silent, so it frees its voice for someone else instead of sounding like an
   *  agent that stopped. */
  const gatingSessions = (): Session[] => {
    const now = Date.now();
    const muteRules = config.current();
    const sessions = registry
      .list()
      .filter((session) => !isSubAgent(session, now) && !isMuted(muteRules, session));
    if (!FOCUS_SESSION_ID) return sessions;
    return sessions.filter((session) => session.sessionId === FOCUS_SESSION_ID);
  };

  /** Two repos can hash into the same branch. Resolving that by sliding one sideways into
   *  a free voice would break the promise that a repo always sounds from the same place —
   *  and break it for whichever session merely arrived second. Subdividing further instead
   *  keeps every session inside the branch it hashed to, which is the promise that makes
   *  the mapping learnable. Deepening stops once the tree can no longer yield new voices. */
  const currentAssignment = (sessions: Session[]): VoiceAssignment => {
    if (!tree || voiceCount === 0) return assignVoices({ sessions, voices: [] });

    let depth = voiceCount;
    let voices: Voice[] = tree.voicesFor(depth);
    let assignment = assignVoices({ sessions, voices });

    while (assignment.unvoicedSessionIds.length > 0) {
      const deeper: Voice[] = tree.voicesFor(depth + 1);
      if (deeper.length <= voices.length) break;
      depth += 1;
      voices = deeper;
      assignment = assignVoices({ sessions, voices });
    }
    return assignment;
  };

  /** Splitting is immediate so a new session is heard at once, but coarsening waits for
   *  the lower count to hold: a closed terminal is often reopened, and rearranging the
   *  texture twice is more distracting than carrying an unused voice for a few seconds. */
  const settleVoiceCount = (sessionCount: number): void => {
    if (sessionCount > voiceCount) {
      if (coarsenTimer) {
        clearTimeout(coarsenTimer);
        coarsenTimer = null;
      }
      voiceCount = sessionCount;
      return;
    }
    if (sessionCount === voiceCount || coarsenTimer) return;
    coarsenTimer = setTimeout(() => {
      coarsenTimer = null;
      voiceCount = gatingSessions().length;
      refresh();
    }, VOICE_RESPLIT_DEBOUNCE_MS);
  };

  const refresh = (): void => {
    if (!score) return;

    const sessions = gatingSessions();
    settleVoiceCount(sessions.length);
    const assignment = currentAssignment(sessions);

    const audibleParts = new Set<string>();
    const voicedParts = new Set<string>();
    for (const session of sessions) {
      const voice = assignment.bySession.get(session.sessionId);
      if (!voice) continue;
      for (const partId of voice.partIds) {
        voicedParts.add(partId);
        if (shouldSound(session)) audibleParts.add(partId);
      }
    }

    // Parts no session speaks for follow the ensemble, so they colour the texture without
    // claiming anything about an agent. With one session that is the whole orchestra,
    // which is what makes single-session behaviour plain hold music.
    const ensembleAudible = audibleParts.size > 0;

    for (const part of score.parts) {
      const audible = voicedParts.has(part.partId)
        ? audibleParts.has(part.partId)
        : ensembleAudible;
      mixer.setPartAudible({ partId: part.partId, audible, fadeSeconds: fade });
    }

    if (mixer.anyAudible()) scheduler.play();
    else scheduler.pause();
  };

  return {
    bindScore(next: Score): void {
      score = next;
      tree = buildVoiceTree(next);
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
      const now = Date.now();
      const muteRules = config.current();
      // Muted sessions are listed even though they hold no voice: hiding one would leave
      // no way to find it again and unmute it.
      const visible = registry.list().filter((session) => !isSubAgent(session, now));
      const assignment = currentAssignment(gatingSessions());
      return visible.map((session) => {
        const voice = assignment.bySession.get(session.sessionId);
        const muted = isMuted(muteRules, session);
        return {
          sessionId: session.sessionId,
          working: session.working,
          cwd: session.cwd,
          label: session.label,
          source: session.source,
          blockedMidTurn: session.blockedMidTurn,
          updatedAt: session.updatedAt,
          handle: handleFor(session),
          muted,
          voiceName: voice?.name ?? null,
          audible: !muted && voice !== undefined && shouldSound(session),
        };
      });
    },
  };
}
