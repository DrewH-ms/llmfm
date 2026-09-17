import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  CONFIG_FILE_NAME,
  CONFIG_POLL_MS,
  DEFAULT_PLAYLIST,
  HANDLE_ID_LENGTH,
} from './constants.ts';
import type {
  AudioMode,
  AutoplayMode,
  GateMode,
  GatePolicy,
  PromptGapMode,
  SilenceMode,
  SubagentMode,
} from './constants.ts';
import { SETTING_DEFAULTS, coerceSetting } from './settings.ts';
import { copilotHooksDir } from './install.ts';
import { configPath } from './paths.ts';
export { configPath };
import type { Session } from './types.ts';

export type LlmfmConfig = {
  /** Handles whose sessions take no voice. See `matchesHandle` for what a handle matches. */
  muted: string[];
  promptGap: PromptGapMode;
  /** What a sub-agent's work counts for: nothing, the session that dispatched it, or a
   *  voice of its own. */
  subagents: SubagentMode;
  gate: GatePolicy;
  /** Whether an instrument sounds while its agent works, or only when it needs you. */
  mode: GateMode;
  fadeSeconds: number;
  /** Whether the daemon plays its own score or rides audio it does not own. */
  audio: AudioMode;
  silenceMode: SilenceMode;
  masterVolume: number;
  idleDropoutMinutes: number;
  autoplay: AutoplayMode;
  /** Whether Windows holds an A2DP sink open for the user's phone. The device itself is
   *  machine state and lives in the bridge's claim file, not here. Never true unless
   *  `audio` is `duck` — see `coupleBluetoothToDuck`. */
  bluetoothReceive: boolean;
  startupMotif: boolean;
  /** Which playlist the library is drawn from. Not a spec-driven setting: the valid
   *  values are whatever folders exist right now, so it is validated against the disk
   *  when it is applied rather than against a fixed list. */
  playlist: string;
};

export type ConfigStore = {
  current(): LlmfmConfig;
  /** Idempotent by design: a toggle can land inverted when two clients race or a key
   *  repeats, and the caller always knows the state it wants. */
  setMute(options: { session: SessionHandle; muted: boolean; preferLabel: boolean }): void;
  /** Applies one setting by key, validated against its spec. Returns false for an unknown
   *  key or a value the spec rejects, which is what the HTTP layer turns into a 400. */
  setSetting(key: string, value: unknown): boolean;
  /** Validated by the caller against the playlists that exist, so this module stays free
   *  of the filesystem. */
  setPlaylist(name: string): void;
  /** Re-reads the file if it changed on disk, so hand edits apply without a restart. */
  start(): void;
  stop(): void;
  onChange(listener: () => void): () => void;
};

/** Just enough of a session to name it. Keeps this module free of session state. */
export type SessionHandle = { label: string; sessionId: string };

const DEFAULT_CONFIG: LlmfmConfig = { muted: [], playlist: DEFAULT_PLAYLIST, ...SETTING_DEFAULTS };

/** Settings written by a version that kept them in Copilot's own directory. Moved on
 *  first read rather than left behind, so upgrading does not quietly reset a user's
 *  choices — and so the stale copy cannot later be mistaken for the live one.
 *
 *  Skipped entirely when the home has been redirected. Otherwise a test pointing
 *  LLMFM_HOME at a temp folder would reach into the real `~/.copilot` and move the
 *  user's config out of it, which is exactly what happened once. */
function migrateLegacyConfig(): void {
  if (process.env['LLMFM_HOME'] !== undefined) return;
  const path = configPath();
  if (existsSync(path)) return;
  const legacy = join(dirname(copilotHooksDir()), CONFIG_FILE_NAME);
  if (!existsSync(legacy)) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    renameSync(legacy, path);
  } catch {
    /* A config that will not move is not worth failing startup over. */
  }
}

/** The phone's stream is ours to gate only through duck mode's endpoint mute, so
 *  `{ audio: 'midi', bluetoothReceive: true }` plays the phone ungated underneath our own
 *  score: audio keeps sounding while an agent is blocked, which is the one thing that
 *  cannot happen. `changed` names the key the user just moved, so the other one yields. A
 *  hand-edited file moved neither, and there the explicit opt-in wins over an audio mode
 *  that is merely the default. */
function coupleBluetoothToDuck(
  config: LlmfmConfig,
  changed: 'audio' | 'bluetoothReceive' | null,
): LlmfmConfig {
  if (!config.bluetoothReceive || config.audio === 'duck') return config;
  if (changed === 'audio') return { ...config, bluetoothReceive: false };
  return { ...config, audio: 'duck' };
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, HANDLE_ID_LENGTH);
}

