#!/usr/bin/env node
import { existsSync, appendFileSync } from 'node:fs';
import { startDaemon, listTracks } from '../src/daemon.ts';
import { installHooks, uninstallHooks, installedHookPath } from '../src/install.ts';
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
  console.log(`Hooks: ${existsSync(hookPath) ? `installed at ${hookPath}` : 'not installed'}`);
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

/** The daemon can be holding the user's audio muted, and a mute that outlives the
 *  process is invisible and recoverable only through Task Manager. Every way this
 *  process can end therefore goes through one teardown, and it runs once: a second
 *  signal, or an exception thrown while shutting down, must not restart it. On
 *  Windows the console close is `SIGHUP` and Ctrl+Break is `SIGBREAK`, neither of
 *  which takes the POSIX `SIGTERM` path, and the close window is short. */
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

/** One terminal, both halves: the daemon in this process and the dashboard on top of it.
 *  The daemon's output is diverted to a file first, because a stray line of stdout lands
 *  in the middle of a rendered frame. An already-running daemon is attached to rather
 *  than fought over, and in that case quitting the dashboard leaves it playing. */
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
    /** Guards the gap before the dashboard loads and installs its own handlers. Both
     *  route through `runShutdown`, which runs the teardown once however often it is
     *  asked. */
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
  case 'install':
    console.log(`Installed hooks -> ${installHooks()}`);
    console.log('Open a NEW Copilot CLI session: hooks load only at session start.');
    break;
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
  // Imported for its side effects: the dashboard takes over the terminal on load, and it
  // is loaded lazily so the other commands never pay for it or touch raw mode.
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
