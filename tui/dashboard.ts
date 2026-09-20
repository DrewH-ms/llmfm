import { spawn } from 'node:child_process';
import {
  BLUETOOTH_CLOSED,
  BLUETOOTH_NONE,
  BLUETOOTH_OPENED,
  BLUETOOTH_STATES,
  DAEMON_URL,
  DEFAULT_PLAYLIST,
  PLAYLIST_ALL,
  PLAYLIST_BUNDLED,
} from '../src/constants.ts';
import {
  SETTING_DEFAULTS,
  SETTING_SPECS,
  coerceWithSpec,
  displayForMode,
  displayWithSpec,
  nextWithSpec,
  parseSettingSpecs,
} from '../src/settings.ts';
import type { SettingSpec } from '../src/settings.ts';
import { runShutdown } from '../src/shutdown.ts';
import { SESSION_SOURCES } from '../src/types.ts';
import type { DaemonState, MidiStatus, SessionView, TransportState } from '../src/types.ts';
import type { SystemVolumeStatus } from '../src/system-volume.ts';
import type { BluetoothDevice, BluetoothStatus } from '../src/bluetooth-receive.ts';
import type { LlmfmConfig } from '../src/config.ts';

const ESC = '\x1b[';
const ALTERNATE_SCREEN_ON = `${ESC}?1049h`;
const ALTERNATE_SCREEN_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const CURSOR_HOME = `${ESC}H`;
const ERASE_TO_LINE_END = `${ESC}K`;
const ERASE_BELOW = `${ESC}J`;
const STYLE_RESET = `${ESC}0m`;
const STYLE_NONE = '';
const STYLE_BOLD = `${ESC}1m`;
const STYLE_DIM = `${ESC}2m`;
const FG_GREEN = `${ESC}32m`;
const FG_RED = `${ESC}31m`;
const FG_YELLOW = `${ESC}33m`;
const FG_CYAN = `${ESC}36m`;
const FG_GREY = `${ESC}90m`;
const BADGE_SOUNDING = `${ESC}30;102m`;
const BADGE_SILENT = `${ESC}90;100m`;
const BADGE_MUTED = `${ESC}90;40m`;

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;
const MIN_COLUMNS = 32;
const MAX_COLUMNS = 120;
const VOICE_COLUMN_WIDTH = 16;
/** Wide enough for a handle's disambiguating id suffix, which truncation must not eat. */
const HANDLE_COLUMN_WIDTH = 22;
const TITLE_COLUMN_WIDTH = 20;
const VOLUME_BAR_WIDTH = 24;
const BADGE_TEXT_SOUNDING = ' SOUNDING ';
const BADGE_TEXT_SILENT = '  silent  ';
const BADGE_TEXT_MUTED = '  muted   ';
const TAG_BLOCKED = 'BLOCKED?';
/** Sounding on a sub-agent's work while the CLI reports this session stopped. */
const TAG_FOLDED = 'SUB-AGENT';
const CURSOR_SELECTED = '▸';
const CURSOR_UNSELECTED = ' ';
const CYCLE_LEFT = '‹ ';
const CYCLE_RIGHT = ' ›';
const ENTER_MARKER = '›';
const MARKER_SOUNDING = '█ ';
const MARKER_SILENT = '· ';
/** Blank, not a third glyph: a muted row answers a question we stopped asking. */
const MARKER_MUTED = '  ';
const UNVOICED_TEXT = '(unvoiced)';
const MORE_ABOVE = 'above';
const MORE_BELOW = 'below';
const PROGRESS_FILLED = '█';
const PROGRESS_EMPTY = '░';
const PROGRESS_MIN_WIDTH = 8;
const CLOCK_COLUMN_WIDTH = 16;
const ELLIPSIS = '…';
const SECONDS_PER_MINUTE = 60;
const SECOND_DIGITS = 2;
/** Header, blank, heading, overflow marker, blank, help, footer. */
const CHROME_LINE_COUNT = 10;

const MS_PER_SECOND = 1000;
const RENDER_INTERVAL_MS = 200;
const RECONNECT_DELAY_MS = 1000;
const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 2000;

const KEY_QUIT = 'q';
const KEY_INTERRUPT = '\u0003';
const KEY_CYCLE_MODE = 'g';
const KEY_TOGGLE_SIMULATION = 'S';
const KEY_TOGGLE_MUTE = 'm';
const KEYS_FADE_UP = ['+', '='] as const;
const KEYS_FADE_DOWN = ['-', '_'] as const;
/** Both the cursor-key and application-keypad forms: a raw TTY emits either. */
const KEYS_SELECT_PREVIOUS = ['\u001b[A', '\u001bOA', 'w', 'k'] as const;
const KEYS_SELECT_NEXT = ['\u001b[B', '\u001bOB', 's', 'j'] as const;
const KEYS_LEFT = ['\u001b[D', '\u001bOD', 'a', 'h'] as const;
const KEYS_RIGHT = ['\u001b[C', '\u001bOC', 'd', 'l'] as const;
const KEYS_ACTIVATE = ['\r', '\n', ' '] as const;
/** Escape arrives alone; an arrow key arrives as the whole sequence in one chunk. */
const KEYS_BACK = ['\u001b', '\u007f', '\b'] as const;
const HINTS_ROOT = '[↑↓ ws] move   [←→ ad] open or adjust   [-/+] fade   [q] quit';
const HINTS_SETTINGS = '[↑↓ ws] move   [←→ ad] change   [esc] back   [q] quit';
const HINTS_SESSIONS = '[↑↓ ws] move   [enter/m] mute   [← a esc] back   [q] quit';
const HINTS_MUSIC = '[↑↓ ws] move   [enter/→ d] play or run   [← a esc] back   [q] quit';

const ACTION_SKIP = 'skip';
const ACTION_FOLDER = 'folder';
const ACTION_BLUETOOTH = 'bluetooth';
const ACTION_IDS = [ACTION_SKIP, ACTION_FOLDER, ACTION_BLUETOOTH] as const;
type ActionId = (typeof ACTION_IDS)[number];

const ACTION_TITLES: Readonly<Record<ActionId, string>> = {
  [ACTION_SKIP]: 'Skip to next track',
  [ACTION_FOLDER]: 'Add your own music',
  [ACTION_BLUETOOTH]: 'Connect Bluetooth',
};
const ACTION_HELP: Readonly<Record<ActionId, string>> = {
  [ACTION_SKIP]: 'Play the next track now, whatever this track does when it ends.',
  [ACTION_FOLDER]: 'Opens the folder the daemon reads. Drop .mid files in and they appear here.',
  [ACTION_BLUETOOTH]:
    'Lists the phones already paired with this PC, so one of them can play into it.',
};
/** Radio enumeration and link opening wait on the phone, so not the state-read timeout. */
const BLUETOOTH_LIST_TIMEOUT_MS = 60000;
const BLUETOOTH_CONNECT_TIMEOUT_MS = 40000;
const BLUETOOTH_SEARCHING = 'looking for paired devices — this takes a moment';
const BLUETOOTH_CONNECTING = 'connecting to';
const BLUETOOTH_CONNECT_FAILED =
  'could not connect — on the phone, connect to this PC, then try again';
