import { DAEMON_URL, GATE_MODES } from '../src/constants.ts';
import type { GateMode } from '../src/constants.ts';
import { SESSION_SOURCES } from '../src/types.ts';
import type { DaemonState, MidiStatus, SessionView, TransportState } from '../src/types.ts';

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

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;
const MIN_COLUMNS = 32;
const MAX_COLUMNS = 120;
const VOICE_COLUMN_WIDTH = 16;
const LABEL_COLUMN_WIDTH = 16;
const BADGE_TEXT_SOUNDING = ' SOUNDING ';
const BADGE_TEXT_SILENT = '  silent  ';
const MARKER_SOUNDING = '█ ';
const MARKER_SILENT = '· ';
const UNVOICED_TEXT = '(unvoiced)';
const PROGRESS_FILLED = '█';
const PROGRESS_EMPTY = '░';
const PROGRESS_MIN_WIDTH = 8;
const CLOCK_COLUMN_WIDTH = 16;
const ELLIPSIS = '…';
const SECONDS_PER_MINUTE = 60;
const SECOND_DIGITS = 2;
const FADE_DECIMALS = 2;
/** Header, transport, midi, control and footer lines that sessions must not overrun. */
const CHROME_LINE_COUNT = 9;

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
const KEY_TOGGLE_MODE = 'm';
const KEY_TOGGLE_SIMULATION = 's';
const KEYS_FADE_UP = ['+', '='] as const;
const KEYS_FADE_DOWN = ['-', '_'] as const;
const KEY_HINTS = '[m] mode   [-/+] fade   [s] simulate   [q] quit';

const EXIT_FAILURE = 1;

const LINK_LIVE = 'live';
const LINK_POLLING = 'polling';
const LINK_DOWN = 'daemon down — retrying';

const LINK_STATES = [LINK_LIVE, LINK_POLLING, LINK_DOWN] as const;
type LinkState = (typeof LINK_STATES)[number];

type Segment = { text: string; style: string };

type Snapshot = { state: DaemonState; receivedAt: number };

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
  const source = SESSION_SOURCES.find((candidate) => candidate === value['source']);
  if (typeof sessionId !== 'string' || typeof label !== 'string' || !source) return null;
  if (typeof working !== 'boolean' || typeof blockedMidTurn !== 'boolean') return null;
  if (typeof audible !== 'boolean' || typeof updatedAt !== 'number') return null;
  if (cwd !== null && typeof cwd !== 'string') return null;
  if (voiceName !== null && typeof voiceName !== 'string') return null;
  return { sessionId, working, cwd, label, source, blockedMidTurn, updatedAt, voiceName, audible };
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
  return { mode, fadeSeconds, simulating, track, transport, midi, sessions };
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

function progressBar(transport: TransportState, width: number): string {
  const span = Math.max(width, PROGRESS_MIN_WIDTH);
  const fraction = transport.duration > 0 ? clamp(transport.position / transport.duration, 0, 1) : 0;
  const filled = Math.round(span * fraction);
  return `${PROGRESS_FILLED.repeat(filled)}${PROGRESS_EMPTY.repeat(span - filled)}`;
}

function sessionLine(session: SessionView): Segment[] {
  const badge = session.audible ? BADGE_TEXT_SOUNDING : BADGE_TEXT_SILENT;
  return [
    { text: session.audible ? MARKER_SOUNDING : MARKER_SILENT, style: session.audible ? FG_GREEN : FG_GREY },
    { text: fit(session.label, LABEL_COLUMN_WIDTH), style: session.audible ? STYLE_BOLD : STYLE_DIM },
    { text: ' ', style: STYLE_NONE },
    {
      text: fit(session.voiceName ?? UNVOICED_TEXT, VOICE_COLUMN_WIDTH),
      style: session.voiceName ? FG_CYAN : STYLE_DIM,
    },
    { text: ' ', style: STYLE_NONE },
    { text: badge, style: session.audible ? BADGE_SOUNDING : BADGE_SILENT },
  ];
}

function transportSegments(transport: TransportState, width: number): Segment[] {
  const clock = `${formatClock(transport.position)} / ${formatClock(transport.duration)}`;
  const bar = progressBar(transport, width - CLOCK_COLUMN_WIDTH);
  return [
    { text: clock.padEnd(CLOCK_COLUMN_WIDTH), style: STYLE_BOLD },
    { text: bar, style: transport.playing ? FG_GREEN : FG_YELLOW },
  ];
}

function buildLines(snapshot: Snapshot | null, link: LinkState): string[] {
  const width = clamp(process.stdout.columns ?? FALLBACK_COLUMNS, MIN_COLUMNS, MAX_COLUMNS);
  if (!snapshot) {
    return [
      composeLine([{ text: 'LLMFM', style: STYLE_BOLD }], width),
      composeLine([{ text: link, style: FG_RED }], width),
      '',
      composeLine([{ text: KEY_HINTS, style: STYLE_DIM }], width),
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
    composeLine(
      [
        { text: 'mode ', style: STYLE_DIM },
        { text: state.mode, style: FG_CYAN },
        { text: '   fade ', style: STYLE_DIM },
        { text: `${state.fadeSeconds.toFixed(FADE_DECIMALS)}s`, style: FG_CYAN },
        { text: '   sim ', style: STYLE_DIM },
        { text: state.simulating ? 'on' : 'off', style: state.simulating ? FG_YELLOW : FG_GREY },
        { text: '   link ', style: STYLE_DIM },
        { text: link, style: link === LINK_LIVE ? FG_GREEN : FG_RED },
      ],
      width,
    ),
    '',
  ];

  const room = Math.max((process.stdout.rows ?? FALLBACK_ROWS) - CHROME_LINE_COUNT, 1);
  const shown = state.sessions.slice(0, room);
  for (const session of shown) lines.push(composeLine(sessionLine(session), width));
  if (state.sessions.length > shown.length) {
    const hidden = state.sessions.length - shown.length;
    lines.push(composeLine([{ text: `  +${hidden} more`, style: STYLE_DIM }], width));
  }
  if (state.sessions.length === 0) {
    lines.push(composeLine([{ text: '  no sessions', style: STYLE_DIM }], width));
  }

  lines.push('');
  lines.push(composeLine([{ text: KEY_HINTS, style: STYLE_DIM }], width));
  return lines;
}

let snapshot: Snapshot | null = null;
let link: LinkState = LINK_DOWN;
let restored = false;
let quitting = false;

function paint(): void {
  if (restored) return;
  const frame = [CURSOR_HOME];
  for (const line of buildLines(snapshot, link)) frame.push(line, ERASE_TO_LINE_END, '\n');
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
async function command(path: string): Promise<void> {
  try {
    await fetch(`${DAEMON_URL}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const state = await fetchState();
    if (state) applyState(state, link);
  } catch {
    link = LINK_DOWN;
    paint();
  }
}

function nextMode(current: GateMode): GateMode {
  const index = GATE_MODES.indexOf(current);
  return GATE_MODES[(index + 1) % GATE_MODES.length] ?? current;
}

function onKey(key: string): void {
  if (key === KEY_QUIT || key === KEY_INTERRUPT) {
    quitting = true;
    restoreTerminal();
    process.exit(0);
  }
  if (!snapshot) return;
  const { state } = snapshot;
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
