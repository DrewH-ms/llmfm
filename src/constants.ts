export const DAEMON_PORT = Number(process.env.LLMFM_PORT) || 7777;
export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_URL = process.env.LLMFM_URL ?? `http://${DAEMON_HOST}:${DAEMON_PORT}`;

/** Events the hook config subscribes to. The name is passed explicitly as argv[2]
 *  because several payloads carry no event-name field. */
export const HOOK_EVENTS = [
  'sessionStart',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
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
export const FOCUS_SESSION_ID = process.env.LLMFM_SESSION ?? null;
/** The open-sessions file is corroboration; turning it off isolates hook behaviour. */
export const WATCH_OPEN_SESSIONS = process.env.LLMFM_WATCH_FILE !== '0';

/** Sub-agents fire hooks but are never listed as open sessions, so a session the CLI does
 *  not list is one the user is not sitting in front of. Counting them dilutes the signal:
 *  a fleet of them keeps the orchestra playing while the session you are watching waits
 *  on you. Requires the open-sessions file, which is the only thing that can tell them
 *  apart. */
export const IGNORE_SUBAGENTS =
  WATCH_OPEN_SESSIONS && !['1', 'include'].includes(process.env.LLMFM_SUBAGENTS ?? '');
/** How long a hook session may go unlisted before it is taken for a sub-agent. The file
 *  lags a new session by a poll or two, and a real session must never be misread. */
export const SUBAGENT_GRACE_MS = 6000;

export const HOOK_REQUEST_TIMEOUT_MS = 200;

/** Where mute rules live. Beside the hook config rather than in the repo, because muting
 *  is a property of this machine's sessions, not of the project. */
export const CONFIG_FILE_NAME = 'llmfm.config.json';
/** Polled, not watched: the file is edited by hand and by the dashboard, and an atomic
 *  rename blinds fs.watch the same way it does for the open-sessions file. */
export const CONFIG_POLL_MS = 1000;
/** Enough of a session id to be unambiguous in practice while staying typeable. */
export const HANDLE_ID_LENGTH = 8;

/** What to do between approving a permission prompt and the tool finishing. The CLI fires
 *  nothing when a prompt is answered, so this gap is genuinely unobservable:
 *  - `silent` keeps the part muted, never playing while you are truly needed, at the cost
 *    of a false alarm for the length of the command.
 *  - `resume` trades that away: long commands sound right, but stepping away mid-prompt
 *    means the music returns and the alert is lost. */
export const PROMPT_GAP_MODES = ['silent', 'resume'] as const;
export type PromptGapMode = (typeof PROMPT_GAP_MODES)[number];
export const DEFAULT_PROMPT_GAP: PromptGapMode = 'silent';
/** How long `resume` waits before assuming a prompt was answered. */
export const PROMPT_GAP_RESUME_MS = 8000;

/** Logs event names and short session ids only — never payload contents, which carry
 *  prompt text. Opt-in, for confirming which events the CLI actually fires. */
export const LOG_EVENTS = process.env.LLMFM_LOG === '1';

export const SIMULATION_STEP_MS = 4000;
export const SIMULATION_LABELS = ['api-service', 'web-client', 'infra', 'docs'] as const;

/** The coarsest grouping a listener can still name by ear, and so the top level of the
 *  voice tree. */
export const SECTIONS = [
  'Strings',
  'Woodwinds',
  'Brass',
  'Percussion',
  'Keyboard',
  'Voices',
  'Other',
] as const;
export type SectionName = (typeof SECTIONS)[number];

/** Inclusive GM program ranges mapped onto sections, first match winning; anything
 *  unmatched is 'Other', and channel 9 is percussion whatever its program says.
 *
 *  These deliberately cut across the GM family boundaries. Timpani (47) sits at the end
 *  of the string range, the harp (46) beside it reads as keyboard, and the tuned
 *  percussion block (8-15) reads as percussion — grouping by what a listener hears
 *  matters more here than grouping by the spec. */
export const SECTION_PROGRAM_RANGES = [
  { section: 'Percussion', from: 8, to: 15 },
  { section: 'Percussion', from: 47, to: 47 },
  { section: 'Percussion', from: 112, to: 119 },
  { section: 'Keyboard', from: 0, to: 7 },
  { section: 'Keyboard', from: 16, to: 23 },
  { section: 'Keyboard', from: 46, to: 46 },
  { section: 'Strings', from: 40, to: 45 },
  { section: 'Strings', from: 48, to: 51 },
  { section: 'Voices', from: 52, to: 54 },
  { section: 'Brass', from: 56, to: 63 },
  { section: 'Woodwinds', from: 64, to: 79 },
] as const satisfies readonly { section: SectionName; from: number; to: number }[];

export const FALLBACK_SECTION: SectionName = 'Other';

/** Fraction of the piece a node must be sounding in to be offered as a voice. Below it
 *  the rests are long enough that a silent part reads as a blocked agent rather than as
 *  the music, which inverts the signal. */
export const MIN_VOICE_CONTINUITY = 0.6;
/** Resolution at which continuity is measured: roughly a bar at orchestral tempo. */
export const CONTINUITY_WINDOW_SECONDS = 4;
/** How long a changed session count must hold before the tree re-splits, so opening a
 *  terminal does not immediately rearrange the texture. */
export const VOICE_RESPLIT_DEBOUNCE_MS = 3000;
