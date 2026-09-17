export const DAEMON_PORT = Number(process.env.LLMFM_PORT) || 7777;
export const DAEMON_HOST = '127.0.0.1';
export const DAEMON_URL = process.env.LLMFM_URL ?? `http://${DAEMON_HOST}:${DAEMON_PORT}`;

/** The name is passed explicitly as argv[2] because several payloads carry no event-name field. */
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
export const DEFAULT_FADE_SECONDS = 3;
/** Floor is a real crossfade, not zero: an instant cut clicks, and every part changing at once clicks together. */
export const FADE_MIN_SECONDS = 0.25;
export const FADE_MAX_SECONDS = 10;
export const FADE_STEP_SECONDS = 0.25;
/** Shorter than a normal fade so a reply feels immediate. */
export const RESUME_FADE_SECONDS = 0.4;
/** Slack before a pause so the last ramp step has certainly been sent, not cut off by a racing timer. */
export const SETTLE_MARGIN_MS = 120;
/** `permission_prompt` also fires for pre-approved tools, which chopped the music into 1-2s dropouts; a block that matters lasts until a human acts. */
export const BLOCK_SETTLE_MS = 1500;
export const MIN_NOTE_DURATION_SECONDS = 0.05;

export const GATE_MODES = ['reward', 'alert'] as const;
export type GateMode = (typeof GATE_MODES)[number];

export const OPEN_SESSIONS_POLL_MS = 250;
/** A file reading may not override a hook reading newer than this. */
export const HOOK_AUTHORITY_MS = 5000;

/** Pins audio to one session, so single-session behaviour can be demonstrated in isolation. */
export const FOCUS_SESSION_ID = process.env.LLMFM_SESSION ?? null;
/** The open-sessions file is corroboration; turning it off isolates hook behaviour. */
export const WATCH_OPEN_SESSIONS = process.env.LLMFM_WATCH_FILE !== '0';

/** Sub-agents fire hooks but are never listed as open sessions: `ignore` silences a parent the moment it delegates, `voice` lets a fleet drown out the session that is waiting on you. */
export const SUBAGENT_MODES = ['ignore', 'fold', 'voice'] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];
export const DEFAULT_SUBAGENTS: SubagentMode = 'fold';
/** The sessions file lags a new session by a poll or two, and a real session must never be misread as a sub-agent. */
export const SUBAGENT_GRACE_MS = 6000;

export const HOOK_REQUEST_TIMEOUT_MS = 200;

/** Beside the hook config rather than in the repo: muting is a property of this machine's sessions, not the project. */
export const CONFIG_FILE_NAME = 'llmfm.config.json';
/** The dashboard may share the terminal, so stdout would land mid-frame. */
export const LOG_FILE_NAME = 'llmfm.log';
/** Polled, not watched: an atomic rename blinds fs.watch. */
export const CONFIG_POLL_MS = 1000;
/** Enough of a session id to be unambiguous in practice while staying typeable. */
export const HANDLE_ID_LENGTH = 8;

/** The CLI fires nothing when a prompt is answered, so this gap is unobservable: `silent` risks a false alarm for the length of the command, `resume` risks losing the alert. */
export const PROMPT_GAP_MODES = ['silent', 'resume'] as const;
export type PromptGapMode = (typeof PROMPT_GAP_MODES)[number];
export const DEFAULT_PROMPT_GAP: PromptGapMode = 'resume';

/** `per-agent` gates each session's own voice; the rest gate the whole mix, and `mode` inverts any of them. */
export const GATE_POLICIES = ['per-agent', 'any', 'all', 'always'] as const;
export type GatePolicy = (typeof GATE_POLICIES)[number];
export const DEFAULT_GATE_POLICY: GatePolicy = 'any';

/** `mute` costs the resume-mid-phrase effect but is the only option once another app owns the audio, since we cannot pause its stream. */
export const SILENCE_MODES = ['pause', 'mute'] as const;
export type SilenceMode = (typeof SILENCE_MODES)[number];
export const DEFAULT_SILENCE_MODE: SilenceMode = 'mute';

/** `midi` plays our own score, `duck` gates audio we do not own; exclusive, since a score over someone else's music says nothing. */
export const AUDIO_MODES = ['midi', 'duck'] as const;
export type AudioMode = (typeof AUDIO_MODES)[number];
export const DEFAULT_AUDIO: AudioMode = 'duck';

/** `None` is nothing connected, distinct from the `Closed` a connection reports once opened and lost. */
export const BLUETOOTH_STATES = ['None', 'Closed', 'Opened'] as const;
export type BluetoothState = (typeof BLUETOOTH_STATES)[number];
export const BLUETOOTH_NONE: BluetoothState = 'None';
export const BLUETOOTH_CLOSED: BluetoothState = 'Closed';
export const BLUETOOTH_OPENED: BluetoothState = 'Opened';

export const MASTER_VOLUME_MAX = 100;
export const DEFAULT_MASTER_VOLUME = 100;
export const MASTER_VOLUME_STEP = 5;
/** Synths read CC7 as 40·log10(v/127) dB, so a linear control falls away too fast; this exponent restores "half the number, half as loud" and leaves 100 unchanged. */
export const MASTER_VOLUME_CURVE_EXPONENT = 0.75;

/** Named rather than first-file-in-directory so a new track cannot silently replace it; Coriolan has 75 distinct velocities and twelve parts the lexicon can name. */
export const DEFAULT_TRACK = 'mutopia-beethoven-coriolan-overture.mid';

