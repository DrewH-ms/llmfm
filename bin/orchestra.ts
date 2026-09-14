import { existsSync } from 'node:fs';
import { startDaemon, listTracks } from '../src/daemon.ts';
import { installHooks, uninstallHooks, installedHookPath } from '../src/install.ts';
import { DAEMON_URL } from '../src/constants.ts';

const USAGE = `Agent Orchestra — hold music for your coding agent

  node bin/orchestra.ts start [track.mid]   run the daemon
  node bin/orchestra.ts install             install Copilot CLI hooks
  node bin/orchestra.ts uninstall           remove them
  node bin/orchestra.ts status              report daemon and hook state
  node bin/orchestra.ts tracks              list bundled tracks`;

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
    const daemon = await startDaemon(argument ? { track: argument } : {});
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        void daemon.stop().then(() => process.exit(0));
      });
    }
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
  default:
    console.log(USAGE);
}
