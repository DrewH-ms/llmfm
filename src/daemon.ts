import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApi } from './api.ts';
import type { TrackInfo } from './api.ts';
import { createMidiOut } from './midi-out.ts';
import { createMixer } from './mixer.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createScheduler } from './scheduler.ts';
import { createSessionRegistry } from './sessions.ts';
import { watchOpenSessions } from './open-sessions.ts';
import { parseHookEvent } from './intake.ts';
import { loadScore } from './score.ts';
import { playStartupMotif } from './motif.ts';
import type { StartupMotif } from './motif.ts';
import { createSimulation } from './simulate.ts';
import { createConfigStore } from './config.ts';
import { SETTING_SPECS } from './settings.ts';
import { buildVoiceTree } from './voices.ts';
import { listUserTracks, userTracksDir, ensureUserTracksDir } from './user-tracks.ts';
import {
  WATCH_OPEN_SESSIONS,
  LOG_EVENTS,
  DEFAULT_TRACK,
  PLAYABLE_FILE_PATTERN,
  isRecordedTrack,
} from './constants.ts';
import type { AutoplayMode } from './constants.ts';
import type { DaemonState } from './types.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TRACKS_DIR = join(PROJECT_ROOT, 'tracks');
const TRACKS_INDEX = join(TRACKS_DIR, 'tracks.json');
const SESSION_ID_LOG_LENGTH = 8;/** At or below this there are not enough distinguishable lines to give sessions one
 *  each, so the piece can only work as hold music. */
const MAX_HOLD_MUSIC_VOICES = 2;
/** Rotating needs somewhere else to go. */
const MIN_ROTATION_TRACKS = 2;
const AUTOPLAY_OFF: AutoplayMode = 'off';
const AUTOPLAY_RANDOM: AutoplayMode = 'random';
const AUTOPLAY_SEQUENTIAL: AutoplayMode = 'sequential';

export type Daemon = { stop(): Promise<void> };

export function listTracks(): string[] {
  return readdirSync(TRACKS_DIR).filter((file) => PLAYABLE_FILE_PATTERN.test(file));
}

/** Shipped files first, so a user's copy of a name we ship can never shadow the file its
 *  licence record was written for. Re-read each time: the whole point of the user folder
 *  is that dropping a file in makes it playable without a restart. */
export function playableTracks(): string[] {
  const shipped = listTracks();
  return [...shipped, ...listUserTracks().filter((file) => !shipped.includes(file))];
}

/** Null for a name we do not offer, which is how an untrusted request stops being a path
 *  and starts being a file we already know about. */
export function resolveTrack(file: string): string | null {
  if (listTracks().includes(file)) return join(TRACKS_DIR, file);
  if (listUserTracks().includes(file)) return join(userTracksDir(), file);
  return null;
}

/** Falls back to whatever is present so a stripped-down or user-supplied tracks folder
 *  still starts, rather than failing because one named file is missing. */
function defaultTrack(): string | undefined {
  const tracks = listTracks();
  return tracks.find((file) => file === DEFAULT_TRACK) ?? tracks[0];
}

type TrackProvenance = {
  title: string | null;
  composer: string | null;
  licenceId: string | null;
  sha256: string | null;
};

const readString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
};

/** tracks.json is a file on disk that a user may edit, so a malformed entry costs that
 *  entry its metadata rather than costing the daemon its track list. */
function readProvenance(): Map<string, TrackProvenance> {
  const index = new Map<string, TrackProvenance>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(TRACKS_INDEX, 'utf8'));
  } catch {
    return index;
  }
  const entries = (parsed as { tracks?: unknown })?.tracks;
  if (!Array.isArray(entries)) return index;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const file = readString(record, 'file');
    if (!file) continue;
    index.set(file, {
      title: readString(record, 'title'),
      composer: readString(record, 'composer'),
      licenceId: readString(record, 'licenceId'),
      sha256: readString(record, 'sha256'),
    });
  }
  return index;
}

/** A file we cannot parse counts as no voices, which marks it hold-music-only rather
 *  than removing it from a list the user can see on disk. Recorded audio answers the same
 *  way without being parsed at all: a mixdown has no parts, so there is nothing a session
 *  could be given that the rest of the file would not still be sounding. */
function countVoices(file: string): number {
  if (isRecordedTrack(file)) return 0;
  const path = resolveTrack(file);
  if (!path) return 0;
  try {
    const score = loadScore(path);
    return buildVoiceTree(score).voicesFor(score.parts.length).length;
  } catch {
    return 0;
  }
}

