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
  /** Hands the gate to a track with no parts, so the whole stream answers to the sessions
   *  together. */
  bindRecorded(): void;
  /** Recomputes part audibility from current session state and drives the transport. */
  refresh(): void;
  setMode(mode: GateMode): void;
  mode(): GateMode;
  setFadeSeconds(seconds: number): void;
  fadeSeconds(): number;
  sessionViews(): SessionView[];
  /** Clears pending re-checks. Without it a settle or re-split timer outlives shutdown and
   *  holds the process open waiting to reconsider a mix that no longer exists. */
  stop(): void;
};

/** Where the gate lands when there are no parts to spread it across: a finished mixdown,
 *  or audio playing out of an application that is not ours. Neither can be subdivided, so
 *  the ensemble collapses to one boolean for the whole stream. */
export type StreamSink = {
  setAudible(options: { audible: boolean; fadeSeconds: number }): void;
};

/** Maps session state onto part audibility, and owns the rule that the transport runs
 *  whenever any part is audible and pauses only when all of them are silent. */
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
  /** Set instead of `score` while a recorded track is loaded. The two are exclusive: a
   *  mixdown has no parts, so there is no tree, no assignment and no per-part gate. */
  let recordedTrack = false;
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
    const working =
      session.working || stale || settling(session) || isFolded(session, Date.now());
    return config.current().mode === 'reward' ? working : !working;
  };

  /** A block too young to trust yet. See BLOCK_SETTLE_MS: the prompt may already have been
   *  answered for the user, in which case silencing now only chops the music. */
  const settling = (session: Session): boolean =>
    session.blockedMidTurn &&
    session.blockedSince !== null &&
    Date.now() - session.blockedSince < BLOCK_SETTLE_MS;

  /** A sub-agent fires hooks but is never listed by the CLI, which is the only thing that
   *  tells it from a session the user is sitting in front of. Without the open-sessions
   *  file nothing is ever listed, so the distinction cannot be drawn at all. New sessions
   *  are spared until the file has had time to list them. */
  const isSubAgent = (session: Session, now: number): boolean =>
    WATCH_OPEN_SESSIONS &&
    session.source === 'hook' &&
    !session.listedByCli &&
    now - session.startedAt >= SUBAGENT_GRACE_MS;

  /** Whether this session is one that sub-agent mode keeps out of the music entirely. */
  const isHiddenSubAgent = (session: Session, now: number): boolean =>
    config.current().subagents !== 'voice' && isSubAgent(session, now);

  /** Work a sub-agent is doing that this session is waiting on. A parent that dispatches
   *  and then waits fires `agentStop`, so without this its voice falls silent while the
   *  work it is waiting on runs — silence that says "you are needed" when nobody is.
   *  A session blocked mid-turn is never folded: a permission prompt is a positive request
   *  for the user's attention and outranks work merely inferred from a cwd match. Two
   *  terminals on one repo cannot be told apart, so the work counts for both. */
  const isFolded = (session: Session, now: number): boolean => {
    if (config.current().subagents !== 'fold') return false;
    if (session.blockedMidTurn || !session.listedByCli || session.cwd === null) return false;
    return registry
      .list()
      .some(
        (other) =>
          other.working &&
          other.cwd === session.cwd &&
          // Folding is inferred from a shared cwd, never read off a hook, so it expires.
          // A sub-agent killed mid-tool is never retired — it is by construction absent
          // from the CLI's file — and would otherwise hold its parent audible for ever.
          now - other.updatedAt < FOLD_EVIDENCE_MAX_MS &&
          isSubAgent(other, now),
      );
  };

  /** A terminal that was closed is never removed from the CLI's session file, so without
   *  this it keeps its instrument forever. A working session normally keeps its voice
   *  however long it has been at it, but only up to a ceiling: a terminal killed mid-tool
   *  leaves `working` standing with nothing that can ever correct it, because the file
   *  may silence and never assert. */
  const isExpired = (session: Session, now: number): boolean => {
    if (isFolded(session, now)) return false;
    if (session.working) return now - session.updatedAt >= WORKING_CLAIM_MAX_MS;
    const minutes = config.current().idleDropoutMinutes;
    if (minutes <= 0) return false;
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
          !isHiddenSubAgent(session, now) &&
          !isMuted(muteRules, session) &&
          !isExpired(session, now),
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

  /** How long until the next moment a block changes what should sound, or null when none
   *  is pending. Two deadlines: a block inside its settle window has to be revisited or a
   *  prompt the user really is waiting on would never silence anything, and under
   *  `resume` the 8-second mark is where the music comes back — a moment the CLI emits
   *  nothing to announce, so nothing but this timer can find it. */
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

  /** Where the gate lands when nothing can be subdivided. Ducking wins over a recorded
   *  track because in that mode the daemon plays nothing of its own for a track to be. */
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
      // Every session gates the same thing, and `mixAudible` already says it: under
      // `per-agent` it is "any session that should sound", which is the override a stream
      // with no parts needs, and under the other policies it is the configured gate.
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

    // `mute` keeps our own transport running through the silence, trading the
    // resume-in-place effect for not stopping the piece.
    const soonest = soonestRecheck(sessions);

    if (mixer.anyAudible() || config.current().silenceMode === 'mute') {
      scheduler.play();
      // Pausing the moment the gate shuts would cut the notes the fade still needs, so the
      // transport runs on and the decision is retaken once the ramp has reached zero.
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
    /** Takes the gate away from the score entirely. Tree, labels and per-part mix are
     *  dropped rather than left behind: a stale ensemble would otherwise keep answering
     *  for music that has no parts to answer with. */
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
      // Muted sessions are listed even though they hold no voice: hiding one would leave
      // no way to find it again and unmute it.
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
