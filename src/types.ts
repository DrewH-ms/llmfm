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
};

export type SessionView = Session & {
  /** Null when the session is unvoiced. */
  voiceName: string | null;
  audible: boolean;
};