const BLUETOOTH_NONE_PAIRED =
  'no paired phone found — pair it first in Settings › Bluetooth & devices';
/** Enabling also forces duck mode — the only mode that gates the phone. */
const BLUETOOTH_ENABLING = 'turning Bluetooth audio on and starting the receiver — this takes a moment';
/** Windows cannot make the phone send audio; only the phone can choose the sink. */
const BLUETOOTH_PHONE_STEP = 'On your phone: pick this PC as the output and press play.';
const BLUETOOTH_STARTING = 'Bluetooth: starting the receiver…';
const BLUETOOTH_CHOOSE = 'Bluetooth: no phone connected — Music › Connect Bluetooth.';
/** A refused link reports an unusable HRESULT; pairing alone does not connect the PC. */
const BLUETOOTH_NOT_LINKED = 'Bluetooth: connect this PC from the phone, then try again — ';
const BLUETOOTH_DROPPED = 'dropped the link — connect it again.';
const BLUETOOTH_NOT_LINKED_SHORT = 'not linked';
const BLUETOOTH_LABEL = 'BT  ';
const BLUETOOTH_CONNECTED_MARK = '●';
const FOLDER_OPEN_FAILED = 'could not open the folder:';
const SKIP_UNAVAILABLE = 'nothing to skip to — the library has one track';
const TRACK_HEADING = 'Library';
const NOW_PLAYING_MARK = '▶';
const PLAYLIST_ACTIVE_MARK = '●';
const PLAYLIST_EMPTY_NOTE = 'empty — bundled music plays';
const PLAYLIST_HELP_ACTIVE = 'Playing from here. The library below is what this playlist holds.';
const PLAYLIST_HELP_CHOOSE = 'Play from this playlist only.';
const PLAYLIST_HELP_EMPTY =
  'No files in this folder yet, so the bundled music keeps playing until you add some.';
const TRACK_UNPLAYABLE = 'hold music only';
const TRACK_INTEGRITY_BAD = 'file changed since it was curated';
/** `explorer` on Windows, which is the only platform the MIDI bridge supports anyway. */
const FOLDER_OPEN_COMMAND = 'explorer.exe';
const COMMAND_FAILURE_NOTICE = 'daemon rejected command:';
const UNSUPPORTED_SETTING_NOTICE = 'this daemon has no setting named';
const EXIT_FAILURE = 1;

const LINK_LIVE = 'live';
const LINK_POLLING = 'polling';
const LINK_DOWN = 'daemon down — retrying';

const LINK_STATES = [LINK_LIVE, LINK_POLLING, LINK_DOWN] as const;
type LinkState = (typeof LINK_STATES)[number];

const SECTION_MUSIC = 'music';
const SECTION_SETTINGS = 'settings';
const SECTION_SESSIONS = 'sessions';
const SECTION_IDS = [SECTION_MUSIC, SECTION_SETTINGS, SECTION_SESSIONS] as const;
type SectionId = (typeof SECTION_IDS)[number];

const ROOT_HEADING = 'MENU';
const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  [SECTION_MUSIC]: 'Music',
  [SECTION_SETTINGS]: 'Settings',
  [SECTION_SESSIONS]: 'Sessions',
};
const SECTION_HELP: Readonly<Record<SectionId, string>> = {
  [SECTION_MUSIC]: 'What plays, and where your own files go.',
  [SECTION_SETTINGS]: 'How the music answers to your agents.',
  [SECTION_SESSIONS]: 'Which sessions hold a voice, and which are muted out of the music.',
};

const MASTER_VOLUME_KEY = 'masterVolume';
/** Duck mode only presses the endpoint's mute flag; moving the user's level is unrestorable. */
const MASTER_VOLUME_INERT = 'n/a while ducking';
const MASTER_VOLUME_INERT_NOTICE =
  'master volume does not apply while ducking — use the volume on the device that is playing';
const MODE_KEY = 'mode';
const FADE_KEY = 'fadeSeconds';
/** Split out of the settings page: it lives on the root menu as a live slider. */
function masterVolumeSpec(state: DaemonState): SettingSpec | null {
  return state.settingSpecs.find((spec) => spec.key === MASTER_VOLUME_KEY) ?? null;
}

function listedSpecs(state: DaemonState): readonly SettingSpec[] {
  return state.settingSpecs.filter((spec) => spec.key !== MASTER_VOLUME_KEY);
}

const SESSION_HELP_MUTED = 'Muted: holds no voice, and never holds the music on.';
const SESSION_HELP_UNVOICED = 'No voice left to give, so this session sounds nothing.';
const SESSION_GATES = ' gates ';
const BACKING_NOTE = ' — the rest is backing';
const EMPTY_SESSIONS_TEXT = 'no sessions';

type Segment = { text: string; style: string };

type Snapshot = { state: DaemonState; receivedAt: number };

/** `key` is stable across frames; a session's array position and presence are not. */
type Row =
  | { kind: 'section'; key: string; id: SectionId }
  | { kind: 'setting'; key: string; spec: SettingSpec }
  | { kind: 'action'; key: string; id: ActionId }
  | { kind: 'bluetooth'; key: string; device: BluetoothDevice }
  | { kind: 'playlist'; key: string; playlist: PlaylistView }
  | { kind: 'track'; key: string; track: TrackView }
  | { kind: 'session'; key: string; session: SessionView };

/** Narrower than the daemon's catalogue: provenance would not fit beside the title at 80 columns. */
type TrackView = {
  file: string;
  title: string;
  composer: string | null;
  holdMusicOnly: boolean;
  integrity: string;
  playlist: string;
};

type PlaylistView = {
  name: string;
  editable: boolean;
  count: number;
};