/** Counting voices means parsing a score, so the answer is kept per file. Keyed by digest
 *  rather than by name: a name can be given different bytes while the daemon runs, and a
 *  cached count for the file it used to be would be worse than not caching at all. */
const voiceCounts = new Map<string, number>();

function digestOf(file: string): string | null {
  const path = resolveTrack(file);
  if (!path) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

export function trackCatalogue(): TrackInfo[] {
  const provenance = readProvenance();
  return playableTracks().map((file) => {
    const digest = digestOf(file);
    const cached = digest === null ? undefined : voiceCounts.get(digest);
    const voiceCount = cached ?? countVoices(file);
    if (digest !== null) voiceCounts.set(digest, voiceCount);
    const entry = provenance.get(file);
    const recorded = entry?.sha256 ?? null;
    return {
      file,
      format: extname(file).slice(1).toLowerCase(),
      title: entry?.title ?? null,
      composer: entry?.composer ?? null,
      licenceId: entry?.licenceId ?? null,
      integrity:
        recorded === null || digest === null
          ? 'unrecorded'
          : recorded === digest
            ? 'verified'
            : 'mismatch',
      voiceCount,
      holdMusicOnly: voiceCount <= MAX_HOLD_MUSIC_VOICES,
    };
  });
}

export type TrackRotation = {
  /** The file to play next, or null when autoplay is off or there is nowhere to go. */
  next(options: { library: string[]; current: string | null; mode: AutoplayMode }): string | null;
};

const shuffled = (files: string[], random: () => number): string[] => {
  const order = [...files];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    const a = order[index];
    const b = order[pick];
    if (a === undefined || b === undefined) continue;
    order[index] = b;
    order[pick] = a;
  }
  return order;
};

/** Random order draws from a bag rather than rolling a die, so the library is covered
 *  before anything repeats; the bag refills without the track just heard so a refill
 *  cannot land on it twice in a row either. */
export function createTrackRotation(random: () => number = Math.random): TrackRotation {
  let bag: string[] = [];
  return {
    next({ library, current, mode }): string | null {
      if (mode === AUTOPLAY_OFF || library.length < MIN_ROTATION_TRACKS) return null;
      if (mode !== AUTOPLAY_RANDOM) {
        const index = current === null ? -1 : library.indexOf(current);
        return library[(index + 1) % library.length] ?? null;
      }
      bag = bag.filter((file) => file !== current && library.includes(file));
      if (bag.length === 0) bag = shuffled(library.filter((file) => file !== current), random);
      return bag.shift() ?? null;
    },
  };
}

