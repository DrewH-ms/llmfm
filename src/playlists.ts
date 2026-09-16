/** Playlists are folders, because a folder is a thing a user can make in Explorer without
 *  learning anything. There is no index file to keep in step with the disk: what is in the
 *  folder is what is in the playlist.
 *
 *  `bundled` is a folder like any other. Its tracks keep bare ids rather than
 *  `bundled/name`, because the licence records in `tracks.json` are keyed by filename and
 *  a stored config may already name a track that way. */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLAYABLE_FILE_PATTERN,
  PLAYLIST_ALL,
  PLAYLIST_BUNDLED,
  PLAYLIST_SEPARATOR,
} from './constants.ts';
import { playlistsDir, bundledDir } from './paths.ts';
import { listUserTracks, listUserPlaylists, listUserPlaylistTracks } from './user-tracks.ts';

export type PlaylistInfo = {
  name: string;
  /** The combined view is not a folder, so there is nowhere to add a file to it. */
  editable: boolean;
  count: number;
};

export function listTracks(): string[] {
  try {
    return readdirSync(bundledDir()).filter((file) => PLAYABLE_FILE_PATTERN.test(file));
  } catch {
    return [];
  }
}

/** Shipped files first, so a user's copy of a name we ship can never shadow the file its
 *  licence record was written for. Re-read each time: the whole point of the user folder
 *  is that dropping a file in makes it playable without a restart. */
export function playableTracks(): string[] {
  const shipped = listTracks();
  const loose = listUserTracks().filter((file) => !shipped.includes(file));
  const inPlaylists = listUserPlaylists().flatMap((playlist) =>
    listUserPlaylistTracks(playlist).map((file) => `${playlist}${PLAYLIST_SEPARATOR}${file}`),
  );
  return [...shipped, ...loose, ...inPlaylists];
}

/** Null for a name we do not offer, which is how an untrusted request stops being a path
 *  and starts being a file we already know about. Every branch answers by looking the
 *  candidate up in a list built from the disk, so no part of the request is ever joined
 *  onto a directory before it has been recognised. */
export function resolveTrack(file: string): string | null {
  if (listTracks().includes(file)) return join(bundledDir(), file);
  if (listUserTracks().includes(file)) return join(playlistsDir(), file);
  const cut = file.indexOf(PLAYLIST_SEPARATOR);
  if (cut <= 0) return null;
  const playlist = file.slice(0, cut);
  const name = file.slice(cut + 1);
  if (!listUserPlaylists().includes(playlist)) return null;
  if (!listUserPlaylistTracks(playlist).includes(name)) return null;
  return join(playlistsDir(), playlist, name);
}

/** Which playlist a track id belongs to, for grouping a list a user is reading. */
export function playlistOf(file: string): string {
  const cut = file.indexOf(PLAYLIST_SEPARATOR);
  if (cut > 0) return file.slice(0, cut);
  return listTracks().includes(file) ? PLAYLIST_BUNDLED : PLAYLIST_ALL;
}

export function tracksIn(playlist: string): string[] {
  if (playlist === PLAYLIST_ALL) return playableTracks();
  if (playlist === PLAYLIST_BUNDLED) return listTracks();
  return listUserPlaylistTracks(playlist).map(
    (file) => `${playlist}${PLAYLIST_SEPARATOR}${file}`,
  );
}

export function listPlaylists(): PlaylistInfo[] {
  return [
    { name: PLAYLIST_ALL, editable: false, count: playableTracks().length },
    { name: PLAYLIST_BUNDLED, editable: true, count: listTracks().length },
    ...listUserPlaylists().map((name) => ({
      name,
      editable: true,
      count: listUserPlaylistTracks(name).length,
    })),
  ];
}

export function isPlaylist(name: string): boolean {
  return listPlaylists().some((playlist) => playlist.name === name);
}

/** What the daemon actually plays from. An empty or deleted playlist falls back to the
 *  bundled music instead of leaving nothing to play: in LLMFM a silence means an agent
 *  needs you, so no setting may be able to produce one that means nothing at all. */
export function libraryFor(playlist: string): string[] {
  const chosen = tracksIn(playlist);
  if (chosen.length > 0) return chosen;
  const bundled = listTracks();
  return bundled.length > 0 ? bundled : playableTracks();
}