type View = {
  snapshot: Snapshot | null;
  link: LinkState;
  section: SectionId | null;
  selectedKey: string | null;
  notice: string | null;
  library: readonly TrackView[];
  playlists: readonly PlaylistView[];
  bluetoothDevices: readonly BluetoothDevice[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseTransport(value: unknown): TransportState | null {
  if (!isRecord(value)) return null;
  const { playing, position, duration } = value;
  if (typeof playing !== 'boolean') return null;
  if (typeof position !== 'number' || typeof duration !== 'number') return null;
  return { playing, position, duration };
}

function parseMidi(value: unknown): MidiStatus | null {
  if (!isRecord(value)) return null;
  const { ready, device, error } = value;
  if (typeof ready !== 'boolean') return null;
  if (device !== null && typeof device !== 'string') return null;
  if (error !== null && typeof error !== 'string') return null;
  return { ready, device, error };
}

/** An unreadable field reads as "no endpoint" rather than rejecting the whole snapshot. */
function parseDuck(value: unknown): SystemVolumeStatus {
  const absent: SystemVolumeStatus = {
    ready: false,
    deviceId: null,
    gated: false,
    gatedSessions: 0,
    error: null,
  };
  if (!isRecord(value)) return absent;
  const { ready, deviceId, gated, gatedSessions, error } = value;
  return {
    ready: ready === true,
    deviceId: typeof deviceId === 'string' ? deviceId : null,
    gated: gated === true,
    gatedSessions: typeof gatedSessions === 'number' && gatedSessions >= 0 ? gatedSessions : 0,
    error: typeof error === 'string' ? error : null,
  };
}

/** An unreadable field costs its own fact, not the snapshot. */
function parseBluetooth(value: unknown): BluetoothStatus {
  const absent: BluetoothStatus = { ready: false, state: BLUETOOTH_NONE, device: null, error: null };
  if (!isRecord(value)) return absent;
  const device = isRecord(value['device']) ? value['device'] : null;
  const id = device?.['id'];
  const name = device?.['name'];
  return {
    ready: value['ready'] === true,
    state: BLUETOOTH_STATES.find((candidate) => candidate === value['state']) ?? BLUETOOTH_NONE,
    device: typeof id === 'string' ? { id, name: typeof name === 'string' ? name : id } : null,
    error: typeof value['error'] === 'string' ? value['error'] : null,
  };
}

function parseSession(value: unknown): SessionView | null {  if (!isRecord(value)) return null;
  const { sessionId, working, cwd, label, blockedMidTurn, updatedAt, voiceName, audible } = value;
  const { handle, muted, blockedSince } = value;
  const source = SESSION_SOURCES.find((candidate) => candidate === value['source']);
  if (typeof sessionId !== 'string' || typeof label !== 'string' || !source) return null;
  if (typeof working !== 'boolean' || typeof blockedMidTurn !== 'boolean') return null;
  if (typeof audible !== 'boolean' || typeof updatedAt !== 'number') return null;
  if (typeof handle !== 'string' || typeof muted !== 'boolean') return null;
  if (blockedSince !== null && typeof blockedSince !== 'number') return null;
  if (cwd !== null && typeof cwd !== 'string') return null;
  if (voiceName !== null && typeof voiceName !== 'string') return null;
  // Absent rather than rejected: an older daemon that omits it still tells the truth about the row.
  const voiceParts = Array.isArray(value['voiceParts'])
    ? value['voiceParts'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    sessionId,
    working,
    cwd,
    label,
    source,
    blockedSince,
    blockedMidTurn,
    updatedAt,
    voiceName,
    voiceParts,
    audible,
    handle,
    muted,
    // Absent rather than rejected, as with the part list.
    folded: value['folded'] === true,
  };
}

/** Never fails; values go through the same specs the daemon validates writes with, so the two cannot disagree. */
function parseConfig(value: unknown, specs: readonly SettingSpec[]): LlmfmConfig {
  const record = isRecord(value) ? value : {};
  const settings: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const spec of specs) {
    const coerced = coerceWithSpec(spec, record[spec.key]);
    if (coerced !== null) settings[spec.key] = coerced;
  }
  const muted = Array.isArray(record['muted'])
    ? record['muted'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const chosen = record['playlist'];
  const playlist = typeof chosen === 'string' && chosen.length > 0 ? chosen : DEFAULT_PLAYLIST;
  return { ...(settings as Omit<LlmfmConfig, 'muted' | 'playlist'>), muted, playlist };
}

/** Narrows a daemon payload, which arrives as text over SSE and so is untrusted here. */
function parseDaemonState(text: string): DaemonState | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const { simulating, track } = payload;
  const transport = parseTransport(payload['transport']);
  const midi = parseMidi(payload['midi']);
  if (!transport || !midi) return null;
  if (typeof simulating !== 'boolean') return null;
  if (track !== null && typeof track !== 'string') return null;
  if (!Array.isArray(payload['sessions'])) return null;
  const sessions: SessionView[] = [];
  for (const entry of payload['sessions']) {
    const session = parseSession(entry);
    if (!session) return null;
    sessions.push(session);
  }
  // A daemon too old to publish its specs still has to be driveable, so the compiled list stands in.
  const published = parseSettingSpecs(payload['settingSpecs']);
  const settingSpecs = published.length > 0 ? published : SETTING_SPECS;
  const config = parseConfig(payload['config'], settingSpecs);
  // `mode` and `fadeSeconds` are settings now; the top-level copies are the daemon's echo.
  return {
    mode: config.mode,
    fadeSeconds: config.fadeSeconds,
    simulating,
    track,
    transport,
    midi,
    duck: parseDuck(payload['duck']),
    ducking: payload['ducking'] === true,
    bluetooth: parseBluetooth(payload['bluetooth']),
    sessions,
    config,
    settingSpecs,
    playlistsDir: typeof payload['playlistsDir'] === 'string' ? payload['playlistsDir'] : '',
  };
}

/** A malformed entry costs its own row, not the whole library. */
function parseTracks(text: string): TrackView[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(payload) || !Array.isArray(payload['tracks'])) return [];
  const tracks: TrackView[] = [];
  for (const entry of payload['tracks']) {
    if (!isRecord(entry)) continue;
    const { file, title, composer, holdMusicOnly, integrity, playlist } = entry;
    if (typeof file !== 'string' || file.length === 0) continue;
    tracks.push({
      file,
      // Inside a playlist the folder is already the row above, so a full path reads as noise.
      title: typeof title === 'string' && title.length > 0 ? title : bareName(file),
      composer: typeof composer === 'string' ? composer : null,
      holdMusicOnly: holdMusicOnly === true,
      integrity: typeof integrity === 'string' ? integrity : 'unrecorded',
      playlist: typeof playlist === 'string' && playlist.length > 0 ? playlist : PLAYLIST_ALL,
    });
  }
  return tracks;
}

/** A malformed entry is dropped: a missing playlist is a smaller loss than a dead dashboard. */
function parsePlaylists(text: string): PlaylistView[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(payload) || !Array.isArray(payload['playlists'])) return [];
  const playlists: PlaylistView[] = [];
  for (const entry of payload['playlists']) {
    if (!isRecord(entry)) continue;
    const { name, editable, count } = entry;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    playlists.push({ name, editable: editable === true, count: Math.max(Math.trunc(count), 0) });
  }
  return playlists;
}

/** A malformed entry is dropped, as in the catalogue. */
function parseBluetoothDevices(text: string): BluetoothDevice[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(payload) || !Array.isArray(payload['devices'])) return [];
  const devices: BluetoothDevice[] = [];
  for (const entry of payload['devices']) {
    if (!isRecord(entry)) continue;
    const { id, name } = entry;
    if (typeof id !== 'string' || id.length === 0) continue;
    devices.push({ id, name: typeof name === 'string' && name.length > 0 ? name : id });
  }
  return devices;
}

function activePlaylist(state: DaemonState): string {
  return state.config.playlist;
}

function bareName(file: string): string {
  const cut = file.lastIndexOf('/');
  return cut >= 0 ? file.slice(cut + 1) : file;
}

/** Mirrors the daemon's fallback: an empty playlist plays the bundled music, never silence. */
function visibleTracks(library: readonly TrackView[], playlist: string): readonly TrackView[] {
  if (playlist === PLAYLIST_ALL) return library;
  const chosen = library.filter((track) => track.playlist === playlist);
  if (chosen.length > 0) return chosen;
  return library.filter((track) => track.playlist === PLAYLIST_BUNDLED);
}

