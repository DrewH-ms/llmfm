import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { copilotHooksDir } from './install.ts';

/** Kept local rather than shared with the daemon's copy while another agent holds that
 *  file; they should be folded together once the tree is quiet. */
const MIDI_FILE_PATTERN = /\.midi?$/i;
const USER_TRACKS_DIR_NAME = 'llmfm-tracks';

/** Sits beside the config rather than inside the install, so tracks a user added survive
 *  the repo moving or being reinstalled, and are never mistaken for shipped files, which
 *  carry a verified licence these do not. */
export function userTracksDir(): string {
  return join(dirname(copilotHooksDir()), USER_TRACKS_DIR_NAME);
}

/** Created eagerly at startup: a folder the user is pointed at has to already exist, or
 *  the instruction to drop files into it is a dead end. */
export function ensureUserTracksDir(): string {
  const dir = userTracksDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listUserTracks(): string[] {
  const dir = userTracksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => MIDI_FILE_PATTERN.test(file))
    .sort((a, b) => a.localeCompare(b));
}
