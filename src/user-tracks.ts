import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { playlistsDir } from './paths.ts';
import {
  PLAYABLE_FILE_PATTERN,
  PLAYLIST_README,
  PLAYLIST_EXAMPLE,
  PLAYLIST_BUNDLED,
} from './constants.ts';

/** Created eagerly at startup: a folder the user is pointed at has to already exist, or
 *  the instruction to drop files into it is a dead end. The README and the empty example
 *  playlist are written for the same reason — a folder convention nobody can see is not a
 *  convention. Neither is overwritten, so notes a user adds to either one survive. */
export function ensurePlaylistsDir(): string {
  const dir = playlistsDir();
  mkdirSync(join(dir, PLAYLIST_EXAMPLE), { recursive: true });
  const readme = join(dir, PLAYLIST_README);
  if (!existsSync(readme)) writeFileSync(readme, README_TEXT);
  return dir;
}

/** Files dropped straight into `playlists/` rather than into a playlist. Supported so a
 *  user who ignores the folder convention still gets their music played. */
export function listUserTracks(): string[] {
  const dir = playlistsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PLAYABLE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Every direct subfolder is a playlist, including an empty one. Listing an empty folder
 *  is deliberate: the example playlist ships empty, and hiding it until it had contents
 *  would make the README describe something the user cannot find. Only one level deep —
 *  a playlist is a folder of files, not a tree to navigate.
 *
 *  `bundled` is excluded here and listed separately, because its tracks keep bare ids so
 *  the licence records keyed by filename still find them. */
export function listUserPlaylists(): string[] {
  const dir = playlistsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== PLAYLIST_BUNDLED)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function listUserPlaylistTracks(playlist: string): string[] {
  // Membership check first: it is what stops a name like `..` being read as a folder.
  if (!listUserPlaylists().includes(playlist)) return [];
  const dir = join(playlistsDir(), playlist);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PLAYABLE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}


const README_TEXT = `# Your music

Each folder in here is a playlist. To make one, add a folder and put \`.mid\`, \`.midi\`,
\`.mp3\` or \`.wav\` files in it — that is the whole convention, and it takes effect right
away with no restart.

    playlists/
      bundled/       <- the music that ships with LLMFM
      playlist1/     <- add your files here, or make your own folder beside it
      loose.mid      <- files dropped straight in here still play

Folders one level deep only. Leave \`bundled\` alone if you can: every file in it is
listed in \`bundled/tracks.json\` with the licence it is redistributed under, and a test
checks that record still matches the bytes.

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