function settingValue(config: LlmfmConfig, key: string): unknown {
  return (config as unknown as Record<string, unknown>)[key];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function formatClock(seconds: number): string {
  const whole = Math.max(Math.floor(seconds), 0);
  const minutes = Math.floor(whole / SECONDS_PER_MINUTE);
  const rest = whole % SECONDS_PER_MINUTE;
  return `${minutes}:${String(rest).padStart(SECOND_DIGITS, '0')}`;
}

function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(width - 1, 0))}${ELLIPSIS}`;
}

function fit(text: string, width: number): string {
  return clip(text, width).padEnd(width);
}

/** Styles only after measuring plain text, so colour codes never count against the width. */
function composeLine(segments: Segment[], width: number): string {
  let used = 0;
  let line = '';
  for (const segment of segments) {
    if (used >= width) break;
    const text = clip(segment.text, width - used);
    line += segment.style === STYLE_NONE ? text : `${segment.style}${text}${STYLE_RESET}`;
    used += text.length;
  }
  return line;
}

function bar(fraction: number, width: number): string {
  const span = Math.max(width, PROGRESS_MIN_WIDTH);
  const filled = Math.round(span * clamp(fraction, 0, 1));
  return `${PROGRESS_FILLED.repeat(filled)}${PROGRESS_EMPTY.repeat(span - filled)}`;
}

/** The claim is sticky — an approved prompt emits no event — so age is the only hint it is stale. */
function blockedTag(blockedSince: number | null): string {
  if (blockedSince === null) return ` ${TAG_BLOCKED}`;
  const seconds = Math.max(Math.floor((Date.now() - blockedSince) / MS_PER_SECOND), 0);
  const age =
    seconds < SECONDS_PER_MINUTE ? `${seconds}s` : `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  return ` ${TAG_BLOCKED} ${age}`;
}

function cursorSegment(selected: boolean): Segment {
  return {
    text: selected ? CURSOR_SELECTED : CURSOR_UNSELECTED,
    style: selected ? FG_CYAN : STYLE_NONE,
  };
}

/** Tag-first: `BLOCKED?` says what the audio cannot, so the voice name yields width to it. */
function sessionLine(options: {
  session: SessionView;
  selected: boolean;
  width: number;
}): Segment[] {
  const { session, selected, width } = options;
  const tags: Segment[] = [];
  if (session.blockedMidTurn && !session.muted) {
    tags.push({ text: blockedTag(session.blockedSince), style: FG_YELLOW });
  }
  if (session.folded && !session.muted) tags.push({ text: TAG_FOLDED, style: FG_CYAN });

  const badge = session.muted
    ? BADGE_TEXT_MUTED
    : session.audible
      ? BADGE_TEXT_SOUNDING
      : BADGE_TEXT_SILENT;
  const marker = session.muted ? MARKER_MUTED : session.audible ? MARKER_SOUNDING : MARKER_SILENT;
  const tagWidth = tags.reduce((total, tag) => total + tag.text.length, 0);
  const fixed = CURSOR_SELECTED.length + marker.length + HANDLE_COLUMN_WIDTH + 1 + badge.length;
  const voiceWidth = clamp(width - fixed - tagWidth - 1, 0, VOICE_COLUMN_WIDTH);

  const segments: Segment[] = [
    cursorSegment(selected),
    { text: marker, style: session.audible ? FG_GREEN : FG_GREY },
    {
      text: fit(session.handle, HANDLE_COLUMN_WIDTH),
      style: session.muted ? STYLE_DIM : session.audible || selected ? STYLE_BOLD : STYLE_DIM,
    },
    { text: ' ', style: STYLE_NONE },
  ];
  if (voiceWidth > 0) {
    segments.push({
      text: fit(session.voiceName ?? UNVOICED_TEXT, voiceWidth),
      style: session.voiceName && !session.muted ? FG_CYAN : STYLE_DIM,
    });
    segments.push({ text: ' ', style: STYLE_NONE });
  }
  segments.push({
    text: badge,
    style: session.muted ? BADGE_MUTED : session.audible ? BADGE_SOUNDING : BADGE_SILENT,
  });
  return segments.concat(tags);
}

function settingLine(options: {
  spec: SettingSpec;
  config: LlmfmConfig;
  selected: boolean;
  width: number;
}): Segment[] {
  const { spec, config, selected, width } = options;
  const value = displayForMode(spec, settingValue(config, spec.key), config.mode);
  return [
    cursorSegment(selected),
    { text: ' ', style: STYLE_NONE },
    { text: fit(spec.title, TITLE_COLUMN_WIDTH), style: selected ? STYLE_BOLD : STYLE_NONE },
    { text: ' ', style: STYLE_NONE },
    { text: selected ? CYCLE_LEFT : '  ', style: FG_GREY },
    { text: clip(value, Math.max(width - TITLE_COLUMN_WIDTH - 8, 0)), style: FG_CYAN },
    { text: selected ? CYCLE_RIGHT : '', style: FG_GREY },
  ];
}

function masterVolumeLine(options: {
  spec: SettingSpec;
  config: LlmfmConfig;
  ducking: boolean;
  selected: boolean;
}): Segment[] {
  const { spec, config, ducking, selected } = options;
  const raw = settingValue(config, spec.key);
  const max = spec.kind === 'number' ? spec.max : 1;
  const level = typeof raw === 'number' ? raw : max;
  const inert = ducking;
  return [
    cursorSegment(selected),
    { text: ' ', style: STYLE_NONE },
    {
      text: fit(spec.title, TITLE_COLUMN_WIDTH),
      style: inert ? STYLE_DIM : selected ? STYLE_BOLD : STYLE_NONE,
    },
    { text: selected && !inert ? CYCLE_LEFT : '  ', style: FG_GREY },
    {
      text: bar(max > 0 ? level / max : 0, VOLUME_BAR_WIDTH),
      style: inert ? STYLE_DIM : level > 0 ? FG_GREEN : FG_GREY,
    },
    { text: selected && !inert ? CYCLE_RIGHT : '  ', style: FG_GREY },
    { text: ` ${displayWithSpec(spec, level)}`, style: inert ? STYLE_DIM : STYLE_BOLD },
    { text: inert ? `  ${MASTER_VOLUME_INERT}` : '', style: STYLE_DIM },
  ];
}

function sectionSummary(id: SectionId, state: DaemonState, library: readonly TrackView[]): string {
  if (id === SECTION_SETTINGS) return `${listedSpecs(state).length} options`;
  if (id === SECTION_MUSIC) {
    const shown = visibleTracks(library, activePlaylist(state));
    return shown.length > 0
      ? `${activePlaylist(state)} · ${shown.length} tracks`
      : TRACK_HEADING.toLowerCase();
  }
  const muted = state.sessions.filter((session) => session.muted).length;
  const sounding = state.sessions.filter((session) => session.audible).length;
  if (state.sessions.length === 0) return EMPTY_SESSIONS_TEXT;
  return `${state.sessions.length} · ${sounding} sounding · ${muted} muted`;
}

function sectionLine(options: {
  id: SectionId;
  state: DaemonState;
  library: readonly TrackView[];
  selected: boolean;
  width: number;
}): Segment[] {
  const { id, state, library, selected, width } = options;
  return [
    cursorSegment(selected),
    { text: ' ', style: STYLE_NONE },
    { text: fit(SECTION_TITLES[id], TITLE_COLUMN_WIDTH), style: selected ? STYLE_BOLD : STYLE_NONE },
    { text: '  ', style: STYLE_NONE },
    {
      text: clip(sectionSummary(id, state, library), Math.max(width - TITLE_COLUMN_WIDTH - 8, 0)),
      style: FG_CYAN,
    },
    { text: selected ? ` ${ENTER_MARKER}` : '', style: FG_GREY },
  ];
}

