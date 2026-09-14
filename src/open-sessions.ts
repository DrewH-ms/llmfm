import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OPEN_SESSIONS_POLL_MS } from './constants.ts';
import type { SessionRegistry } from './sessions.ts';

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
function readOpenSessions(filePath: string): { sessionId: string; working: boolean }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const entries: { sessionId: string; working: boolean }[] = [];
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const working = (value as Record<string, unknown>).working;
    if (typeof working !== 'boolean') continue;
    entries.push({ sessionId, working });
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
  // Polling beats fs.watch: the CLI rewrites this file atomically via rename, which
  // leaves a watcher bound to the replaced file and silently blind.
  const timer = setInterval(poll, OPEN_SESSIONS_POLL_MS);

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
