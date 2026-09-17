import {
  SETTLE_MARGIN_MS,
  BLOCK_SETTLE_MS,
  FOCUS_SESSION_ID,
  FOLD_EVIDENCE_MAX_MS,
  MS_PER_MINUTE,
  PROMPT_GAP_RESUME_MS,
  SUBAGENT_GRACE_MS,
  VOICE_RESPLIT_DEBOUNCE_MS,
  WATCH_OPEN_SESSIONS,
  WORKING_CLAIM_MAX_MS,
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
  /** Hands the gate to a track with no parts, so the whole stream answers to the sessions together. */
  bindRecorded(): void;
  /** Recomputes part audibility from current session state and drives the transport. */
  refresh(): void;
  setMode(mode: GateMode): void;
  mode(): GateMode;
  setFadeSeconds(seconds: number): void;
  fadeSeconds(): number;
  sessionViews(): SessionView[];
  /** Clears pending re-checks; a surviving timer would hold the process open after shutdown. */
  stop(): void;
};

/** Where the gate lands when there are no parts to spread it across: a mixdown, or another app's audio. */
export type StreamSink = {
  setAudible(options: { audible: boolean; fadeSeconds: number }): void;
};

/** The transport runs whenever any part is audible and pauses only when all of them are silent. */
export function createOrchestrator(options: {
  registry: SessionRegistry;
  mixer: Mixer;
  scheduler: Scheduler;
  config: ConfigStore;
  recorded?: StreamSink;
  /** Drives the system volume so the user's own music carries the signal. */
  duck?: StreamSink;
}): Orchestrator {
  const { registry, mixer, scheduler, config } = options;
  const recorded = options.recorded ?? null;
  const duck = options.duck ?? null;

  let score: Score | null = null;
  /** Exclusive with `score`: a mixdown has no parts, so there is no tree, assignment or per-part gate. */
  let recordedTrack = false;
  let tree: VoiceTree | null = null;
  /** Instrument label per part id, from the tree's leaf names so a part reads as it would if it were the voice. */
  let partLabels = new Map<string, string>();
  let voiceCount = 0;
  let coarsenTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-checks the transport once a fade-out has actually reached silence. */
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const shouldSound = (session: Session): boolean => {
    // Nothing is emitted when a permission prompt is answered, so `resume` guesses it was; the default trusts silence.
    const stale =
      config.current().promptGap === 'resume' &&
      session.blockedMidTurn &&
      session.blockedSince !== null &&
      Date.now() - session.blockedSince >= PROMPT_GAP_RESUME_MS;
    const working =
      session.working || stale || settling(session) || isFolded(session, Date.now());
    return config.current().mode === 'reward' ? working : !working;
  };

  /** A block too young to trust: the prompt may already have been answered, and silencing now only chops the music. */
  const settling = (session: Session): boolean =>
    session.blockedMidTurn &&
    session.blockedSince !== null &&
    Date.now() - session.blockedSince < BLOCK_SETTLE_MS;

  /** A sub-agent fires hooks but is never listed by the CLI; new sessions are spared until the file can list them. */
  const isSubAgent = (session: Session, now: number): boolean =>
    WATCH_OPEN_SESSIONS &&
    session.source === 'hook' &&
    !session.listedByCli &&
    now - session.startedAt >= SUBAGENT_GRACE_MS;

  /** Whether this session is one that sub-agent mode keeps out of the music entirely. */
  const isHiddenSubAgent = (session: Session, now: number): boolean =>
    config.current().subagents !== 'voice' && isSubAgent(session, now);

  /** A parent that dispatches and waits fires `agentStop`; folding keeps it audible, but a mid-turn block never folds. */
  const isFolded = (session: Session, now: number): boolean => {
    if (config.current().subagents !== 'fold') return false;
    if (session.blockedMidTurn || !session.listedByCli || session.cwd === null) return false;
    return registry
      .list()
      .some(
        (other) =>
          other.working &&
          other.cwd === session.cwd &&
          // Fold evidence expires: a sub-agent killed mid-tool is never retired and would hold its parent audible.
          now - other.updatedAt < FOLD_EVIDENCE_MAX_MS &&
          isSubAgent(other, now),
      );
  };

  /** A closed terminal is never removed from the CLI's file, and a session killed mid-tool has a `working` nothing can correct. */
  const isExpired = (session: Session, now: number): boolean => {
    if (isFolded(session, now)) return false;
    if (session.working) return now - session.updatedAt >= WORKING_CLAIM_MAX_MS;
    const minutes = config.current().idleDropoutMinutes;
    if (minutes <= 0) return false;
    return now - session.updatedAt >= minutes * MS_PER_MINUTE;
  };

  /** A muted session is excluded rather than gated silent, so it frees its voice instead of sounding stopped. */
  const gatingSessions = (): Session[] => {
    const now = Date.now();
    const muteRules = config.current();
    const sessions = registry
      .list()
      .filter(
        (session) =>
          !isHiddenSubAgent(session, now) &&
          !isMuted(muteRules, session) &&
          !isExpired(session, now),
      );
    if (!FOCUS_SESSION_ID) return sessions;
    return sessions.filter((session) => session.sessionId === FOCUS_SESSION_ID);
  };

  /** Hash collisions deepen the tree rather than slide a session sideways, so a repo always sounds from its branch. */
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

  /** Splitting is immediate but coarsening waits: a closed terminal is often reopened, and re-texturing twice jars. */
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

  /** Inversion is not handled here: `shouldSound` already applied `mode`, so aggregating yields the reversed variants. */
  const mixAudible = (sessions: Session[]): boolean => {
    const policy = config.current().gate;
    if (policy === 'always') return true;
    if (sessions.length === 0) return false;
    return policy === 'all' ? sessions.every(shouldSound) : sessions.some(shouldSound);
  };

  /** Naming a section voice's instruments separates the parts that answer to this session from the backing. */
  const partNamesOf = (voice: Voice): string[] => {
    const names = new Set<string>();
    for (const partId of voice.partIds) {
      const label = partLabels.get(partId);
      if (label) names.add(label);
    }
    return [...names];
  };

  /** Next moment a block changes what should sound: the CLI emits nothing at the settle or `resume` marks. */
  const soonestRecheck = (sessions: Session[]): number | null => {
    const resuming = config.current().promptGap === 'resume';
    const now = Date.now();
    const pending: number[] = [];
    for (const session of sessions) {
      if (!session.blockedMidTurn || session.blockedSince === null) continue;
      const age = now - session.blockedSince;
      if (age < BLOCK_SETTLE_MS) pending.push(BLOCK_SETTLE_MS - age);
      if (resuming && age < PROMPT_GAP_RESUME_MS) pending.push(PROMPT_GAP_RESUME_MS - age);
    }
    return pending.length > 0 ? Math.max(0, Math.min(...pending)) : null;
  };

  /** Ducking wins over a recorded track because in that mode the daemon plays nothing of its own. */
  const wholeStreamSink = (): StreamSink | null =>
    config.current().audio === 'duck' ? duck : recordedTrack ? recorded : null;

  const scheduleSettle = (delayMs: number | null): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    if (delayMs === null) return;
    settleTimer = setTimeout(refresh, delayMs + SETTLE_MARGIN_MS);
  };

  const refresh = (): void => {
    const stream = wholeStreamSink();
    if (stream) {
      const sessions = gatingSessions();
      stream.setAudible({
        audible: mixAudible(sessions),
        fadeSeconds: config.current().fadeSeconds,
      });
      scheduleSettle(soonestRecheck(sessions));
      return;
    }
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

    // Parts no session speaks for follow the ensemble; with one session that is the whole orchestra.
    const ensembleAudible = perAgent ? audibleParts.size > 0 : mixAudible(sessions);

    for (const part of score.parts) {
      const audible =
        perAgent && voicedParts.has(part.partId)
          ? audibleParts.has(part.partId)
          : ensembleAudible;
      mixer.setPartAudible({ partId: part.partId, audible, fadeSeconds: fade });
    }

    // `mute` keeps our own transport running through the silence, trading resume-in-place for not stopping the piece.
    const soonest = soonestRecheck(sessions);

    if (mixer.anyAudible() || config.current().silenceMode === 'mute') {
      scheduler.play();
      // Pausing the moment the gate shuts would cut the notes the fade still needs, so the decision is retaken later.
      const wait = !mixer.anyGateOpen() ? fade * MS_PER_SECOND + SETTLE_MARGIN_MS : null;
      scheduleSettle(
        soonest === null ? wait : wait === null ? soonest : Math.min(soonest, wait),
      );
    } else {
      scheduler.pause();
      scheduleSettle(soonest);
    }
  };

  return {
    bindScore(next: Score): void {
      score = next;
      recordedTrack = false;
      tree = buildVoiceTree(next);
      // Fully subdividing names every part the tree can gate; what it leaves out is backing.
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
    /** Tree, labels and per-part mix are dropped: a stale ensemble would keep answering for music with no parts. */
    bindRecorded(): void {
      score = null;
      tree = null;
      partLabels = new Map();
      voiceCount = 0;
      recordedTrack = true;
      mixer.silenceAll();
      refresh();
    },
    setMode(next: GateMode): void {
      config.setSetting('mode', next);
      refresh();
    },
    mode: (): GateMode => config.current().mode,
    setFadeSeconds(seconds: number): void {
      config.setSetting('fadeSeconds', seconds);
    },
    fadeSeconds: (): number => config.current().fadeSeconds,
    stop(): void {
      if (settleTimer) clearTimeout(settleTimer);
      if (coarsenTimer) clearTimeout(coarsenTimer);
      settleTimer = null;
      coarsenTimer = null;
    },
    sessionViews(): SessionView[] {
      const now = Date.now();
      const muteRules = config.current();
      // Muted sessions are listed though they hold no voice: hiding one would leave no way to unmute it.
      const visible = registry.list().filter((session) => !isHiddenSubAgent(session, now));
      const assignment = currentAssignment(gatingSessions());
      return visible.map((session) => {
        const voice = assignment.bySession.get(session.sessionId);
        const muted = isMuted(muteRules, session);
        return {
          sessionId: session.sessionId,
          working: session.working,
          folded: !session.working && isFolded(session, now),
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
