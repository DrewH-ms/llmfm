import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { copilotHooksDir } from './install.ts';
import { PLAYABLE_FILE_PATTERN, PLAYLIST_README, PLAYLIST_EXAMPLE } from './constants.ts';

/** Kept local rather than shared with the daemon's copy while another agent holds that
 *  file; they should be folded together once the tree is quiet. */
const USER_TRACKS_DIR_NAME = 'llmfm-tracks';

/** Sits beside the config rather than inside the install, so tracks a user added survive
 *  the repo moving or being reinstalled, and are never mistaken for shipped files, which
 *  carry a verified licence these do not. */
export function userTracksDir(): string {
  return join(dirname(copilotHooksDir()), USER_TRACKS_DIR_NAME);
}

/** Created eagerly at startup: a folder the user is pointed at has to already exist, or
 *  the instruction to drop files into it is a dead end. The README and the empty example
 *  playlist are written for the same reason — a folder convention nobody can see is not a
 *  convention. Neither is overwritten, so notes a user adds to either one survive. */
export function ensureUserTracksDir(): string {
  const dir = userTracksDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, PLAYLIST_EXAMPLE), { recursive: true });
  const readme = join(dir, PLAYLIST_README);
  if (!existsSync(readme)) writeFileSync(readme, README_TEXT);
  return dir;
}

export function listUserTracks(): string[] {
  const dir = userTracksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PLAYABLE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Every direct subfolder is a playlist, including an empty one. Listing an empty folder
 *  is deliberate: the example playlist ships empty, and hiding it until it had contents
 *  would make the README describe something the user cannot find. Only one level deep —
 *  a playlist is a folder of files, not a tree to navigate. */
export function listUserPlaylists(): string[] {
  const dir = userTracksDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function listUserPlaylistTracks(playlist: string): string[] {
  // Membership check first: it is what stops a name like `..` being read as a folder.
  if (!listUserPlaylists().includes(playlist)) return [];
  const dir = join(userTracksDir(), playlist);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PLAYABLE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}


const README_TEXT = `# Your tracks

Drop \`.mid\`, \`.midi\`, \`.mp3\` or \`.wav\` files straight into this folder and they become
playable right away — no restart.

## Playlists

Each folder in here is a playlist. To make one, add a folder and put files in it:

    llmfm-tracks/
      something-you-added.mid    <- loose files are always available
      playlist1/                 <- a playlist (this one starts empty)
        march.mid
        practice-take.wav

Folders one level deep only. \`bundled\` is the music that ships with LLMFM; it is always
offered and does not live here, so there is nothing to copy.

Choosing a playlist limits what plays and what the daemon rotates to when a track ends.
An empty playlist falls back to the bundled music rather than going quiet, because in
LLMFM silence means an agent needs you — a setting must never be able to fake that.

## A note on mp3 and wav

A recording is one finished mix, so there are no parts to hand out: it cannot give each
agent its own instrument the way a MIDI score can. In ensemble mode a recording therefore
plays whenever any agent that is not muted and is not a subagent is working, and falls
silent when none is. Outside ensemble mode it follows whatever "Play when" is set to,
like any other track.
`;
