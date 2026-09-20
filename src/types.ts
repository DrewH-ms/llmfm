import type { HookEventName } from './constants.ts';

/** `name` comes from the hook config argument, not the payload body, which is not shape-stable. */
export type HookEvent = {
  name: HookEventName;
  sessionId: string;
  cwd: string | null;
  /** Present only on `notification`; drives mid-turn stop detection. */
  notificationType: string | null;
};

export type OpenSessionEntry = {
  sessionId: string;
  working: boolean;
  /** The CLI never deletes an entry, so this is all that separates a live session from a terminal closed days ago. */
  refreshedAt: number | null;
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
  /** Set by a `notification` hook; the open-sessions file only flips at turn boundaries, so it must not clear this. */
  blockedMidTurn: boolean;
  /** Not `updatedAt`, which a repeat `notification` refreshes — age from that would reset while the block stood. */
  blockedSince: number | null;
  /** Sub-agents fire hooks but are never listed, which is the only way to tell them from a real session. */
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
  /** What the file itself specified, kept so a remap is inspectable and reversible. */
  scoredProgram: number;
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
  /** The volume bridge duck mode rides. Published whatever the mode, so a bridge that never came up is visible. */
  duck: import('./system-volume.ts').SystemVolumeStatus;
  /** Derived, not configured: true only while a connected phone's stream is what we gate. */
  ducking: boolean;
  /** Published whatever the setting, so an A2DP sink that never came up is visible rather than silently absent. */
  bluetooth: import('./bluetooth-receive.ts').BluetoothStatus;
  sessions: SessionView[];
  config: import('./config.ts').LlmfmConfig;
  /** The dashboard builds its menu from this, so an older daemon offers only what it can take instead of 400ing. */
  settingSpecs: readonly import('./settings.ts').SettingSpec[];
  /** The daemon owns this path, so the dashboard opens the folder the daemon actually reads. */
  playlistsDir: string;
};

/** Deliberately not `Session & …`: `listedByCli` and `startedAt` are arbitration bookkeeping, meaningless to clients. */
export type SessionView = Pick<
  Session,
  'sessionId' | 'working' | 'cwd' | 'label' | 'source' | 'blockedMidTurn' | 'blockedSince' | 'updatedAt'
> & {
  /** What a user types to mute this session, e.g. "Rasa (cb75a9e8)". */
  handle: string;
  /** True when this session sounds on a sub-agent's work, so the row can explain a voice the CLI reports as stopped. */
  folded: boolean;
  /** True when a config rule currently mutes this session; it then holds no voice. */
  muted: boolean;
  /** Null when the session is unvoiced. */
  voiceName: string | null;
  /** A voice may be a whole section, and its name alone does not say which parts fall silent with it. */
  voiceParts: string[];
  audible: boolean;
};

/** The parts that gate together as one audible line; aggregating upward keeps a voice sounding, so its silence means an agent stopped. */
export type Voice = {
  voiceId: string;
  /** What the listener is told to listen for, e.g. 'Strings' or 'Violin I'. */
  name: string;
  partIds: string[];
  /** Root-to-node ids: a session hashes to a path, not a leaf, so it keeps its branch as the tree subdivides. */
  path: string[];
};

export type VoiceTree = {
  /** Voices for a given live-session count, subdividing only as far as that requires. Always at least one. */
  voicesFor(sessionCount: number): Voice[];
  /** Parts too sparse to carry a session: their rests would read as a blocked agent, so they only ever back. */
  backingPartIds: string[];
};

export type VoiceAssignment = {
  /** Voice per session id. A session past the tree's capacity is absent. */
  bySession: Map<string, Voice>;
  /** Tracked and shown to the user, but silent: no voice was left to give. */
  unvoicedSessionIds: string[];
};
