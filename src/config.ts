import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  CONFIG_FILE_NAME,
  CONFIG_POLL_MS,
  DEFAULT_PROMPT_GAP,
  HANDLE_ID_LENGTH,
  PROMPT_GAP_MODES,
} from './constants.ts';
import type { PromptGapMode } from './constants.ts';
import { copilotHooksDir } from './install.ts';
import type { Session } from './types.ts';

export type LlmfmConfig = {
  /** Handles whose sessions take no voice. See `matchesHandle` for what a handle matches. */
  muted: string[];
  promptGap: PromptGapMode;
};

export type ConfigStore = {
  current(): LlmfmConfig;
  /** Toggles a handle's mute state and persists it. Returns the new state. */
  toggleMute(handle: string): boolean;
  /** Re-reads the file if it changed on disk, so hand edits apply without a restart. */
  start(): void;
  stop(): void;
  onChange(listener: () => void): () => void;
};

const DEFAULT_CONFIG: LlmfmConfig = { muted: [], promptGap: DEFAULT_PROMPT_GAP };

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
  const promptGap = PROMPT_GAP_MODES.find((mode) => mode === record['promptGap']);
  return { muted, promptGap: promptGap ?? DEFAULT_PROMPT_GAP };
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
    toggleMute(handle: string): boolean {
      const trimmed = handle.trim();
      if (trimmed.length === 0) return false;
      const existing = config.muted.find((rule) => rule.toLowerCase() === trimmed.toLowerCase());
      const muted = existing
        ? config.muted.filter((rule) => rule !== existing)
        : [...config.muted, trimmed];
      write({ ...config, muted });
      return existing === undefined;
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
