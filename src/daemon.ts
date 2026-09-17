import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { startApi } from './api.ts';
import type { TrackInfo } from './api.ts';
import { createMidiOut } from './midi-out.ts';
import { createMixer } from './mixer.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createScheduler } from './scheduler.ts';
import { createAudioOut } from './audio-out.ts';
import { createRecordedPlayer } from './recorded.ts';
import { createSystemVolume } from './system-volume.ts';
import { createDuck } from './duck.ts';
import { createBluetoothReceive } from './bluetooth-receive.ts';
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
import { ensurePlaylistsDir } from './user-tracks.ts';
import { playlistsDir, bundledDir } from './paths.ts';
import {
  listTracks,
  playableTracks,
  resolveTrack,
  libraryFor,
  listPlaylists,
  isPlaylist,
  playlistOf,
} from './playlists.ts';
import {
  WATCH_OPEN_SESSIONS,
  LOG_EVENTS,
  DEFAULT_TRACK,
  isRecordedTrack,
} from './constants.ts';
import type { AutoplayMode } from './constants.ts';
import type { DaemonState } from './types.ts';

export { listTracks, playableTracks, resolveTrack, listPlaylists };

const TRACKS_INDEX = join(bundledDir(), 'tracks.json');
const SESSION_ID_LOG_LENGTH = 8;
/** At or below this there are not enough distinguishable lines to give sessions one
 *  each, so the piece can only work as hold music. */
const MAX_HOLD_MUSIC_VOICES = 2;
/** Rotating needs somewhere else to go. */
const MIN_ROTATION_TRACKS = 2;
const AUTOPLAY_OFF: AutoplayMode = 'off';
const AUTOPLAY_RANDOM: AutoplayMode = 'random';
const AUTOPLAY_SEQUENTIAL: AutoplayMode = 'sequential';

