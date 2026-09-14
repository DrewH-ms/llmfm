export const DAEMON_PORT = Number(process.env.AGENT_ORCHESTRA_PORT) || 7777;
export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_URL = process.env.AGENT_ORCHESTRA_URL ?? `http://${DAEMON_HOST}:${DAEMON_PORT}`;

/** Events the hook config subscribes to. The name is passed explicitly as argv[2]
 *  because several payloads carry no event-name field. */
export const HOOK_EVENTS = [
  'sessionStart',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'agentStop',
  'sessionEnd',
  'notification',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Observed on real payloads; these are what make mid-turn stops detectable. */
export const AWAITING_INPUT_NOTIFICATIONS = ['permission_prompt', 'elicitation_dialog'] as const;

export const MIDI_CHANNEL_COUNT = 16;
export const PERCUSSION_CHANNEL = 9;
export const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15] as const;

export const CC_CHANNEL_VOLUME = 7;
export const CC_ALL_SOUND_OFF = 120;
export const CC_ALL_NOTES_OFF = 123;

export const MIDI_NOTE_OFF = 0x80;
export const MIDI_NOTE_ON = 0x90;
export const MIDI_CONTROL_CHANGE = 0xb0;
export const MIDI_PROGRAM_CHANGE = 0xc0;

export const MAX_MIDI_VALUE = 127;

/** Seconds of notes the scheduler commits to ahead of the playhead. */
export const LOOKAHEAD_SECONDS = 0.2;
export const SCHEDULER_TICK_MS = 25;
export const FADE_STEP_HZ = 30;
export const DEFAULT_FADE_SECONDS = 1;
/** Resuming uses a shorter fade so a reply feels immediate. */
export const RESUME_FADE_SECONDS = 0.4;
export const MIN_NOTE_DURATION_SECONDS = 0.05;

export const GATE_MODES = ['reward', 'alert'] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const OPEN_SESSIONS_POLL_MS = 250;
/** A file reading may not override a hook reading newer than this. */
export const HOOK_AUTHORITY_MS = 5000;

/** Pins audio to one session. Scope is otherwise machine-wide, which is correct in use
 *  but makes single-session behaviour impossible to demonstrate or test in isolation. */
export const FOCUS_SESSION_ID = process.env.AGENT_ORCHESTRA_SESSION ?? null;
/** The open-sessions file is corroboration; turning it off isolates hook behaviour. */
export const WATCH_OPEN_SESSIONS = process.env.AGENT_ORCHESTRA_WATCH_FILE !== '0';

export const HOOK_REQUEST_TIMEOUT_MS = 200;

/** Logs event names and short session ids only — never payload contents, which carry
 *  prompt text. Opt-in, for confirming which events the CLI actually fires. */
export const LOG_EVENTS = process.env.AGENT_ORCHESTRA_LOG === '1';

export const SIMULATION_STEP_MS = 4000;
export const SIMULATION_LABELS = ['api-service', 'web-client', 'infra', 'docs'] as const;
