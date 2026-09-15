import {
  SETTLE_MARGIN_MS,
  BLOCK_SETTLE_MS,
  FOCUS_SESSION_ID,
  IGNORE_SUBAGENTS,
  MS_PER_MINUTE,
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

const MS_PER_SECOND = 1000;

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
  /** Instrument label per part id, taken from the voice tree's own leaf names so a part
   *  listed under a voice reads exactly as it would if it were the voice. */
  let partLabels = new Map<string, string>();
  /** How far the voice tree is currently subdivided. */
  let voiceCount = 0;
  let coarsenTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-checks the transport once a fade-out has actually reached silence. */
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const shouldSound = (session: Session): boolean => {
    // Nothing is emitted when a permission prompt is answered, so a session can sit
    // blocked-looking while the tool it authorised runs. `resume` guesses the prompt was
    // answered; the default keeps faith with silence meaning "needed".
    const stale =
      config.current().promptGap === 'resume' &&
      session.blockedMidTurn &&
      session.blockedSince !== null &&
      Date.now() - session.blockedSince >= PROMPT_GAP_RESUME_MS;
    const working = session.working || stale || settling(session);
    return config.current().mode === 'reward' ? working : !working;
  };

  /** A block too young to trust yet. See BLOCK_SETTLE_MS: the prompt may already have been
   *  answered for the user, in which case silencing now only chops the music. */
  const settling = (session: Session): boolean =>
    session.blockedMidTurn &&
    session.blockedSince !== null &&
    Date.now() - session.blockedSince < BLOCK_SETTLE_MS;

  /** A sub-agent fires hooks but is never listed by the CLI, and it never waits on the
   *  user, so counting it would keep the orchestra playing over the silence that is the
   *  whole signal. New sessions are spared until the file has had time to list them. */
  const isSubAgent = (session: Session, now: number): boolean =>
    IGNORE_SUBAGENTS &&
    session.source === 'hook' &&
    !session.listedByCli &&
    now - session.startedAt >= SUBAGENT_GRACE_MS;

  /** A terminal that was closed is never removed from the CLI's session file, so without
   *  this it keeps its instrument forever. Only idle sessions are dropped: a working one
   *  is legitimately holding its voice however long it has been at it. */
  const isIdleTooLong = (session: Session, now: number): boolean => {
    const minutes = config.current().idleDropoutMinutes;
    if (minutes <= 0 || session.working) return false;
    return now - session.updatedAt >= minutes * MS_PER_MINUTE;
  };

  /** Sessions that may hold a voice. A muted session is deliberately excluded here rather
   *  than gated silent, so it frees its voice for someone else instead of sounding like an
   *  agent that stopped. */
  const gatingSessions = (): Session[] => {
    const now = Date.now();
    const muteRules = config.current();
    const sessions = registry
      .list()
      .filter(
        (session) =>
          !isSubAgent(session, now) &&
          !isMuted(muteRules, session) &&
          !isIdleTooLong(session, now),
      );
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

  /** How the mix answers to the sessions. `per-agent` is the ensemble, where each session
   *  gates only its own voice. The others gate everything together, which is what plain
   *  hold music across a fleet means. Inversion is not handled here: `shouldSound` has
   *  already applied `mode`, so aggregating afterwards yields the reversed variants free. */
  const mixAudible = (sessions: Session[]): boolean => {
    const policy = config.current().gate;
    if (policy === 'always') return true;
    if (sessions.length === 0) return false;
    return policy === 'all' ? sessions.every(shouldSound) : sessions.some(shouldSound);
  };

  /** A section-sized voice gates several instruments under one name. Naming them is what
   *  separates the parts that answer to this session from the backing that answers to
   *  nobody. */
  const partNamesOf = (voice: Voice): string[] => {
    const names = new Set<string>();
    for (const partId of voice.partIds) {
      const label = partLabels.get(partId);
      if (label) names.add(label);
    }
    return [...names];
  };

  const refresh = (): void => {
    if (!score) return;

    const sessions = gatingSessions();
    const fade = config.current().fadeSeconds;
    settleVoiceCount(sessions.length);
    const assignment = currentAssignment(sessions);
    const perAgent = config.current().gate === 'per-agent';

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
    const ensembleAudible = perAgent ? audibleParts.size > 0 : mixAudible(sessions);

    for (const part of score.parts) {
      const audible =
        perAgent && voicedParts.has(part.partId)
          ? audibleParts.has(part.partId)
          : ensembleAudible;
      mixer.setPartAudible({ partId: part.partId, audible, fadeSeconds: fade });
    }

    // `mute` keeps the transport running through the silence. It costs the resume-in-place
    // effect, and exists because nothing else can work once we are riding audio we do not
    // own: there is no pausing another application's stream.
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    // A block still inside its settle window has to be revisited, or a prompt the user
    // really is waiting on would never silence its part.
    const pending = sessions
      .filter(settling)
      .map((session) => BLOCK_SETTLE_MS - (Date.now() - (session.blockedSince ?? 0)));
    const soonest = pending.length > 0 ? Math.max(0, Math.min(...pending)) : null;

    if (mixer.anyAudible() || config.current().silenceMode === 'mute') {
      scheduler.play();
      // Pausing the moment the gate shuts would cut the notes the fade still needs, so the
      // transport runs on and the decision is retaken once the ramp has reached zero.
      const wait = !mixer.anyGateOpen() ? fade * MS_PER_SECOND + SETTLE_MARGIN_MS : null;
      const delay =
        soonest === null ? wait : wait === null ? soonest : Math.min(soonest, wait);
      if (delay !== null) settleTimer = setTimeout(refresh, delay + SETTLE_MARGIN_MS);
    } else {
      scheduler.pause();
      if (soonest !== null) settleTimer = setTimeout(refresh, soonest + SETTLE_MARGIN_MS);
    }
  };

  return {
    bindScore(next: Score): void {
      score = next;
      tree = buildVoiceTree(next);
      // Fully subdividing names every part the tree can gate; what it leaves out is
      // backing, which never belongs to a voice.
      partLabels = new Map(
        tree
          .voicesFor(next.parts.length)
          .flatMap((voice) => voice.partIds.map((partId): [string, string] => [partId, voice.name])),
      );
      mixer.bindScore(next);
      scheduler.load(next);
      refresh();
    },
    refresh,
    setMode(next: GateMode): void {
      config.setSetting('mode', next);
      refresh();
    },
    mode: (): GateMode => config.current().mode,
    setFadeSeconds(seconds: number): void {
      config.setSetting('fadeSeconds', seconds);
    },
    fadeSeconds: (): number => config.current().fadeSeconds,
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
          blockedSince: session.blockedSince,
          updatedAt: session.updatedAt,
          handle: handleFor(session),
          muted,
          voiceName: voice?.name ?? null,
          voiceParts: voice ? partNamesOf(voice) : [],
          audible: !muted && voice !== undefined && shouldSound(session),
        };
      });
    },
  };
}
