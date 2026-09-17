import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { HOOK_EVENTS } from './constants.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_CONFIG_NAME = 'llmfm.json';
/** The CLI kills a hook that outruns this, and it runs on every tool call. */
const HOOK_TIMEOUT_SECONDS = 5;

export function copilotHooksDir(): string {
  const home = process.env.COPILOT_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.copilot');
  return join(home, 'hooks');
}

export function installedHookPath(): string {
  return join(copilotHooksDir(), HOOK_CONFIG_NAME);
}

/** Generated from `HOOK_EVENTS`: a hand-edited config drifts silently, and the symptom is a part that never un-mutes. */
export function installHooks(): string {
  const scriptPath = join(PROJECT_ROOT, 'hooks', 'notify.js');
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ type: 'command', exec: 'node', args: [scriptPath, event], timeoutSec: HOOK_TIMEOUT_SECONDS }],
    ]),
  );

  const target = installedHookPath();
  mkdirSync(copilotHooksDir(), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`);
  return target;
}

/** Uninstalling must fully restore the prior state, so it removes only our own file. */
export function uninstallHooks(): string | null {
  const target = installedHookPath();
  if (!existsSync(target)) return null;
  rmSync(target);
  return target;
}