export async function startDaemon(options: { track?: string } = {}): Promise<Daemon> {
  const midi = createMidiOut();
  const mixer = createMixer(midi);
  const scheduler = createScheduler({ midi, mixer });
  const registry = createSessionRegistry();
  const config = createConfigStore();
  const orchestrator = createOrchestrator({ registry, mixer, scheduler, config });
  const simulation = createSimulation(registry);
  let motif: StartupMotif | null = null;
  let stopping = false;

  const midiStatus = await midi.start();
  ensureUserTracksDir();
  let trackFile = options.track ?? defaultTrack();
  const startPath = trackFile ? resolveTrack(trackFile) : null;
  let score = startPath ? loadScore(startPath) : null;
  const rotation = createTrackRotation();
  let publish = (): void => {};

  /** Swapping scores under a running transport is exactly where a note that is already
   *  sounding loses the note-off that would have ended it, so the old score is paused and
   *  its channels cleared before the new one binds. Parsing first means a bad file leaves
   *  the current piece playing instead of leaving the orchestra silent. */
  const playTrack = (file: string): boolean => {
    const path = stopping ? null : resolveTrack(file);
    if (!path) return false;
    let next;
    try {
      next = loadScore(path);
    } catch {
      return false;
    }
    scheduler.pause();
    mixer.silenceAll();
    trackFile = file;
    score = next;
    orchestrator.bindScore(next);
    publish();
    return true;
  };

  mixer.setMasterVolume(config.current().masterVolume);

  /** A skip is an instruction, not a consequence, so "when a track ends: stop" must not
   *  disable it. Random still draws from the bag, so skipping repeatedly still covers the
   *  library before anything repeats. */
  const skipTrack = (): boolean => {
    const mode = config.current().autoplay;
    const next = rotation.next({
      library: playableTracks(),
      current: trackFile ?? null,
      mode: mode === AUTOPLAY_OFF ? AUTOPLAY_SEQUENTIAL : mode,
    });
    return next ? playTrack(next) : false;
  };

  const state = (): DaemonState => ({
    mode: orchestrator.mode(),
    fadeSeconds: orchestrator.fadeSeconds(),
    simulating: simulation.running(),
    track: trackFile ?? null,
    transport: scheduler.state(),
    midi: midi.status(),
    sessions: orchestrator.sessionViews(),
    config: config.current(),
    settingSpecs: SETTING_SPECS,
    userTracksDir: userTracksDir(),
  });

  const api = await startApi({
    onHookEvent({ name, body }) {
      const event = parseHookEvent({ name, body });
      if (LOG_EVENTS) {
        const id = event ? event.sessionId.slice(0, SESSION_ID_LOG_LENGTH) : '????????';
        const kind = event?.notificationType ? ` type=${event.notificationType}` : '';
        console.log(`[hook] ${name}${kind} session=${id}${event ? '' : ' UNPARSED'}`);
      }
      if (event) registry.applyHookEvent(event);
    },
    onSetMode: (mode) => orchestrator.setMode(mode),
    onSetFade: (seconds) => orchestrator.setFadeSeconds(seconds),
    onSimulate: ({ running }) => (running ? simulation.start() : simulation.stop()),
    onSetMute({ sessionId, muted }) {
      const session = registry.list().find((entry) => entry.sessionId === sessionId);
      if (!session) return;
      // Persist the folder name where it is unambiguous: session ids change on every
      // restart, so a rule keyed on one would quietly stop applying tomorrow. Fall back to
      // the fuller handle only when another live session shares the label.
      const preferLabel = !registry
        .list()
        .some((other) => other.sessionId !== sessionId && other.label === session.label);
      config.setMute({ session, muted, preferLabel });
    },
    onSetSetting: ({ key, value }) => config.setSetting(key, value),
    tracks: trackCatalogue,
    onSetTrack: playTrack,
    onSkipTrack: skipTrack,
    state,
  });
  publish = () => api.broadcast();

  const unsubscribeEnd = scheduler.onEnd(() => {
    const next = rotation.next({
      library: playableTracks(),
      current: trackFile ?? null,
      mode: config.current().autoplay,
    });
    if (next) playTrack(next);
  });

  const unsubscribe = registry.onChange(() => {
    // Only real work cuts the sting short. Merely registering sessions does not: the file
    // watcher lists every open terminal within a poll of startup, which would truncate the
    // motif to its first note on any machine that had a session open.
    if (registry.list().some((session) => session.working)) motif?.cancel();
    orchestrator.refresh();
    api.broadcast();
  });
  // A hand edit to the config must take effect mid-piece, not at the next restart.
  const unsubscribeConfig = config.onChange(() => {
    mixer.setMasterVolume(config.current().masterVolume);
    orchestrator.refresh();
    api.broadcast();
  });
  config.start();
  const watcher = WATCH_OPEN_SESSIONS ? watchOpenSessions(registry) : null;

  // The transport starts only once the sting is out of the way, so the mixer's opening
  // fade cannot write over it. Hook events arriving meanwhile are still recorded; they
  // reach the mix when the score binds.
  const beginPerformance = (): void => {
    motif = null;
    if (score && !stopping) orchestrator.bindScore(score);
  };
  if (score && midiStatus.ready && config.current().startupMotif) {
    motif = playStartupMotif({
      midi,
      score,
      masterVolume: config.current().masterVolume,
      onDone: beginPerformance,
    });
  } else {
    beginPerformance();
  }

  console.log(`LLMFM listening on http://127.0.0.1:7777`);
  console.log(midiStatus.ready ? `MIDI out: ${midiStatus.device}` : `MIDI unavailable: ${midiStatus.error}`);
  if (trackFile) console.log(`Track: ${trackFile}`);

  return {
    async stop(): Promise<void> {
      stopping = true;
      // Cancelling clears the sting's own channels, which the mixer does not hold yet.
      motif?.cancel();
      unsubscribe();
      unsubscribeConfig();
      unsubscribeEnd();
      config.stop();
      watcher?.stop();
      simulation.stop();
      orchestrator.stop();
      scheduler.stop();
      mixer.silenceAll();
      mixer.stop();
      await api.stop();
      midi.stop();
    },
  };
}
