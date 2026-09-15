import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  CONFIG_FILE_NAME,
  CONFIG_POLL_MS,
  HANDLE_ID_LENGTH,
} from './constants.ts';
import type { GatePolicy, PromptGapMode, SilenceMode } from './constants.ts';
import { SETTING_DEFAULTS, coerceSetting } from './settings.ts';
import { copilotHooksDir } from './install.ts';
import type { Session } from './types.ts';

export type LlmfmConfig = {
  /** Handles whose sessions take no voice. See `matchesHandle` for what a handle matches. */
  muted: string[];
  promptGap: PromptGapMode;
  gate: GatePolicy;
  silenceMode: SilenceMode;
  masterVolume: number;
  idleDropoutMinutes: number;
  startupMotif: boolean;
};

export type ConfigStore = {
  current(): LlmfmConfig;
  /** Idempotent by design: a toggle can land inverted when two clients race or a key
   *  repeats, and the caller always knows the state it wants. */
  setMute(options: { session: SessionHandle; muted: boolean; preferLabel: boolean }): void;
  /** Applies one setting by key, validated against its spec. Returns false for an unknown
   *  key or a value the spec rejects, which is what the HTTP layer turns into a 400. */
  setSetting(key: string, value: unknown): boolean;
  /** Re-reads the file if it changed on disk, so hand edits apply without a restart. */
  start(): void;
  stop(): void;
  onChange(listener: () => void): () => void;
};

/** Just enough of a session to name it. Keeps this module free of session state. */
export type SessionHandle = { label: string; sessionId: string };

const DEFAULT_CONFIG: LlmfmConfig = { muted: [], ...SETTING_DEFAULTS };

export function configPath(): string {
  return join(dirname(copilotHooksDir()), CONFIG_FILE_NAME);
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
  // Every setting is validated through its own spec, so a hand-edited file with one bad
  // value keeps the rest rather than reverting wholesale.
  const settings = { ...SETTING_DEFAULTS } as Record<string, unknown>;
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    const coerced = coerceSetting(key, record[key]);
    if (coerced !== null) settings[key] = coerced;
  }
  return { ...(settings as Omit<LlmfmConfig, 'muted'>), muted };
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
      write({ ...config, [key]: coerced });
      return true;
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
