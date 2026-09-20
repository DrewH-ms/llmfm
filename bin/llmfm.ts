#!/usr/bin/env node
import { existsSync, appendFileSync } from 'node:fs';
import { startDaemon, listTracks } from '../src/daemon.ts';
import { installHooks, uninstallHooks, installedHookPath, hooksPointHere } from '../src/install.ts';
import { DAEMON_URL, HOOK_REQUEST_TIMEOUT_MS } from '../src/constants.ts';
import { logPath } from '../src/paths.ts';
import { onShutdown, runShutdown } from '../src/shutdown.ts';

const USAGE = `LLMFM — radio for your coding agents

  node bin/llmfm.ts                     start the daemon and open the dashboard
  node bin/llmfm.ts start [track.mid]   run the daemon alone
  node bin/llmfm.ts install             install Copilot CLI hooks
  node bin/llmfm.ts uninstall           remove them
  node bin/llmfm.ts status              report daemon and hook state
  node bin/llmfm.ts tracks              list bundled tracks
  node bin/llmfm.ts tui                 dashboard alone, against a running daemon`;

async function reportStatus(): Promise<void> {
  const hookPath = installedHookPath();
  if (!existsSync(hookPath)) console.log('Hooks: not installed');
  else if (hooksPointHere()) console.log(`Hooks: installed at ${hookPath}`);
  else {
    console.log(`Hooks: installed at ${hookPath}, but pointing at another copy of LLMFM.`);
    console.log('Run `node bin/llmfm.ts install` here, then open a NEW Copilot CLI session.');
  }
  try {
    const response = await fetch(`${DAEMON_URL}/state`);
    console.log(`Daemon: running at ${DAEMON_URL}`);
    console.log(JSON.stringify(await response.json(), null, 2));
  } catch {
    console.log(`Daemon: not running at ${DAEMON_URL}`);
  }
}

async function daemonIsRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${DAEMON_URL}/state`, {
      signal: AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** One teardown on every exit path, run once: on Windows console close is `SIGHUP` and Ctrl+Break `SIGBREAK`, not `SIGTERM`. */
function exitThrough(stop: () => Promise<void>): void {
  let shutdown: Promise<void> | null = null;
  const requestShutdown = (code: number, reason?: unknown): void => {
    if (reason !== undefined) console.error(reason);
    shutdown ??= stop()
      .catch((error: unknown) => console.error(`Shutdown failed: ${String(error)}`))
      .finally(() => process.exit(code));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.once(signal, () => requestShutdown(0));
  }
  process.once('uncaughtException', (error: unknown) => requestShutdown(1, error));
  process.once('unhandledRejection', (reason: unknown) => requestShutdown(1, reason));
}

function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  return process.exit(1);
}

/** Daemon plus dashboard in one terminal; daemon output goes to a file because stray stdout corrupts a frame. */
async function runBoth(track: string | undefined): Promise<void> {
  if (!(await daemonIsRunning())) {
    const file = logPath();
    const write = (...parts: unknown[]): void => {
      try {
        appendFileSync(file, `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`);
      } catch {
        /* Losing a log line must never take the music down. */
      }
    };
    console.log = write;
    console.warn = write;
    console.error = write;
    const daemon = await startDaemon(track ? { track } : {}).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.stderr.write(`Daemon log: ${file}\n`);
      return process.exit(1);
    });
    onShutdown(() => daemon.stop());
    /** Guards the gap before the dashboard installs its own handlers; `runShutdown` runs the teardown once. */
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
      process.once(signal, () => void runShutdown().finally(() => process.exit(0)));
    }
  }
  await import('../tui/dashboard.ts');
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case 'start': {
    const daemon = await startDaemon(argument ? { track: argument } : {}).catch(fail);
    exitThrough(() => daemon.stop());
    break;
  }
  case 'install': {
    // The launcher runs this on every start, so a config already pointing here must stay quiet.
    if (argument === '--if-stale' && hooksPointHere()) break;
    console.log(`Installed hooks -> ${installHooks()}`);
    console.log('Open a NEW Copilot CLI session: hooks load only at session start.');
    break;
  }
  case 'uninstall': {
    const removed = uninstallHooks();
    console.log(removed ? `Removed ${removed}` : 'Nothing to remove.');
    break;
  }
  case 'status':
    await reportStatus();
    break;
  case 'tracks':
    for (const track of listTracks()) console.log(track);
    break;
  // Loaded lazily so the other commands never pay for the dashboard or touch raw mode.
  case 'tui':
    await import('../tui/dashboard.ts');
    break;
  case undefined:
    await runBoth(undefined);
    break;
  default:
    if (command.endsWith('.mid')) await runBoth(command);
    else console.log(USAGE);
}
