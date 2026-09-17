import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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
  /** What a sub-agent's work counts for: nothing, the session that dispatched it, or its own voice. */
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
  /** Never true unless `audio` is `duck` — see `coupleBluetoothToDuck`; the device itself lives in the bridge's claim file. */
  bluetoothReceive: boolean;
  /** Valid values are whatever playlist folders exist now, so it is validated against disk, not a fixed list. */
  playlist: string;
};

export type ConfigStore = {
  current(): LlmfmConfig;
  /** Idempotent by design: a toggle can land inverted when two clients race or a key repeats. */
  setMute(options: { session: SessionHandle; muted: boolean; preferLabel: boolean }): void;
  /** False for an unknown key or a value the spec rejects, which the HTTP layer turns into a 400. */
  setSetting(key: string, value: unknown): boolean;
  /** Validated by the caller against the playlists that exist, so this module stays free of the filesystem. */
  setPlaylist(name: string): void;
  /** Re-reads the file if it changed on disk, so hand edits apply without a restart. */
  start(): void;
  stop(): void;
  onChange(listener: () => void): () => void;
};

/** Just enough of a session to name it. Keeps this module free of session state. */
export type SessionHandle = { label: string; sessionId: string };

const DEFAULT_CONFIG: LlmfmConfig = { muted: [], playlist: DEFAULT_PLAYLIST, ...SETTING_DEFAULTS };

/** Moves settings left in Copilot's own directory by an older version; skipped when LLMFM_HOME is set, or a test would move the real user's config. */
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

/** `{ audio: 'midi', bluetoothReceive: true }` would play the phone ungated under our score; `changed` names the key the user just moved, so the other yields. */
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

/** A label survives restarts where the session id does not; a session known only from the open-sessions file has no cwd, so its label is already the short id. */
export function handleFor(session: { label: string; sessionId: string }): string {
  const id = shortId(session.sessionId);
  return session.label === id ? id : `${session.label} (${id})`;
}

/** Matches the whole handle, the label alone, or an id prefix; the label form keeps muting a repo across restarts. */
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

/** The file is user-editable, so a malformed field falls back to its default rather than taking the daemon down. */
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
  // Per-key validation: a hand-edited file with one bad value keeps the rest.
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
    // Replaced whole via a same-volume temp: a kill mid-write leaves unparseable JSON and the next start silently loses every setting.
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, raw);
    try {
      renameSync(tempPath, path);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
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
      // Clearing every matching rule, not just the one we would have written, is what unmutes a rule the user typed by hand.
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