export type Daemon = { stop(): Promise<void> };

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
      playlist: playlistOf(file),
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
  const audio = createAudioOut();
  const recorded = createRecordedPlayer(audio);
  const volume = createSystemVolume();
  const bluetooth = createBluetoothReceive();
  // The phone's stream is the one thing on this machine we can name, so it is the one we
  // gate on its own rather than by silencing the whole output.
  const duck = createDuck({ volume, sessionName: () => bluetooth.status().device?.name ?? null });
  const orchestrator = createOrchestrator({
    registry,
    mixer,
    scheduler,
    config,
    recorded: {
      setAudible: (gate) => recorded.setAudible(gate),
    },
    duck,
  });
  const simulation = createSimulation(registry);
  let motif: StartupMotif | null = null;
  /** The sessions already working when the sting began, so only work that starts during it
   *  cuts it short. */
  let stingBaseline: Set<string> | null = null;
  let stopping = false;
  /** True while a recorded track holds the transport, so state and shutdown ask the right
   *  player which one is running. */
  let recordedTrack = false;
  /** True while the user's own audio carries the signal and LLMFM plays nothing itself. */
  let ducking = false;
  /** True while a bridge is holding the A2DP sink open for the user's phone. */
  let receivingBluetooth = false;

  /** `silenceMode` describes LLMFM's own transport, and duck has no transport of ours. */
  const holdOurTransport = (): boolean =>
    config.current().audio !== 'duck' && config.current().silenceMode === 'mute';

  const midiStatus = await midi.start();
  ensurePlaylistsDir();
  let trackFile = options.track ?? defaultTrack();
  const startPath = trackFile ? resolveTrack(trackFile) : null;
  // A recorded file cannot be parsed into a score, and must not take the daemon down on
  // the way up; it is bound through `playTrack` once the server is listening instead.
  const startRecorded = trackFile !== undefined && isRecordedTrack(trackFile);
  let score = startPath && !startRecorded ? loadScore(startPath) : null;
  const rotation = createTrackRotation();
  let publish = (): void => {};

  /** Swapping scores under a running transport is exactly where a note that is already
   *  sounding loses the note-off that would have ended it, so the old score is paused and
   *  its channels cleared before the new one binds. Parsing first means a bad file leaves
   *  the current piece playing instead of leaving the orchestra silent.
   *
   *  The two kinds of track are mutually exclusive, and whichever is not taking over is
   *  silenced first: leaving the other transport running would put two pieces of music in
   *  the room at once, each answering to the same sessions. */
  const playTrack = async (file: string): Promise<boolean> => {
    const path = stopping ? null : resolveTrack(file);
    if (!path) return false;

    if (isRecordedTrack(file)) {
      // Started on demand rather than at boot: the bridge pays an Add-Type compile, and a
      // library of MIDI never needs it.
      if (!audio.status().ready) await audio.start();
      if (!(await recorded.load(path))) return false;
      scheduler.pause();
      mixer.silenceAll();
      recorded.setMasterVolume(config.current().masterVolume);
      recorded.setHoldTransport(holdOurTransport());
      recordedTrack = true;
      trackFile = file;
      score = null;
      orchestrator.bindRecorded();
      publish();
      return true;
    }

    let next;
    try {
      next = loadScore(path);
    } catch {
      return false;
    }
    if (recordedTrack) {
      recorded.setAudible({ audible: false, fadeSeconds: 0 });
      recordedTrack = false;
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

  /** Only one of ducking and playing our own score ever runs. Switches queue behind each
   *  other so a toggle cannot leave duck mode before the bridge that must restore the
   *  level exists, and the chain is kept resolved so one failure cannot skip the unmute.
   *
   *  Bluetooth receive rides the same chain. It is not a third mode: it supplies audio to
   *  the endpoint duck mode gates, so it is switched on its own setting. */
  let audioModeSwitch: Promise<void> = Promise.resolve();
  const applyAudioMode = (): Promise<void> => {
    audioModeSwitch = audioModeSwitch
      .then(async () => {
        const wanted = config.current().audio === 'duck';
        if (wanted !== ducking) {
          if (wanted) {
            motif?.cancel();
            scheduler.pause();
            mixer.silenceAll();
            recorded.setHoldTransport(holdOurTransport());
            recorded.setAudible({ audible: false, fadeSeconds: 0 });
            const status = await duck.start();
            if (!status.ready) console.log(`Duck unavailable: ${status.error}`);
            // Only a bridge that answered counts as ducking, so a failed start is retried
            // by the next switch rather than leaving the mode on with nothing behind it.
            ducking = status.ready;
          } else {
            await duck.stop();
            ducking = false;
            recorded.setHoldTransport(holdOurTransport());
          }
          orchestrator.refresh();
          publish();
        }

        const wantedBluetooth = config.current().bluetoothReceive;
        if (wantedBluetooth === receivingBluetooth) return;
        if (wantedBluetooth) {
          const status = await bluetooth.start();
          if (!status.ready) console.log(`Bluetooth receive unavailable: ${status.error}`);
          // A bridge that did not come up is not recorded as holding the sink, so the next
          // switch tries again instead of leaving the setting on with nothing behind it.
          receivingBluetooth = status.ready;
        } else {
          await bluetooth.stop();
          receivingBluetooth = false;
        }
        publish();
      })
      .catch((error: unknown) => {
        console.log(`Audio mode switch failed: ${String(error)}`);
      });
    return audioModeSwitch;
  };

  /** A skip is an instruction, not a consequence, so "when a track ends: stop" must not
   *  disable it. Random still draws from the bag, so skipping repeatedly still covers the
   *  library before anything repeats. */
  const skipTrack = (): Promise<boolean> => {
    const mode = config.current().autoplay;
    const next = rotation.next({
      library: libraryFor(config.current().playlist),
      current: trackFile ?? null,
      mode: mode === AUTOPLAY_OFF ? AUTOPLAY_SEQUENTIAL : mode,
    });
    return next ? playTrack(next) : Promise.resolve(false);
  };

  const state = (): DaemonState => ({
    mode: orchestrator.mode(),
    fadeSeconds: orchestrator.fadeSeconds(),
    simulating: simulation.running(),
    track: trackFile ?? null,
    transport: recordedTrack ? recorded.state() : scheduler.state(),
    midi: midi.status(),
    duck: volume.status(),
    bluetooth: bluetooth.status(),
    sessions: orchestrator.sessionViews(),
    config: config.current(),
    settingSpecs: SETTING_SPECS,
    playlistsDir: playlistsDir(),
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
    listBluetooth: () => bluetooth.list(),
    async onConnectBluetooth({ id }) {
      const status = await bluetooth.connect({ id });
      publish();
      return status.device !== null;
    },
    tracks: trackCatalogue,
    playlists: listPlaylists,
    onSetPlaylist(name) {
      if (!isPlaylist(name)) return false;
      config.setPlaylist(name);
      return true;
    },
    onSetTrack: playTrack,
    onSkipTrack: skipTrack,
    state,
  });
  publish = () => api.broadcast();

  const rotateOnEnd = (): void => {
    const next = rotation.next({
      library: libraryFor(config.current().playlist),
      current: trackFile ?? null,
      mode: config.current().autoplay,
    });
    if (next) void playTrack(next);
  };

  const unsubscribeEnd = scheduler.onEnd(rotateOnEnd);
  const unsubscribeRecordedEnd = recorded.onEnd(rotateOnEnd);

  const unsubscribe = registry.onChange(() => {
    // Only work that STARTS during the sting cuts it short. A machine with terminals
    // already open hands the daemon their sessions within a poll of startup, and treating
    // those as new work truncated the sting to its first note on every real machine.
    if (
      motif &&
      registry.list().some((session) => session.working && !stingBaseline?.has(session.sessionId))
    ) {
      motif.cancel();
    }
    orchestrator.refresh();
    api.broadcast();
  });
  // A hand edit to the config must take effect mid-piece, not at the next restart.
  const unsubscribeConfig = config.onChange(() => {
    mixer.setMasterVolume(config.current().masterVolume);
    recorded.setMasterVolume(config.current().masterVolume);
    recorded.setHoldTransport(holdOurTransport());
    void applyAudioMode();
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
    stingBaseline = null;
    if (stopping) return;
    if (startRecorded && trackFile) {
      void playTrack(trackFile);
      return;
    }
    if (score) orchestrator.bindScore(score);
  };
  // Nothing of ours announces itself over music the user is already playing.
  if (midiStatus.ready && config.current().startupMotif && config.current().audio !== 'duck') {
    stingBaseline = new Set(
      registry
        .list()
        .filter((session) => session.working)
        .map((session) => session.sessionId),
    );
    motif = playStartupMotif({
      midi,
      masterVolume: config.current().masterVolume,
      onDone: beginPerformance,
    });
  } else {
    beginPerformance();
  }
  void applyAudioMode();

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
      unsubscribeRecordedEnd();
      // A leaked MCI device keeps sounding after the process it belonged to is gone.
      recorded.stop();
      // The system volume is the user's, and must never outlive us changed.
      // Ordered so the sink is released first, nested so a bridge that fails on the way
      // out cannot skip the unmute.
      try {
        await audioModeSwitch;
      } finally {
        try {
          await bluetooth.stop();
        } finally {
          await duck.stop();
        }
      }
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
