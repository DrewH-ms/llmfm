import { DAEMON_URL, GATE_MODES } from '../src/constants.ts';
import type { GateMode } from '../src/constants.ts';
import { SETTING_DEFAULTS, SETTING_SPECS, coerceSetting, displaySetting, nextSetting } from '../src/settings.ts';
import type { SettingSpec } from '../src/settings.ts';
import { SESSION_SOURCES } from '../src/types.ts';
import type { DaemonState, MidiStatus, SessionView, TransportState } from '../src/types.ts';
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
const SETTING_TITLE_WIDTH = 20;
const VOLUME_BAR_WIDTH = 24;
const BADGE_TEXT_SOUNDING = ' SOUNDING ';
const BADGE_TEXT_SILENT = '  silent  ';
const BADGE_TEXT_MUTED = '  muted   ';
const TAG_BLOCKED = 'BLOCKED?';
const CURSOR_SELECTED = '▸';
const CURSOR_UNSELECTED = ' ';
const CYCLE_LEFT = '‹ ';
const CYCLE_RIGHT = ' ›';
const MARKER_SOUNDING = '█ ';
const MARKER_SILENT = '· ';
/** Blank, not a third glyph: the column means "is this part sounding", and a muted row
 *  is answering a question we have deliberately stopped asking. */
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
const FADE_DECIMALS = 2;
/** Lines below the session window: its overflow marker, a blank, the master-volume
 *  heading and row, a blank, the help line and the footer. */
const TAIL_LINE_COUNT = 7;

const HEADING_SETTINGS = 'SETTINGS';
const HEADING_SESSIONS = 'SESSIONS';
const HEADING_MASTER_VOLUME = 'MASTER VOLUME';
const SESSION_HELP = 'Muted sessions take no voice and never hold the music on.';
const EMPTY_SESSIONS_TEXT = '  no sessions';

const MS_PER_SECOND = 1000;
const RENDER_INTERVAL_MS = 200;
const RECONNECT_DELAY_MS = 1000;
const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 2000;

const FADE_STEP_SECONDS = 0.25;
const FADE_MIN_SECONDS = 0.25;
const FADE_MAX_SECONDS = 10;

const KEY_QUIT = 'q';
const KEY_INTERRUPT = '\u0003';
const KEY_TOGGLE_MODE = 'g';
const KEY_TOGGLE_SIMULATION = 'S';
const KEY_TOGGLE_MUTE = 'm';
const KEYS_FADE_UP = ['+', '='] as const;
const KEYS_FADE_DOWN = ['-', '_'] as const;
/** Both the cursor-key and application-keypad forms: a raw TTY emits either. */
const KEYS_SELECT_PREVIOUS = ['\u001b[A', '\u001bOA', 'w', 'k'] as const;
const KEYS_SELECT_NEXT = ['\u001b[B', '\u001bOB', 's', 'j'] as const;
const KEYS_DECREASE = ['\u001b[D', '\u001bOD', 'a', 'h'] as const;
const KEYS_INCREASE = ['\u001b[C', '\u001bOC', 'd', 'l'] as const;
const KEYS_ACTIVATE = ['\r', '\n', ' '] as const;
const KEY_HINTS = '[↑↓ ws] move   [←→ ad] change   [enter/m] toggle   [q] quit';
const COMMAND_FAILURE_NOTICE = 'daemon rejected command:';
const EXIT_FAILURE = 1;

const LINK_LIVE = 'live';
const LINK_POLLING = 'polling';
const LINK_DOWN = 'daemon down — retrying';

const LINK_STATES = [LINK_LIVE, LINK_POLLING, LINK_DOWN] as const;
type LinkState = (typeof LINK_STATES)[number];

const MASTER_VOLUME_KEY = 'masterVolume';
/** Master volume is a setting like any other, but the listener reaches for it constantly,
 *  so it is lifted out of the list into its own section rather than being scrolled to. */
const MASTER_VOLUME_SPEC = SETTING_SPECS.find((spec) => spec.key === MASTER_VOLUME_KEY) ?? null;
const LISTED_SETTING_SPECS = SETTING_SPECS.filter((spec) => spec.key !== MASTER_VOLUME_KEY);
const FALLBACK_CONFIG: LlmfmConfig = { muted: [], ...SETTING_DEFAULTS };