function transportSegments(transport: TransportState, width: number): Segment[] {
  const clock = `${formatClock(transport.position)} / ${formatClock(transport.duration)}`;
  const fraction = transport.duration > 0 ? transport.position / transport.duration : 0;
  return [
    { text: clock.padEnd(CLOCK_COLUMN_WIDTH), style: STYLE_BOLD },
    {
      text: bar(fraction, width - CLOCK_COLUMN_WIDTH),
      style: transport.playing ? FG_GREEN : FG_YELLOW,
    },
  ];
}

/** Names the desks a voice gates: "Strings" alone does not say which fall silent. */
function voiceDetail(session: SessionView, width: number): Segment[] {
  if (session.muted) return [{ text: SESSION_HELP_MUTED, style: FG_GREY }];
  if (!session.voiceName) return [{ text: SESSION_HELP_UNVOICED, style: FG_GREY }];
  const named = session.voiceParts.filter((part) => part !== session.voiceName);
  if (named.length === 0) return [{ text: `${session.voiceName}${BACKING_NOTE}`, style: FG_GREY }];
  const room = width - session.voiceName.length - SESSION_GATES.length - BACKING_NOTE.length;
  return [
    { text: session.voiceName, style: FG_CYAN },
    { text: SESSION_GATES, style: FG_GREY },
    { text: clip(named.join(', '), Math.max(room, 0)), style: STYLE_NONE },
    { text: BACKING_NOTE, style: FG_GREY },
  ];
}

function helpSegments(row: Row | null, width: number, active: string): Segment[] {
  if (!row) return [];
  if (row.kind === 'section') return [{ text: SECTION_HELP[row.id], style: FG_GREY }];
  if (row.kind === 'setting') return [{ text: row.spec.help, style: FG_GREY }];
  if (row.kind === 'action') return [{ text: ACTION_HELP[row.id], style: FG_GREY }];
  if (row.kind === 'bluetooth') return [{ text: BLUETOOTH_PHONE_STEP, style: FG_GREY }];
  if (row.kind === 'playlist') {
    if (row.playlist.count === 0) return [{ text: PLAYLIST_HELP_EMPTY, style: FG_GREY }];
    const help = row.playlist.name === active ? PLAYLIST_HELP_ACTIVE : PLAYLIST_HELP_CHOOSE;
    return [{ text: help, style: FG_GREY }];
  }
  if (row.kind === 'track') return [{ text: row.track.file, style: FG_GREY }];
  return voiceDetail(row.session, width);
}

function hintsFor(section: SectionId | null): string {
  if (section === null) return HINTS_ROOT;
  if (section === SECTION_SESSIONS) return HINTS_SESSIONS;
  return section === SECTION_MUSIC ? HINTS_MUSIC : HINTS_SETTINGS;
}

/** A failure replaces the hints rather than sharing the line: at 80 columns it would be ellipsized. */
function footerLine(options: {
  notice: string | null;
  section: SectionId | null;
  width: number;
}): string {
  const { notice, section, width } = options;
  if (notice) return composeLine([{ text: notice, style: FG_RED }], width);
  return composeLine([{ text: hintsFor(section), style: STYLE_DIM }], width);
}

function rowsFor(options: {
  state: DaemonState;
  section: SectionId | null;
  library: readonly TrackView[];
  playlists: readonly PlaylistView[];
  bluetoothDevices: readonly BluetoothDevice[];
}): Row[] {
  const { state, section, library, playlists, bluetoothDevices } = options;
  if (section === null) {
    const sections: Row[] = SECTION_IDS.map((id) => ({ kind: 'section', key: `section:${id}`, id }));
    const volume = masterVolumeSpec(state);
    if (!volume) return sections;
    return [...sections, { kind: 'setting', key: `setting:${volume.key}`, spec: volume }];
  }
  if (section === SECTION_SETTINGS) {
    return listedSpecs(state).map((spec) => ({ kind: 'setting', key: `setting:${spec.key}`, spec }));
  }
  if (section === SECTION_MUSIC) {
    const actions: Row[] = ACTION_IDS.map((id) => ({ kind: 'action', key: `action:${id}`, id }));
    const paired: Row[] = bluetoothDevices.map((device) => ({
      kind: 'bluetooth',
      key: `bluetooth:${device.id}`,
      device,
    }));
    const chooser: Row[] = playlists.map((playlist) => ({
      kind: 'playlist',
      key: `playlist:${playlist.name}`,
      playlist,
    }));
    const shown = visibleTracks(library, activePlaylist(state));
    return [
      ...actions,
      ...paired,
      ...chooser,
      ...shown.map((track): Row => ({ kind: 'track', key: `track:${track.file}`, track })),
    ];
  }
  return state.sessions.map((session) => ({
    kind: 'session',
    key: `session:${session.sessionId}`,
    session,
  }));
}

function actionLine(options: { id: ActionId; selected: boolean; width: number }): Segment[] {
  const { id, selected, width } = options;
  return [
    cursorSegment(selected),
    { text: ' ', style: STYLE_NONE },
    { text: clip(ACTION_TITLES[id], Math.max(width - 4, 0)), style: selected ? STYLE_BOLD : STYLE_NONE },
  ];
}

function bluetoothLine(options: {
  device: BluetoothDevice;
  connected: boolean;
  selected: boolean;
  width: number;
}): Segment[] {
  const { device, connected, selected, width } = options;
  return [
    cursorSegment(selected),
    {
      text: connected ? ` ${BLUETOOTH_CONNECTED_MARK} ` : '   ',
      style: connected ? FG_GREEN : STYLE_NONE,
    },
    {
      text: clip(device.name, Math.max(width - 6, 0)),
      style: selected || connected ? STYLE_BOLD : STYLE_NONE,
    },
  ];
}

function playlistLine(options: {
  playlist: PlaylistView;
  active: boolean;
  selected: boolean;
  width: number;
}): Segment[] {
  const { playlist, active, selected, width } = options;
  const note =
    playlist.count === 0
      ? PLAYLIST_EMPTY_NOTE
      : `${playlist.count} ${playlist.count === 1 ? 'track' : 'tracks'}`;
  const room = Math.max(width - note.length - 6, 0);
  const nameStyle = selected || active ? STYLE_BOLD : STYLE_NONE;
  return [
    cursorSegment(selected),
    { text: active ? ` ${PLAYLIST_ACTIVE_MARK} ` : '   ', style: active ? FG_GREEN : STYLE_NONE },
    { text: fit(playlist.name, Math.min(TITLE_COLUMN_WIDTH, room)), style: nameStyle },
    { text: `  ${note}`, style: playlist.count === 0 ? FG_YELLOW : FG_CYAN },
  ];
}