/** What the dashboard prints and the user types: a folder name that survives restarts,
 *  plus enough session id to separate two terminals open on the same repo. Sessions known
 *  only from the open-sessions file have no cwd, so their label is already the short id;
 *  printing it twice would just be noise. */
export function handleFor(session: { label: string; sessionId: string }): string {
  const id = shortId(session.sessionId);
  return session.label === id ? id : `${session.label} (${id})`;
}

/** A rule matches the whole handle, the folder label alone, or a session id prefix. The
 *  label form is the useful one: it keeps muting a repo across restarts, where the id
 *  changes every time. */
export function matchesHandle(rule: string, session: { label: string; sessionId: string }): boolean {
  const candidate = rule.trim().toLowerCase();
  if (candidate.length === 0) return false;
  return (
    candidate === handleFor(session).toLowerCase() ||
    candidate === session.label.toLowerCase() ||
    (candidate.length >= 4 && session.sessionId.toLowerCase().startsWith(candidate))
  );
}

export function isMuted(config: LlmfmConfig, session: Session): boolean {
  return config.muted.some((rule) => matchesHandle(rule, session));
}

/** The file is user-editable, so every field is treated as untrusted and a malformed one
 *  falls back to the default rather than taking the daemon down. */
function parseConfig(raw: string): LlmfmConfig {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return DEFAULT_CONFIG;
  }
  if (typeof payload !== 'object' || payload === null) return DEFAULT_CONFIG;

  const record = payload as Record<string, unknown>;
  const muted = Array.isArray(record['muted'])
    ? record['muted'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const rawPlaylist = record['playlist'];
  const playlist = typeof rawPlaylist === 'string' && rawPlaylist ? rawPlaylist : DEFAULT_PLAYLIST;
  // Every setting is validated through its own spec, so a hand-edited file with one bad
  // value keeps the rest rather than reverting wholesale.
  const settings = { ...SETTING_DEFAULTS } as Record<string, unknown>;
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    const coerced = coerceSetting(key, record[key]);
    if (coerced !== null) settings[key] = coerced;
  }
  return coupleBluetoothToDuck(
    { ...(settings as Omit<LlmfmConfig, 'muted' | 'playlist'>), muted, playlist },
    null,
  );
}

export function createConfigStore(): ConfigStore {
  const listeners = new Set<() => void>();
  let config = DEFAULT_CONFIG;
  let lastRaw = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const read = (): void => {
    const path = configPath();
    if (!existsSync(path)) {
      if (lastRaw === '') return;
      lastRaw = '';
      config = DEFAULT_CONFIG;
      emit();
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return;
    }
    if (raw === lastRaw) return;
    lastRaw = raw;
    config = parseConfig(raw);
    emit();
  };

  const write = (next: LlmfmConfig): void => {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = `${JSON.stringify(next, null, 2)}\n`;
    writeFileSync(path, raw);
    lastRaw = raw;
    config = next;
    emit();
  };

  migrateLegacyConfig();
  read();

  return {
    current: (): LlmfmConfig => config,
    setMute(options: { session: SessionHandle; muted: boolean; preferLabel: boolean }): void {
      const { session, muted, preferLabel } = options;
      // Clearing every rule that matches, rather than the one we would have written, is
      // what makes unmuting work against a rule the user typed by hand.
      const remaining = config.muted.filter((rule) => !matchesHandle(rule, session));
      const next = muted
        ? [...remaining, preferLabel ? session.label : handleFor(session)]
        : remaining;
      if (next.length === config.muted.length && next.every((rule, i) => rule === config.muted[i])) {
        return;
      }
      write({ ...config, muted: next });
    },
    setSetting(key: string, value: unknown): boolean {
      const coerced = coerceSetting(key, value);
      if (coerced === null) return false;
      if (config[key as keyof LlmfmConfig] === coerced) return true;
      const changed = key === 'audio' || key === 'bluetoothReceive' ? key : null;
      write(coupleBluetoothToDuck({ ...config, [key]: coerced }, changed));
      return true;
    },
    setPlaylist(name: string): void {
      if (config.playlist === name) return;
      write({ ...config, playlist: name });
    },
    start(): void {
      if (timer) return;
      timer = setInterval(read, CONFIG_POLL_MS);
      timer.unref?.();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