type Segment = { text: string; style: string };

type Snapshot = { state: DaemonState; receivedAt: number };

/** A selectable menu row. `key` is stable across frames — a session's array position is
 *  not, and neither is its presence. */
type Row =
  | { kind: 'setting'; key: string; spec: SettingSpec }
  | { kind: 'session'; key: string; session: SessionView };

/** Everything a frame is drawn from. */
type View = {
  snapshot: Snapshot | null;
  link: LinkState;
  selectedKey: string | null;
  notice: string | null;
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

function parseSession(value: unknown): SessionView | null {
  if (!isRecord(value)) return null;
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
    audible,
    handle,
    muted,
  };
}

/** Never fails: a daemon that sends no config, or one field of nonsense, costs the user
 *  the menu's accuracy for that row, not the screen. Values go through the same specs the
 *  daemon validates writes with, so the two sides cannot disagree about what is legal. */
function parseConfig(value: unknown): LlmfmConfig {
  const record = isRecord(value) ? value : {};
  const settings: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const spec of SETTING_SPECS) {
    const coerced = coerceSetting(spec.key, record[spec.key]);
    if (coerced !== null) settings[spec.key] = coerced;
  }
  const muted = Array.isArray(record['muted'])
    ? record['muted'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { ...(settings as Omit<LlmfmConfig, 'muted'>), muted };
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
  const { fadeSeconds, simulating, track } = payload;
  const mode = GATE_MODES.find((candidate) => candidate === payload['mode']);
  const transport = parseTransport(payload['transport']);
  const midi = parseMidi(payload['midi']);
  if (!mode || !transport || !midi) return null;
  if (typeof fadeSeconds !== 'number' || typeof simulating !== 'boolean') return null;
  if (track !== null && typeof track !== 'string') return null;
  if (!Array.isArray(payload['sessions'])) return null;
  const sessions: SessionView[] = [];
  for (const entry of payload['sessions']) {
    const session = parseSession(entry);
    if (!session) return null;
    sessions.push(session);
  }
  const config = parseConfig(payload['config']);
  return { mode, fadeSeconds, simulating, track, transport, midi, sessions, config };
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

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(width - 1, 0))}${ELLIPSIS}`;
}

/** Truncates without padding, for a value that a following marker must sit against. */
function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(width - 1, 0))}${ELLIPSIS}`;
}

/** Styles segments only after the plain text has been measured, so colour codes never
 *  count against the terminal width. */