function trackLine(options: {
  track: TrackView;
  playing: boolean;
  selected: boolean;
  width: number;
}): Segment[] {
  const { track, playing, selected, width } = options;
  // The composer earns its place only when there is room; the title is what the user chooses by.
  const label = track.composer ? `${track.title} — ${track.composer}` : track.title;
  const note = track.integrity === 'mismatch'
    ? TRACK_INTEGRITY_BAD
    : track.holdMusicOnly
      ? TRACK_UNPLAYABLE
      : '';
  const room = Math.max(width - note.length - 6, 0);
  return [
    cursorSegment(selected),
    { text: playing ? ` ${NOW_PLAYING_MARK} ` : '   ', style: playing ? FG_GREEN : STYLE_NONE },
    { text: clip(label, room), style: selected ? STYLE_BOLD : STYLE_NONE },
    { text: note ? `  ${note}` : '', style: track.integrity === 'mismatch' ? FG_RED : STYLE_DIM },
  ];
}

function rowLine(options: {
  row: Row;
  state: DaemonState;
  library: readonly TrackView[];
  section: SectionId | null;
  selected: boolean;
  width: number;
}): Segment[] {
  const { row, state, library, section, selected, width } = options;
  if (row.kind === 'section') return sectionLine({ id: row.id, state, library, selected, width });
  if (row.kind === 'session') return sessionLine({ session: row.session, selected, width });
  if (row.kind === 'action') return actionLine({ id: row.id, selected, width });
  if (row.kind === 'bluetooth') {
    return bluetoothLine({
      device: row.device,
      connected: row.device.id === state.bluetooth.device?.id,
      selected,
      width,
    });
  }
  if (row.kind === 'playlist') {
    const active = row.playlist.name === activePlaylist(state);
    return playlistLine({ playlist: row.playlist, active, selected, width });
  }
  if (row.kind === 'track') {
    return trackLine({ track: row.track, playing: row.track.file === state.track, selected, width });
  }
  if (row.spec.key === MASTER_VOLUME_KEY) {
    return masterVolumeLine({
      spec: row.spec,
      config: state.config,
      ducking: state.ducking,
      selected,
    });
  }
  return settingLine({ spec: row.spec, config: state.config, selected, width });
}

/** A volume bridge that never came up is the whole feature quietly doing nothing. */
function sourceSegments(state: DaemonState): Segment[] {
  if (state.ducking) {
    return [
      { text: 'DUCK  ', style: STYLE_DIM },
      {
        text: state.duck.error ?? (state.duck.ready ? 'system output' : 'no endpoint'),
        style: state.duck.error ? FG_RED : state.duck.ready ? FG_GREEN : FG_YELLOW,
      },
      ...bluetoothSegments(state),
    ];
  }
  return [
    { text: 'MIDI  ', style: STYLE_DIM },
    {
      text: state.midi.error ?? state.midi.device ?? 'no device',
      style: state.midi.error ? FG_RED : state.midi.ready ? FG_GREEN : FG_YELLOW,
    },
    ...bluetoothSegments(state),
  ];
}

function bluetoothSegments(state: DaemonState): Segment[] {
  if (!state.config.bluetoothReceive) return [];
  const { ready, device, error } = state.bluetooth;
  const open = state.bluetooth.state === BLUETOOTH_OPENED;
  return [
    { text: `   ${BLUETOOTH_LABEL}`, style: STYLE_DIM },
    {
      text: error ? BLUETOOTH_NOT_LINKED_SHORT : (device?.name ?? (ready ? 'no phone' : 'starting')),
      style: error ? FG_RED : open ? FG_GREEN : FG_YELLOW,
    },
  ];
}

/** An open link always asks for the phone: nothing here can see whether audio is arriving. */
function bluetoothAdvice(state: DaemonState): Segment[] {
  if (!state.config.bluetoothReceive) return [];
  const { ready, device, error } = state.bluetooth;
  if (error) {
    return [
      { text: BLUETOOTH_NOT_LINKED, style: FG_YELLOW },
      { text: error, style: FG_RED },
    ];
  }
  if (!ready) return [{ text: BLUETOOTH_STARTING, style: FG_YELLOW }];
  if (!device) return [{ text: BLUETOOTH_CHOOSE, style: FG_YELLOW }];
  if (state.bluetooth.state === BLUETOOTH_CLOSED) {
    return [{ text: `${device.name} ${BLUETOOTH_DROPPED}`, style: FG_YELLOW }];
  }
  return [
    { text: `${device.name} connected. `, style: FG_GREEN },
    { text: BLUETOOTH_PHONE_STEP, style: FG_YELLOW },
  ];
}

function buildLines(view: View): string[] {
  const { snapshot, link, section, selectedKey, notice, library, playlists, bluetoothDevices } =
    view;
  const width = clamp(process.stdout.columns ?? FALLBACK_COLUMNS, MIN_COLUMNS, MAX_COLUMNS);
  if (!snapshot) {
    return [
      composeLine([{ text: 'LLMFM', style: STYLE_BOLD }], width),
      composeLine([{ text: link, style: FG_RED }], width),
      '',
      footerLine({ notice, section, width }),
    ];
  }

  const { state } = snapshot;
  const elapsed = (Date.now() - snapshot.receivedAt) / MS_PER_SECOND;
  const transport: TransportState = state.transport.playing
    ? {
        ...state.transport,
        position: Math.min(state.transport.position + elapsed, state.transport.duration),
      }
    : state.transport;

  const advice = bluetoothAdvice(state);
  const lines = [
    composeLine(
      [
        { text: 'LLMFM  ', style: STYLE_BOLD },
        { text: state.track ?? 'no track', style: FG_CYAN },
        { text: '   ', style: STYLE_NONE },
        {
          text: transport.playing ? 'PLAYING' : 'PAUSED',
          style: transport.playing ? FG_GREEN : FG_YELLOW,
        },
      ],
      width,
    ),
    composeLine(transportSegments(transport, width), width),
    composeLine(sourceSegments(state), width),
    ...(advice.length > 0 ? [composeLine(advice, width)] : []),
    composeLine(
      [
        { text: `sim(${KEY_TOGGLE_SIMULATION}) `, style: STYLE_DIM },
        { text: state.simulating ? 'on' : 'off', style: state.simulating ? FG_YELLOW : FG_GREY },
        { text: '   link ', style: STYLE_DIM },
        { text: link, style: link === LINK_LIVE ? FG_GREEN : FG_RED },
      ],
      width,
    ),
    '',
    composeLine(
      [
        { text: ROOT_HEADING, style: section === null ? STYLE_BOLD : STYLE_DIM },
        ...(section === null
          ? []
          : [
              { text: ` ${ENTER_MARKER} `, style: STYLE_DIM },
              { text: SECTION_TITLES[section].toUpperCase(), style: STYLE_BOLD },
            ]),
      ],
      width,
    ),
  ];

  const rows = rowsFor({ state, section, library, playlists, bluetoothDevices });
  const room = Math.max(
    (process.stdout.rows ?? FALLBACK_ROWS) - CHROME_LINE_COUNT - (advice.length > 0 ? 1 : 0),
    1,
  );
  const selectedIndexInRows = rows.findIndex((row) => row.key === selectedKey);
  const start = Math.max(Math.min(selectedIndexInRows - room + 1, rows.length - room), 0);
  const shown = rows.slice(start, start + room);
  for (const row of shown) {
    lines.push(
      composeLine(rowLine({ row, state, library, section, selected: row.key === selectedKey, width }), width),
    );
  }
  if (rows.length === 0) {
    lines.push(composeLine([{ text: `  ${EMPTY_SESSIONS_TEXT}`, style: STYLE_DIM }], width));
  }

  const above = start;
  const below = rows.length - start - shown.length;
  const overflow = [
    ...(above > 0 ? [`+${above} ${MORE_ABOVE}`] : []),
    ...(below > 0 ? [`+${below} ${MORE_BELOW}`] : []),
  ];
  lines.push(
    overflow.length > 0
      ? composeLine([{ text: `  ${overflow.join('   ')}`, style: STYLE_DIM }], width)
      : '',
  );

  const selected = rows.find((row) => row.key === selectedKey) ?? null;
  lines.push('');
  lines.push(
    composeLine(
      [
        { text: '  ', style: STYLE_NONE },
        ...helpSegments(selected, width - 2, activePlaylist(state)),
      ],
      width,
    ),
  );
  lines.push(footerLine({ notice, section, width }));
  return lines;
}

