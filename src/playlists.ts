/** Playlists are folders with no index file; `bundled` tracks keep bare ids because tracks.json licence records are keyed by filename. */

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

/** Shipped files first, so a user's copy cannot shadow the file its licence record was written for; re-read so drops need no restart. */
export function playableTracks(): string[] {
  const shipped = listTracks();
  const loose = listUserTracks().filter((file) => !shipped.includes(file));
  const inPlaylists = listUserPlaylists().flatMap((playlist) =>
    listUserPlaylistTracks(playlist).map((file) => `${playlist}${PLAYLIST_SEPARATOR}${file}`),
  );
  return [...shipped, ...loose, ...inPlaylists];
}

/** Every branch looks the candidate up in a disk-built list, so an untrusted name is never joined onto a directory. */
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

/** Falls back to bundled music rather than nothing: in LLMFM a silence means an agent needs you. */
export function libraryFor(playlist: string): string[] {
  const chosen = tracksIn(playlist);
  if (chosen.length > 0) return chosen;
  const bundled = listTracks();
  return bundled.length > 0 ? bundled : playableTracks();
}