function composeLine(segments: Segment[], width: number): string {
  let used = 0;
  let line = '';
  for (const segment of segments) {
    if (used >= width) break;
    const room = width - used;
    const text =
      segment.text.length > room
        ? `${segment.text.slice(0, Math.max(room - 1, 0))}${ELLIPSIS}`
        : segment.text;
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

/** How long a session has claimed to be blocked. The claim is sticky — an approved
 *  permission prompt produces no event — so its age is the only evidence the user has
 *  that `BLOCKED?` may already be stale. */
function blockedTag(blockedSince: number | null): string {
  if (blockedSince === null) return ` ${TAG_BLOCKED}`;
  const seconds = Math.max(Math.floor((Date.now() - blockedSince) / MS_PER_SECOND), 0);
  const age =
    seconds < SECONDS_PER_MINUTE
      ? `${seconds}s`
      : `${Math.floor(seconds / SECONDS_PER_MINUTE)}m`;
  return ` ${TAG_BLOCKED} ${age}`;
}

function headingLine(text: string, width: number): string {
  return composeLine([{ text, style: STYLE_BOLD }], width);
}

/** Lays the row out tag-first: `BLOCKED?` says why a part is silent, which the audio
 *  cannot, so the voice name yields its width to it. A muted session makes no claim
 *  about its agent, so it carries no tag. */
function sessionLine(options: { session: SessionView; selected: boolean; width: number }): Segment[] {
  const { session, selected, width } = options;
  const tags: Segment[] = [];
  if (session.blockedMidTurn && !session.muted) {
    tags.push({ text: blockedTag(session.blockedSince), style: FG_YELLOW });
  }

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
    {
      text: selected ? CURSOR_SELECTED : CURSOR_UNSELECTED,
      style: selected ? FG_CYAN : STYLE_NONE,
    },
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
  const value = displaySetting(spec.key, settingValue(config, spec.key));
  return [
    {
      text: selected ? CURSOR_SELECTED : CURSOR_UNSELECTED,
      style: selected ? FG_CYAN : STYLE_NONE,
    },
    { text: ' ', style: STYLE_NONE },
    { text: fit(spec.title, SETTING_TITLE_WIDTH), style: selected ? STYLE_BOLD : STYLE_NONE },
    { text: ' ', style: STYLE_NONE },
    { text: selected ? CYCLE_LEFT : '  ', style: FG_GREY },
    { text: clip(value, Math.max(width - SETTING_TITLE_WIDTH - 8, 0)), style: FG_CYAN },
    { text: selected ? CYCLE_RIGHT : '', style: FG_GREY },
  ];
}

function masterVolumeLine(options: {
  spec: SettingSpec;
  config: LlmfmConfig;
  selected: boolean;
}): Segment[] {
  const { spec, config, selected } = options;
  const raw = settingValue(config, spec.key);
  const max = spec.kind === 'number' ? spec.max : 1;
  const level = typeof raw === 'number' ? raw : max;
  return [
    {
      text: selected ? CURSOR_SELECTED : CURSOR_UNSELECTED,
      style: selected ? FG_CYAN : STYLE_NONE,
    },
    { text: ' ', style: STYLE_NONE },
    { text: selected ? CYCLE_LEFT : '  ', style: FG_GREY },
    {
      text: bar(max > 0 ? level / max : 0, VOLUME_BAR_WIDTH),
      style: level > 0 ? FG_GREEN : FG_GREY,
    },
    { text: selected ? CYCLE_RIGHT : '  ', style: FG_GREY },
    { text: ` ${displaySetting(spec.key, level)}`, style: STYLE_BOLD },
  ];
}

function transportSegments(transport: TransportState, width: number): Segment[] {
  const clock = `${formatClock(transport.position)} / ${formatClock(transport.duration)}`;
  const fraction = transport.duration > 0 ? transport.position / transport.duration : 0;
  return [
    { text: clock.padEnd(CLOCK_COLUMN_WIDTH), style: STYLE_BOLD },
    { text: bar(fraction, width - CLOCK_COLUMN_WIDTH), style: transport.playing ? FG_GREEN : FG_YELLOW },
  ];
}

/** A failure replaces the key hints rather than sharing the line: at 80 columns the
 *  hints already fill it, and the notice would be the part that gets ellipsized. */
function footerLine(notice: string | null, width: number): string {
  if (notice) return composeLine([{ text: notice, style: FG_RED }], width);
  return composeLine([{ text: KEY_HINTS, style: STYLE_DIM }], width);
}

function rowsFor(state: DaemonState): Row[] {
  const rows: Row[] = LISTED_SETTING_SPECS.map((spec) => ({
    kind: 'setting',
    key: `setting:${spec.key}`,
    spec,
  }));
  for (const session of state.sessions) {
    rows.push({ kind: 'session', key: `session:${session.sessionId}`, session });
  }
  if (MASTER_VOLUME_SPEC) {
    rows.push({ kind: 'setting', key: `setting:${MASTER_VOLUME_SPEC.key}`, spec: MASTER_VOLUME_SPEC });
  }
  return rows;
}

function helpFor(row: Row | null): string {
  if (!row) return '';
  return row.kind === 'setting' ? row.spec.help : SESSION_HELP;
}

function statusSegments(state: DaemonState, link: LinkState): Segment[] {
  return [
    { text: `mode(${KEY_TOGGLE_MODE}) `, style: STYLE_DIM },
    { text: state.mode, style: FG_CYAN },
    { text: '   fade(-/+) ', style: STYLE_DIM },
    { text: `${state.fadeSeconds.toFixed(FADE_DECIMALS)}s`, style: FG_CYAN },
    { text: `   sim(${KEY_TOGGLE_SIMULATION}) `, style: STYLE_DIM },
    { text: state.simulating ? 'on' : 'off', style: state.simulating ? FG_YELLOW : FG_GREY },
    { text: '   link ', style: STYLE_DIM },
    { text: link, style: link === LINK_LIVE ? FG_GREEN : FG_RED },
  ];
}

function buildLines(view: View): string[] {
  const { snapshot, link, selectedKey, notice } = view;
  const width = clamp(process.stdout.columns ?? FALLBACK_COLUMNS, MIN_COLUMNS, MAX_COLUMNS);
  if (!snapshot) {
    return [
      composeLine([{ text: 'LLMFM', style: STYLE_BOLD }], width),
      composeLine([{ text: link, style: FG_RED }], width),
      '',
      footerLine(notice, width),
    ];
  }

  const { state } = snapshot;
  const { config } = state;
  const elapsed = (Date.now() - snapshot.receivedAt) / MS_PER_SECOND;
  const transport: TransportState = state.transport.playing
    ? {
        ...state.transport,
        position: Math.min(state.transport.position + elapsed, state.transport.duration),
      }
    : state.transport;

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
    composeLine(
      [
        { text: 'MIDI  ', style: STYLE_DIM },
        {
          text: state.midi.error ?? state.midi.device ?? 'no device',
          style: state.midi.error ? FG_RED : state.midi.ready ? FG_GREEN : FG_YELLOW,
        },
      ],
      width,
    ),
    composeLine(statusSegments(state, link), width),
    '',
    headingLine(HEADING_SETTINGS, width),
  ];

  for (const spec of LISTED_SETTING_SPECS) {
    lines.push(
      composeLine(
        settingLine({ spec, config, selected: selectedKey === `setting:${spec.key}`, width }),
        width,
      ),
    );
  }

  lines.push('');
  lines.push(headingLine(`${HEADING_SESSIONS} (${state.sessions.length})`, width));

  // Everything above the session window has already been emitted, so the window gets
  // whatever the terminal has left once the fixed tail is reserved.
  const room = Math.max(
    (process.stdout.rows ?? FALLBACK_ROWS) - lines.length - TAIL_LINE_COUNT,
    1,
  );
  const selectedSessionIndex = state.sessions.findIndex(
    (session) => `session:${session.sessionId}` === selectedKey,
  );
  const start = Math.max(
    Math.min(selectedSessionIndex - room + 1, state.sessions.length - room),
    0,
  );
  const shown = state.sessions.slice(start, start + room);
  for (const session of shown) {
    lines.push(
      composeLine(
        sessionLine({
          session,
          selected: selectedKey === `session:${session.sessionId}`,
          width,
        }),
        width,
      ),
    );
  }
  const above = start;
  const below = state.sessions.length - start - shown.length;
  const overflow = [
    ...(above > 0 ? [`+${above} ${MORE_ABOVE}`] : []),
    ...(below > 0 ? [`+${below} ${MORE_BELOW}`] : []),
  ];
  if (overflow.length > 0) {
    lines.push(composeLine([{ text: `  ${overflow.join('   ')}`, style: STYLE_DIM }], width));
  }
  if (state.sessions.length === 0) {
    lines.push(composeLine([{ text: EMPTY_SESSIONS_TEXT, style: STYLE_DIM }], width));
  }

  if (MASTER_VOLUME_SPEC) {
    lines.push('');
    lines.push(headingLine(HEADING_MASTER_VOLUME, width));
    lines.push(
      composeLine(
        masterVolumeLine({
          spec: MASTER_VOLUME_SPEC,
          config,
          selected: selectedKey === `setting:${MASTER_VOLUME_SPEC.key}`,
        }),
        width,
      ),
    );
  }

  const selected = rowsFor(state).find((row) => row.key === selectedKey) ?? null;
  lines.push('');
  lines.push(composeLine([{ text: `  ${helpFor(selected)}`, style: FG_GREY }], width));
  lines.push(footerLine(notice, width));
  return lines;
}

let snapshot: Snapshot | null = null;
let link: LinkState = LINK_DOWN;
let selectedKey: string | null = null;
/** Remembered so a selection that disappears falls back to the nearest surviving row. */
let selectedIndex = 0;
let notice: string | null = null;
let restored = false;
let quitting = false;

function selectRow(rows: Row[], index: number): void {
  if (rows.length === 0) {
    selectedKey = null;
    selectedIndex = 0;
    return;
  }
  selectedIndex = clamp(index, 0, rows.length - 1);
  selectedKey = rows[selectedIndex]?.key ?? null;
}

function paint(): void {
  if (restored) return;
  const frame = [CURSOR_HOME];
  for (const line of buildLines({ snapshot, link, selectedKey, notice })) {
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
  const rows = rowsFor(state);
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

/** The daemon broadcasts on session change only, so a control change is read back
 *  explicitly rather than waiting for a push that may be minutes away. */
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

function nextMode(current: GateMode): GateMode {
  const index = GATE_MODES.indexOf(current);
  return GATE_MODES[(index + 1) % GATE_MODES.length] ?? current;
}

function selectedRow(state: DaemonState): Row | null {
  return rowsFor(state).find((row) => row.key === selectedKey) ?? null;
}

function adjustSelected(state: DaemonState, direction: 1 | -1): void {
  const row = selectedRow(state);
  if (!row) return;
  if (row.kind === 'session') {
    // Directional rather than a toggle: `setMute` is idempotent, so a held key settles on
    // the state the arrow means instead of flapping.
    void command('/mute', { sessionId: row.session.sessionId, muted: direction === 1 });
    return;
  }
  const value = nextSetting(row.spec.key, settingValue(state.config, row.spec.key), direction);
  if (value !== null) void command('/config', { key: row.spec.key, value });
}

function onKey(key: string): void {
  if (key === KEY_QUIT || key === KEY_INTERRUPT) {
    quitting = true;
    restoreTerminal();
    process.exit(0);
  }
  if (!snapshot) return;
  const { state } = snapshot;
  const rows = rowsFor(state);
  if (KEYS_SELECT_PREVIOUS.some((candidate) => candidate === key)) {
    selectRow(rows, selectedIndex - 1);
    paint();
    return;
  }
  if (KEYS_SELECT_NEXT.some((candidate) => candidate === key)) {
    selectRow(rows, selectedIndex + 1);
    paint();
    return;
  }
  if (KEYS_DECREASE.some((candidate) => candidate === key)) {
    adjustSelected(state, -1);
    return;
  }
  if (KEYS_INCREASE.some((candidate) => candidate === key)) {
    adjustSelected(state, 1);
    return;
  }
  if (key === KEY_TOGGLE_MUTE || KEYS_ACTIVATE.some((candidate) => candidate === key)) {
    const row = selectedRow(state);
    if (row?.kind === 'session') {
      void command('/mute', { sessionId: row.session.sessionId, muted: !row.session.muted });
    } else if (row && key !== KEY_TOGGLE_MUTE) {
      adjustSelected(state, 1);
    }
    return;
  }
  if (key === KEY_TOGGLE_MODE) {
    void command(`/mode?mode=${nextMode(state.mode)}`);
    return;
  }
  if (key === KEY_TOGGLE_SIMULATION) {
    void command(`/simulate?running=${!state.simulating}`);
    return;
  }
  const step = KEYS_FADE_UP.some((candidate) => candidate === key)
    ? FADE_STEP_SECONDS
    : KEYS_FADE_DOWN.some((candidate) => candidate === key)
      ? -FADE_STEP_SECONDS
      : 0;
  if (step !== 0) {
    const fade = clamp(state.fadeSeconds + step, FADE_MIN_SECONDS, FADE_MAX_SECONDS);
    void command(`/mode?fade=${fade}`);
  }
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

/** No request timeout: the stream is long-lived by design, and an unreachable daemon
 *  fails the connect immediately. */
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

/** Polls until the daemon answers again, so a restart underneath the dashboard shows as
 *  a wait rather than an exit. SSE is resumed as soon as one reply arrives. */
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
    process.exit(0);
  });
}
for (const failure of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(failure, (error: unknown) => {
    restoreTerminal();
    console.error(error);
    process.exit(EXIT_FAILURE);
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