let snapshot: Snapshot | null = null;
let link: LinkState = LINK_DOWN;
let section: SectionId | null = null;
let selectedKey: string | null = null;
/** Remembered so a selection that disappears falls back to the nearest surviving row. */
let selectedIndex = 0;
/** Where the cursor was left in each view, so stepping in and back out does not lose it. */
const cursorMemory = new Map<string, string>();
let notice: string | null = null;
/** Fetched per section open, not per broadcast: it is larger than the rest of the payload. */
let library: TrackView[] = [];
let playlists: PlaylistView[] = [];
/** Listed only on request: enumerating goes over the radio and takes tens of seconds. */
let bluetoothDevices: BluetoothDevice[] = [];
let restored = false;
let quitting = false;

function viewKey(): string {
  return section ?? ROOT_HEADING;
}

function currentRows(): Row[] {
  if (!snapshot) return [];
  return rowsFor({ state: snapshot.state, section, library, playlists, bluetoothDevices });
}

function selectRow(rows: Row[], index: number): void {
  if (rows.length === 0) {
    selectedKey = null;
    selectedIndex = 0;
    return;
  }
  selectedIndex = clamp(index, 0, rows.length - 1);
  selectedKey = rows[selectedIndex]?.key ?? null;
  if (selectedKey) cursorMemory.set(viewKey(), selectedKey);
}

function restoreCursor(): void {
  const rows = currentRows();
  const remembered = cursorMemory.get(viewKey());
  const index = rows.findIndex((row) => row.key === remembered);
  selectRow(rows, index >= 0 ? index : 0);
}

function paint(): void {
  if (restored) return;
  const frame = [CURSOR_HOME];
  const view = { snapshot, link, section, selectedKey, notice, library, playlists, bluetoothDevices };
  for (const line of buildLines(view)) {
    frame.push(line, ERASE_TO_LINE_END, '\n');
  }
  frame.push(ERASE_BELOW);
  process.stdout.write(frame.join(''));
}

function restoreTerminal(): void {
  if (restored) return;
  restored = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${STYLE_RESET}${CURSOR_SHOW}${ALTERNATE_SCREEN_OFF}`);
}

function applyState(state: DaemonState, next: LinkState): void {
  snapshot = { state, receivedAt: Date.now() };
  link = next;
  const rows = rowsFor({ state, section, library, playlists, bluetoothDevices });
  const index = rows.findIndex((row) => row.key === selectedKey);
  selectRow(rows, index >= 0 ? index : selectedIndex);
  paint();
}

async function fetchState(): Promise<DaemonState | null> {
  const response = await fetch(`${DAEMON_URL}/state`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return parseDaemonState(await response.text());
}

/** The daemon broadcasts on session change only, so a control change is read back explicitly. */
async function command(path: string, body?: unknown): Promise<void> {
  try {
    const response = await fetch(`${DAEMON_URL}${path}`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    notice = response.ok ? null : `${COMMAND_FAILURE_NOTICE} ${response.status}`;
    const state = await fetchState();
    if (state) applyState(state, link);
    else paint();
  } catch {
    link = LINK_DOWN;
    paint();
  }
}

/** Re-read on every music-section open, so a dropped-in file appears without a restart. */
async function refreshLibrary(): Promise<void> {
  try {
    const [tracks, chooser] = await Promise.all([
      fetch(`${DAEMON_URL}/tracks`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      fetch(`${DAEMON_URL}/playlists`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    ]);
    if (tracks.ok) library = parseTracks(await tracks.text());
    if (chooser.ok) playlists = parsePlaylists(await chooser.text());
    restoreCursor();
    paint();
  } catch {
    // A stale list beats an empty one; the link state already says whether the daemon is reachable.
  }
}

/** A local shell-out, not network egress; a failure is reported rather than left silent. */
function openTracksFolder(): void {
  const dir = snapshot?.state.playlistsDir;
  if (!dir) {
    notice = `${FOLDER_OPEN_FAILED} the daemon did not say where it is`;
    paint();
    return;
  }
  try {
    const child = spawn(FOLDER_OPEN_COMMAND, [dir], { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      notice = `${FOLDER_OPEN_FAILED} ${dir}`;
      paint();
    });
    child.unref();
  } catch {
    notice = `${FOLDER_OPEN_FAILED} ${dir}`;
    paint();
  }
}

/** The notice goes up before the request: half a minute of nothing reads as a hang. */
async function scanBluetooth(): Promise<void> {
  const enabling = snapshot?.state.config.bluetoothReceive === false;
  notice = enabling ? BLUETOOTH_ENABLING : BLUETOOTH_SEARCHING;
  paint();
  if (enabling) {
    await command('/config', { key: 'bluetoothReceive', value: true });
    notice = BLUETOOTH_SEARCHING;
    paint();
  }
  try {
    const response = await fetch(`${DAEMON_URL}/bluetooth/devices`, {
      signal: AbortSignal.timeout(BLUETOOTH_LIST_TIMEOUT_MS),
    });
    bluetoothDevices = response.ok ? parseBluetoothDevices(await response.text()) : [];
  } catch {
    bluetoothDevices = [];
  }
  notice = bluetoothDevices.length > 0 ? BLUETOOTH_PHONE_STEP : BLUETOOTH_NONE_PAIRED;
  restoreCursor();
  paint();
}

/** The phone step stands as the notice rather than a success message: it is what the user must do next. */
async function connectBluetooth(device: BluetoothDevice): Promise<void> {
  notice = `${BLUETOOTH_CONNECTING} ${device.name}…`;
  paint();
  try {
    const response = await fetch(`${DAEMON_URL}/bluetooth/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: device.id }),
      signal: AbortSignal.timeout(BLUETOOTH_CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) {
      notice = BLUETOOTH_CONNECT_FAILED;
      paint();
      return;
    }
    notice = BLUETOOTH_PHONE_STEP;
    const state = parseDaemonState(await response.text());
    if (state) applyState(state, link);
    else paint();
  } catch {
    notice = BLUETOOTH_CONNECT_FAILED;
    paint();
  }
}

