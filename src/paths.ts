/** Everything LLMFM owns lives together under one root: the config beside the music,
 *  the music in `playlists/`, one folder per playlist. Only the hook config sits
 *  elsewhere, under `~/.copilot/hooks/`, because Copilot is what reads it — the rest of
 *  our files have no business in Copilot's directory. */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE_NAME, LOG_FILE_NAME, PLAYLISTS_DIR_NAME, PLAYLIST_BUNDLED } from './constants.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Read through a function rather than frozen into a constant so a test can point the
 *  whole tree at a temp folder, and so a future global install can relocate it without
 *  every caller learning a second path. */
export function llmfmHome(): string {
  return process.env['LLMFM_HOME'] ?? PROJECT_ROOT;
}

export function playlistsDir(): string {
  return join(llmfmHome(), PLAYLISTS_DIR_NAME);
}

/** The shipped music is a real playlist folder, not a special case pointing somewhere
 *  else, so `bundled` behaves like every other playlist and there is only ever one copy
 *  of the files the licence records were written against. */
export function bundledDir(): string {
  return join(playlistsDir(), PLAYLIST_BUNDLED);
}

export function configPath(): string {
  return join(llmfmHome(), CONFIG_FILE_NAME);
}

export function logPath(): string {
  return join(llmfmHome(), LOG_FILE_NAME);
}