/** A track ending is the one silence the user knows is not about them, so it can be spent on variety. */
export const AUTOPLAY_MODES = ['off', 'sequential', 'random'] as const;
export type AutoplayMode = (typeof AUTOPLAY_MODES)[number];
export const DEFAULT_AUTOPLAY: AutoplayMode = 'random';

/** 0 disables it; the CLI never cleans up its sessions file, so a closed terminal would hold an instrument indefinitely. */
export const DEFAULT_IDLE_DROPOUT_MINUTES = 20;
export const IDLE_DROPOUT_MAX_MINUTES = 120;
export const IDLE_DROPOUT_STEP_MINUTES = 5;
export const MS_PER_MINUTE = 60_000;
/** How long `resume` waits before assuming a prompt was answered. */
export const PROMPT_GAP_RESUME_MS = 8000;

/** Generous on purpose: a terminal killed mid-tool leaves `working: true` uncorrectable for ever, but one long tool call is legitimate and silencing a live agent is the opposite lie. */
export const WORKING_CLAIM_MAX_MS = 30 * MS_PER_MINUTE;
/** Folding is an inference, so it expires; well above a long build, since silencing a parent whose sub-agent is mid-run is the inverse lie. */
export const FOLD_EVIDENCE_MAX_MS = 15 * MS_PER_MINUTE;
/** How often the daemon checks whether a bridge it believes is running has died. */
export const BRIDGE_HEALTH_TICK_MS = 1000;
/** Exiting late still restores audio; refusing to exit never does. */
export const SHUTDOWN_GRACE_MS = 5000;

/** Logs event names and short session ids only — never payload contents, which carry prompt text. */
export const LOG_EVENTS = process.env.LLMFM_LOG === '1';

export const SIMULATION_STEP_MS = 4000;
export const SIMULATION_LABELS = ['api-service', 'web-client', 'infra', 'docs'] as const;

/** The coarsest grouping a listener can still name by ear, and so the top level of the voice tree. */
export const SECTIONS = [
  'Strings',
  'Woodwinds',
  'Brass',
  'Percussion',
  'Keyboard',
  'Voices',
  'Guitar',
  'Bass',
  'Synth',
  'Other',
] as const;
export type SectionName = (typeof SECTIONS)[number];

/** Inclusive GM ranges, first match winning; they cut across GM families on purpose, grouping by what a listener hears (timpani as percussion, harp as keyboard) and splitting the synth block so an electronic score is not one 'Other' lump that loses to the drum kit. Effects (120-127) stay unmatched: noise cues are not a line anyone can follow. */
export const SECTION_PROGRAM_RANGES = [
  { section: 'Percussion', from: 8, to: 15 },
  { section: 'Percussion', from: 47, to: 47 },
  { section: 'Percussion', from: 112, to: 119 },
  { section: 'Keyboard', from: 0, to: 7 },
  { section: 'Keyboard', from: 16, to: 23 },
  { section: 'Keyboard', from: 46, to: 46 },
  { section: 'Guitar', from: 24, to: 31 },
  { section: 'Bass', from: 32, to: 39 },
  { section: 'Strings', from: 40, to: 45 },
  { section: 'Strings', from: 48, to: 51 },
  { section: 'Voices', from: 52, to: 54 },
  { section: 'Brass', from: 55, to: 63 },
  { section: 'Woodwinds', from: 64, to: 79 },
  { section: 'Synth', from: 80, to: 95 },
  { section: 'Synth', from: 96, to: 103 },
  { section: 'Guitar', from: 104, to: 111 },
] as const satisfies readonly { section: SectionName; from: number; to: number }[];

export const FALLBACK_SECTION: SectionName = 'Other';

/** Shared so the shipped folder and the user's drop-in folder cannot disagree about what is playable. */
export const MIDI_FILE_PATTERN = /\.midi?$/i;
/** Recorded audio is a finished mixdown: no parts to gate, only a whole to turn up or down. */
export const RECORDED_FILE_PATTERN = /\.(mp3|wav)$/i;
export const PLAYABLE_FILE_PATTERN = /\.(midi?|mp3|wav)$/i;

export function isRecordedTrack(file: string): boolean {
  return RECORDED_FILE_PATTERN.test(file);
}

/** Always offered, and the fallback whenever a chosen playlist turns out to be empty. */
export const PLAYLIST_BUNDLED = 'bundled';
/** Everything the daemon can see at once, bundled and user folders alike. */
export const PLAYLIST_ALL = 'all';
export const DEFAULT_PLAYLIST = PLAYLIST_ALL;
export const PLAYLIST_README = 'README.md';
/** Every playlist is a folder in here, `bundled` included. */
export const PLAYLISTS_DIR_NAME = 'playlists';
/** Scaffolded empty so the README has something to point at. */
export const PLAYLIST_EXAMPLE = 'playlist1';
/** Always a forward slash, so the id a client sends back is the same on every platform. */
export const PLAYLIST_SEPARATOR = '/';

/** Below this the rests are long enough that a silent part reads as a blocked agent, inverting the signal. */
export const MIN_VOICE_CONTINUITY = 0.6;
/** Resolution at which continuity is measured: roughly a bar at orchestral tempo. */
export const CONTINUITY_WINDOW_SECONDS = 4;
/** Long enough that opening a terminal does not immediately rearrange the texture. */
export const VOICE_RESPLIT_DEBOUNCE_MS = 3000;