function runAction(id: ActionId): void {
  if (id === ACTION_BLUETOOTH) {
    void scanBluetooth();
    return;
  }
  if (id === ACTION_FOLDER) {
    openTracksFolder();
    void refreshLibrary();
    return;
  }
  const playable = snapshot ? visibleTracks(library, activePlaylist(snapshot.state)) : library;
  if (playable.length < 2) {
    notice = SKIP_UNAVAILABLE;
    paint();
    return;
  }
  void command('/skip');
}

/** Re-reads the catalogue too: the per-playlist counts are only as fresh as the last folder read. */
async function choosePlaylist(name: string): Promise<void> {
  await command('/playlist', { name });
  await refreshLibrary();
}

function cycleSetting(spec: SettingSpec, direction: 1 | -1): void {
  if (!snapshot) return;
  if (spec.key === MASTER_VOLUME_KEY && snapshot.state.ducking) {
    notice = MASTER_VOLUME_INERT_NOTICE;
    paint();
    return;
  }
  const value = nextWithSpec(spec, settingValue(snapshot.state.config, spec.key), direction);
  if (value !== null) void command('/config', { key: spec.key, value });
}

/** A shortcut may name a setting this daemon lacks; saying so beats a silent no-op or a 400. */
function cycleByKey(key: string, direction: 1 | -1): void {
  if (!snapshot) return;
  const spec = snapshot.state.settingSpecs.find((candidate) => candidate.key === key);
  if (!spec) {
    notice = `${UNSUPPORTED_SETTING_NOTICE} ${key}`;
    paint();
    return;
  }
  cycleSetting(spec, direction);
}

function selectedRow(): Row | null {
  return currentRows().find((row) => row.key === selectedKey) ?? null;
}

function enterSection(id: SectionId): void {
  section = id;
  restoreCursor();
  paint();
  if (id === SECTION_MUSIC) void refreshLibrary();
}

function leaveSection(): void {
  const leaving = section;
  section = null;
  if (leaving) cursorMemory.set(ROOT_HEADING, `section:${leaving}`);
  restoreCursor();
  paint();
}

function toggleMute(session: SessionView): void {
  void command('/mute', { sessionId: session.sessionId, muted: !session.muted });
}

/** Left/right mean less/more on value rows; a session row holds none, so left means back. */
function onHorizontal(direction: 1 | -1): void {
  const row = selectedRow();
  if (!row) {
    if (direction === -1) leaveSection();
    return;
  }
  if (row.kind === 'section') {
    if (direction === 1) enterSection(row.id);
    return;
  }
  if (row.kind === 'session') {
    if (direction === 1) toggleMute(row.session);
    else leaveSection();
    return;
  }
  if (row.kind === 'action') {
    if (direction === 1) runAction(row.id);
    else leaveSection();
    return;
  }
  if (row.kind === 'bluetooth') {
    if (direction === 1) void connectBluetooth(row.device);
    else leaveSection();
    return;
  }
  if (row.kind === 'playlist') {
    if (direction === 1) void choosePlaylist(row.playlist.name);
    else leaveSection();
    return;
  }
  if (row.kind === 'track') {
    if (direction === 1) void command('/track', { file: row.track.file });
    else leaveSection();
    return;
  }
  cycleSetting(row.spec, direction);
}

function onActivate(): void {
  const row = selectedRow();
  if (!row) return;
  if (row.kind === 'section') enterSection(row.id);
  else if (row.kind === 'session') toggleMute(row.session);
  else if (row.kind === 'action') runAction(row.id);
  else if (row.kind === 'bluetooth') void connectBluetooth(row.device);
  else if (row.kind === 'playlist') void choosePlaylist(row.playlist.name);
  else if (row.kind === 'track') void command('/track', { file: row.track.file });
  else cycleSetting(row.spec, 1);
}

function onKey(key: string): void {
  if (key === KEY_QUIT || key === KEY_INTERRUPT) {
    quitting = true;
    restoreTerminal();
    void runShutdown().finally(() => process.exit(0));
    return;
  }
  if (!snapshot) return;
  if (KEYS_SELECT_PREVIOUS.some((candidate) => candidate === key)) {
    selectRow(currentRows(), selectedIndex - 1);
    paint();
    return;
  }
  if (KEYS_SELECT_NEXT.some((candidate) => candidate === key)) {
    selectRow(currentRows(), selectedIndex + 1);
    paint();
    return;
  }
  if (KEYS_BACK.some((candidate) => candidate === key)) {
    leaveSection();
    return;
  }
  if (KEYS_LEFT.some((candidate) => candidate === key)) {
    onHorizontal(-1);
    return;
  }
  if (KEYS_RIGHT.some((candidate) => candidate === key)) {
    onHorizontal(1);
    return;
  }
  if (KEYS_ACTIVATE.some((candidate) => candidate === key)) {
    onActivate();
    return;
  }
  if (key === KEY_TOGGLE_MUTE) {
    const row = selectedRow();
    if (row?.kind === 'session') toggleMute(row.session);
    return;
  }
  if (key === KEY_CYCLE_MODE) {
    cycleByKey(MODE_KEY, 1);
    return;
  }
  if (key === KEY_TOGGLE_SIMULATION) {
    void command(`/simulate?running=${!snapshot.state.simulating}`);
    return;
  }
  if (KEYS_FADE_UP.some((candidate) => candidate === key)) cycleByKey(FADE_KEY, 1);
  else if (KEYS_FADE_DOWN.some((candidate) => candidate === key)) cycleByKey(FADE_KEY, -1);
}

function readFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  return { frames: parts.slice(0, -1), rest: parts[parts.length - 1] ?? '' };
}

function frameData(frame: string): string {
  return frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('');
}

/** No request timeout: the stream is long-lived, and an unreachable daemon fails the connect. */
async function streamEvents(): Promise<void> {
  const response = await fetch(`${DAEMON_URL}/events`);
  if (!response.ok || !response.body) throw new Error(`stream refused: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!quitting) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = readFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const state = parseDaemonState(frameData(frame));
      if (state) applyState(state, LINK_LIVE);
    }
  }
  await reader.cancel();
}

/** A daemon restart shows as a wait rather than an exit; SSE resumes on the first reply. */
async function waitForDaemon(): Promise<void> {
  while (!quitting) {
    try {
      const state = await fetchState();
      if (state) {
        applyState(state, LINK_POLLING);
        return;
      }
    } catch {
      link = LINK_DOWN;
      paint();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function run(): Promise<void> {
  // The root menu shows a track count, so the catalogue is read before the first frame.
  void refreshLibrary();
  while (!quitting) {
    try {
      await streamEvents();
    } catch {
      link = LINK_DOWN;
      paint();
    }
    if (quitting) return;
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    await waitForDaemon();
  }
}

process.on('exit', restoreTerminal);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(signal, () => {
    quitting = true;
    restoreTerminal();
    void runShutdown().finally(() => process.exit(0));
  });
}
for (const failure of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(failure, (error: unknown) => {
    restoreTerminal();
    console.error(error);
    void runShutdown().finally(() => process.exit(EXIT_FAILURE));
  });
}

process.stdout.write(`${ALTERNATE_SCREEN_ON}${CURSOR_HIDE}`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => onKey(chunk));
process.stdout.on('resize', paint);
setInterval(paint, RENDER_INTERVAL_MS).unref();

paint();
await run();
