/** One root for everything LLMFM owns; only the hook config lives under `~/.copilot/hooks/`, because Copilot reads it. */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE_NAME, LOG_FILE_NAME, PLAYLISTS_DIR_NAME, PLAYLIST_BUNDLED } from './constants.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** A function, not a constant, so tests can point the whole tree at a temp folder. */
export function llmfmHome(): string {
  return process.env['LLMFM_HOME'] ?? PROJECT_ROOT;
}

export function playlistsDir(): string {
  return join(llmfmHome(), PLAYLISTS_DIR_NAME);
}

/** A real playlist folder, not a special case, so there is only one copy of the files the licence records describe. */
export function bundledDir(): string {
  return join(playlistsDir(), PLAYLIST_BUNDLED);
}

export function configPath(): string {
  return join(llmfmHome(), CONFIG_FILE_NAME);
}

export function logPath(): string {
  return join(llmfmHome(), LOG_FILE_NAME);
}
