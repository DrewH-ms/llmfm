import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_CONFIG_NAME = 'agent-orchestra.json';
const SCRIPT_PATH_TOKEN = 'HOOK_SCRIPT_PATH';

export function copilotHooksDir(): string {
  const home = process.env.COPILOT_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.copilot');
  return join(home, 'hooks');
}

export function installedHookPath(): string {
  return join(copilotHooksDir(), HOOK_CONFIG_NAME);
}

export function installHooks(): string {
  const template = readFileSync(join(PROJECT_ROOT, 'hooks', 'agent-orchestra.command.json'), 'utf8');
  const scriptPath = join(PROJECT_ROOT, 'hooks', 'notify.js');
  const config = template.replaceAll(SCRIPT_PATH_TOKEN, JSON.stringify(scriptPath).slice(1, -1));

  const target = installedHookPath();
  mkdirSync(copilotHooksDir(), { recursive: true });
  writeFileSync(target, config);
  return target;
}

/** Uninstalling must fully restore the prior state, so it removes only our own file. */
export function uninstallHooks(): string | null {
  const target = installedHookPath();
  if (!existsSync(target)) return null;
  rmSync(target);
  return target;
}
