#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { startDaemon, listTracks } from '../src/daemon.ts';
import { installHooks, uninstallHooks, installedHookPath } from '../src/install.ts';
import { DAEMON_URL } from '../src/constants.ts';

const USAGE = `LLMFM — radio for your coding agents

  node bin/llmfm.ts start [track.mid]   run the daemon
  node bin/llmfm.ts install             install Copilot CLI hooks
  node bin/llmfm.ts uninstall           remove them
  node bin/llmfm.ts status              report daemon and hook state
  node bin/llmfm.ts tracks              list bundled tracks
  node bin/llmfm.ts tui                 live dashboard, run in a second terminal`;

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

const [command, argument] = process.argv.slice(2);

switch (command) {
  case 'start': {
    const daemon = await startDaemon(argument ? { track: argument } : {}).catch(
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        return process.exit(1);
      },
    );
    /** The daemon can be holding the user's audio muted, and a mute that outlives the
     *  process is invisible and recoverable only through Task Manager. Every way this
     *  process can end therefore goes through one teardown, and it runs once: a second
     *  signal, or an exception thrown while shutting down, must not restart it. On
     *  Windows the console close is `SIGHUP` and Ctrl+Break is `SIGBREAK`, neither of
     *  which takes the POSIX `SIGTERM` path, and the close window is short. */
    let shutdown: Promise<void> | null = null;
    const requestShutdown = (code: number, reason?: unknown): void => {
      if (reason !== undefined) console.error(reason);
      shutdown ??= daemon
        .stop()
        .catch((error: unknown) => console.error(`Shutdown failed: ${String(error)}`))
        .finally(() => process.exit(code));
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
      process.once(signal, () => requestShutdown(0));
    }
    process.once('uncaughtException', (error: unknown) => requestShutdown(1, error));
    process.once('unhandledRejection', (reason: unknown) => requestShutdown(1, reason));
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
  default:
    console.log(USAGE);
}
