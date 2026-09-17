import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPEN_SESSIONS_POLL_MS } from './constants.ts';
import type { SessionRegistry } from './sessions.ts';
import type { OpenSessionEntry } from './types.ts';

const COPILOT_DIR_NAME = '.copilot';
const OPEN_SESSIONS_FILE_NAME = 'open-sessions-state.json';

export type OpenSessionsWatcher = { stop(): void };

function openSessionsPath(): string {
  const copilotHome =
    process.env.COPILOT_HOME ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), COPILOT_DIR_NAME);
  return join(copilotHome, OPEN_SESSIONS_FILE_NAME);
}

/** Null when the file is absent, mid-rewrite, or not the shape we expect — all normal. */
function readOpenSessions(filePath: string): OpenSessionEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const entries: OpenSessionEntry[] = [];
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const working = record['working'];
    if (typeof working !== 'boolean') continue;
    const stamp = record['refreshedAt'];
    const refreshedAt = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
    entries.push({
      sessionId,
      working,
      refreshedAt: Number.isFinite(refreshedAt) ? refreshedAt : null,
    });
  }
  return entries;
}

export function watchOpenSessions(registry: SessionRegistry): OpenSessionsWatcher {
  const filePath = openSessionsPath();

  const poll = (): void => {
    const entries = readOpenSessions(filePath);
    if (entries) registry.applyFileState(entries);
  };

  poll();
  // Polling beats fs.watch: the CLI rewrites this file atomically via rename, leaving a watcher silently blind.
  const timer = setInterval(poll, OPEN_SESSIONS_POLL_MS);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
