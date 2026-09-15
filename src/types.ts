import type { HookEventName } from './constants.ts';

/** A hook payload after narrowing at the intake boundary. `name` comes from the hook
 *  config argument rather than the payload body, which is not shape-stable. */
export type HookEvent = {
  name: HookEventName;
  sessionId: string;
  cwd: string | null;
  /** Present only on `notification`; drives mid-turn stop detection. */
  notificationType: string | null;
};

export const SESSION_SOURCES = ['hook', 'file', 'simulation'] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export type Session = {
  sessionId: string;
  working: boolean;
  cwd: string | null;
  /** Leaf folder name of `cwd`, shown to the listener. */
  label: string;
  source: SessionSource;
  /** Set when a `notification` hook reported a mid-turn block. The open-sessions file
   *  only flips at turn boundaries, so it cannot see this state and must not clear it. */
  blockedMidTurn: boolean;
  /** When the current mid-turn block began, or null when not blocked. Distinct from
   *  `updatedAt`, which any unrelated event refreshes — including a second `notification`
   *  for the same prompt. Age measured from `updatedAt` would reset while the block stood. */
  blockedSince: number | null;
  /** Whether the CLI has ever listed this session as an open one. Sub-agents fire hooks
   *  but are never listed, which is the only way to tell them from a session the user is
   *  actually sitting in front of. */
  listedByCli: boolean;
  /** When the session was first observed. Fixed for its lifetime, unlike `updatedAt`. */
  startedAt: number;
  updatedAt: number;
};

/** One playable line from the score, already bound to a MIDI channel. */
export type Part = {
  partId: string;
  name: string;
  program: number;
  channel: number;
  percussion: boolean;
  notes: ScoredNote[];
};

export type ScoredNote = {
  /** Seconds from the start of the piece. */
  time: number;
  duration: number;
  midi: number;
  velocity: number;
  channel: number;
  partId: string;
};

export type Score = {
  name: string;
  duration: number;
  parts: Part[];
  /** Every note across all parts, sorted by time. The scheduler's input. */
  notes: ScoredNote[];
};

export type TransportState = {
  playing: boolean;
  position: number;
  duration: number;
};

export type MidiStatus = {
  ready: boolean;
  device: string | null;
  error: string | null;
};

/** What the daemon publishes over SSE and the dashboard renders. */
export type DaemonState = {
  mode: import('./constants.ts').GateMode;
  fadeSeconds: number;
  simulating: boolean;
  track: string | null;
  transport: TransportState;
  midi: MidiStatus;
  sessions: SessionView[];
  config: import('./config.ts').LlmfmConfig;
};

/** What the daemon puts on the wire. Deliberately not `Session & …`: `listedByCli` and
 *  `startedAt` exist only to arbitrate between the two signals, and clients that render
 *  them would be reading internal bookkeeping as if it meant something to the listener. */
export type SessionView = Pick<
  Session,
  'sessionId' | 'working' | 'cwd' | 'label' | 'source' | 'blockedMidTurn' | 'blockedSince' | 'updatedAt'
> & {
  /** What a user types to mute this session, e.g. "Rasa (cb75a9e8)". */
  handle: string;
  /** True when a config rule currently mutes this session; it then holds no voice. */
  muted: boolean;
  /** Null when the session is unvoiced. */
  voiceName: string | null;
  /** The instruments that voice actually gates, e.g. Violin I, Violin II, Viola. A voice
   *  may be a whole section, and its section name alone does not say what falls silent
   *  with it — nor that every other part is backing, which follows the ensemble. */
  voiceParts: string[];
  audible: boolean;
};

/** A node in the voice tree: the parts that gate together as one audible line.
 *
 *  A voice may be a whole section, a single instrument, or one part, depending on how far
 *  the tree has subdivided. Aggregating upward is what keeps a voice legible: a section
 *  is still sounding while any of its instruments are, so its silence means an agent
 *  stopped rather than that the music happens to rest. */
export type Voice = {
  voiceId: string;
  /** What the listener is told to listen for, e.g. 'Strings' or 'Violin I'. */
  name: string;
  partIds: string[];
  /** Root-to-node voice ids. A session hashes to a path rather than a leaf, so it keeps
   *  its branch as the tree subdivides and only ever narrows within it. */
  path: string[];
};

export type VoiceTree = {
  /** The voices to offer for a given number of live sessions, subdividing only as far as
   *  that count requires. Returns at least one voice for any score that has a part. */
  voicesFor(sessionCount: number): Voice[];
  /** Parts too sparse to carry a session: their rests would read as a blocked agent.
   *  They never hold a voice, and sound whenever any voice does, so they colour the
   *  texture without making a claim about an agent. */
  backingPartIds: string[];
};

export type VoiceAssignment = {
  /** Voice per session id. A session past the tree's capacity is absent. */
  bySession: Map<string, Voice>;
  /** Tracked and shown to the user, but silent: no voice was left to give. */
  unvoicedSessionIds: string[];
};
