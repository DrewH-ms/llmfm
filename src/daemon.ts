import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { startApi } from './api.ts';
import type { Api, TrackInfo } from './api.ts';
import { createMidiOut } from './midi-out.ts';
import { createMixer } from './mixer.ts';
import { createOrchestrator } from './orchestrator.ts';
import { createScheduler } from './scheduler.ts';
import { createAudioOut } from './audio-out.ts';
import { createRecordedPlayer } from './recorded.ts';
import { createSystemVolume, claimPath } from './system-volume.ts';
import { createDuck } from './duck.ts';
import { createBluetoothReceive } from './bluetooth-receive.ts';
import { createSessionRegistry } from './sessions.ts';
import { watchOpenSessions } from './open-sessions.ts';
import { parseHookEvent } from './intake.ts';
import { loadScore } from './score.ts';
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
  DAEMON_URL,
  BRIDGE_HEALTH_TICK_MS,
  isRecordedTrack,
} from './constants.ts';
import type { AutoplayMode } from './constants.ts';
import type { DaemonState, Score } from './types.ts';

export { listTracks, playableTracks, resolveTrack, listPlaylists };

const TRACKS_INDEX = join(bundledDir(), 'tracks.json');
const SESSION_ID_LOG_LENGTH = 8;
/** At or below this there are too few distinguishable lines to give sessions one each. */
const MAX_HOLD_MUSIC_VOICES = 2;
const MIN_ROTATION_TRACKS = 2;
const AUTOPLAY_OFF: AutoplayMode = 'off';
const AUTOPLAY_RANDOM: AutoplayMode = 'random';
const AUTOPLAY_SEQUENTIAL: AutoplayMode = 'sequential';

export type Daemon = { stop(): Promise<void> };

/** Falls back to whatever is present so a stripped-down or user-supplied tracks folder still starts. */
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

/** tracks.json is user-editable, so a malformed entry costs that entry its metadata, not the daemon its track list. */
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

/** An unparseable file counts as no voices — hold-music-only rather than hidden; recorded mixdowns have no parts either. */
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

/** Keyed by digest, not name: a name can be given different bytes while the daemon runs. */
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

/** Random order draws from a bag so the library is covered before anything repeats, and a refill excludes the last track. */
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

/** Walks past tracks that will not load so a broken file cannot end autoplay; null once the rotation repeats its first candidate. */
export async function advanceRotation(options: {
  current: string | null;
  next(current: string | null): string | null;
  play(file: string): Promise<boolean>;
}): Promise<string | null> {
  let current = options.current;
  let firstTried: string | null = null;
  for (;;) {
    const candidate = options.next(current);
    if (candidate === null || candidate === firstTried) return null;
    firstTried ??= candidate;
    if (await options.play(candidate)) return candidate;
    current = candidate;
  }
}

/** A second `llmfm start` is the one failure worth naming rather than printing raw. */
const isPortInUse = (error: unknown): boolean =>
  (typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE') ||
  String(error).includes('EADDRINUSE');

/** The rule the whole sound source turns on: a phone we are gating leaves us nothing of our own to play. Derived rather than configured, so a fresh install cannot start silent. */
export function shouldDuck(options: {
  bluetoothReceive: boolean;
  device: { name: string } | null;
}): boolean {
  return options.bluetoothReceive && options.device !== null;
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
  // The phone's stream is the one thing we can name, so it is gated alone rather than by silencing the output.
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
    ducking: () => ducking,
    onSettled: () => publish(),
  });
  const simulation = createSimulation(registry);
  let stopping = false;
  /** True while a recorded track holds the transport, so state and shutdown ask the right player. */
  let recordedTrack = false;
  /** True while the user's own audio carries the signal and LLMFM plays nothing itself. */
  let ducking = false;
  /** True while a bridge is holding the A2DP sink open for the user's phone. */
  let receivingBluetooth = false;

  /** `silenceMode` describes LLMFM's own transport, and duck has no transport of ours. */
  const holdOurTransport = (duckActive: boolean): boolean =>
    !duckActive && config.current().silenceMode === 'mute';

  /** Derived from the sink, never configured. */
  const wantsDuck = (): boolean =>
    shouldDuck({
      bluetoothReceive: config.current().bluetoothReceive,
      device: bluetooth.status().device,
    });

  const midiStatus = await midi.start();
  ensurePlaylistsDir();
  let trackFile = options.track ?? defaultTrack();
  const startPath = trackFile ? resolveTrack(trackFile) : null;
  // A recorded file cannot be parsed into a score, so it is bound through `playTrack` once the server is listening.
  const startRecorded = trackFile !== undefined && isRecordedTrack(trackFile);
  let score: Score | null = null;
  if (startPath && !startRecorded) {
    try {
      score = loadScore(startPath);
    } catch (error) {
      console.log(`Failed to load initial track ${trackFile}: ${String(error)}`);
      trackFile = undefined;
    }
  }
  const rotation = createTrackRotation();
  let publish = (): void => {};

  /** Pause and clear before binding, or a sounding note loses its note-off; parsing first leaves the old piece playing on a bad file. */
  const playTrack = async (file: string): Promise<boolean> => {
    const path = stopping ? null : resolveTrack(file);
    if (!path) return false;

    if (isRecordedTrack(file)) {
      // Started on demand rather than at boot: the bridge pays an Add-Type compile a MIDI library never needs.
      if (!audio.status().ready) await audio.start();
      if (!(await recorded.load(path))) return false;
      scheduler.pause();
      mixer.silenceAll();
      recorded.setMasterVolume(config.current().masterVolume);
      recorded.setHoldTransport(holdOurTransport(ducking));
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

  /** Mode switches queue so a toggle cannot leave duck mode before the bridge that must restore the level exists. */
  let audioModeSwitch: Promise<void> = Promise.resolve();
  const applyAudioMode = (): Promise<void> => {
    audioModeSwitch = audioModeSwitch
      .then(async () => {
        // A switch queued before teardown must not bring a bridge back up behind it.
        if (stopping) return;
        // The sink decides the mode now, so it has to settle before the duck state can be derived from it.
        const wantedBluetooth = config.current().bluetoothReceive;
        if (wantedBluetooth !== receivingBluetooth) {
          if (wantedBluetooth) {
            const status = await bluetooth.start();
            if (!status.ready) console.log(`Bluetooth receive unavailable: ${status.error}`);
            // A bridge that did not come up is not recorded as holding the sink, so the next switch tries again.
            receivingBluetooth = status.ready;
          } else {
            await bluetooth.stop();
            receivingBluetooth = false;
          }
        }

        const wanted = wantsDuck();
        if (wanted !== ducking) {
          if (wanted) {
            scheduler.pause();
            mixer.silenceAll();
            recorded.setHoldTransport(holdOurTransport(true));
            recorded.setAudible({ audible: false, fadeSeconds: 0 });
            const status = await duck.start();
            if (!status.ready) console.log(`Duck unavailable: ${status.error}`);
            // Only a bridge that answered counts as ducking, so a failed start is retried by the next switch.
            ducking = status.ready;
          } else {
            await duck.stop();
            ducking = false;
            recorded.setHoldTransport(holdOurTransport(false));
          }
          orchestrator.refresh();
        }
        publish();
      })
      .catch((error: unknown) => {
        console.log(`Audio mode switch failed: ${String(error)}`);
      });
    return audioModeSwitch;
  };

  /** A skip is an instruction, not a consequence, so "when a track ends: stop" must not disable it. */
  const skipTrack = async (): Promise<boolean> => {
    const mode = config.current().autoplay;
    const started = await advanceRotation({
      current: trackFile ?? null,
      next: (current) =>
        rotation.next({
          library: libraryFor(config.current().playlist),
          current,
          mode: mode === AUTOPLAY_OFF ? AUTOPLAY_SEQUENTIAL : mode,
        }),
      play: playTrack,
    });
    return started !== null;
  };

  const state = (): DaemonState => ({
    mode: orchestrator.mode(),
    fadeSeconds: orchestrator.fadeSeconds(),
    simulating: simulation.running(),
    track: trackFile ?? null,
    transport: recordedTrack ? recorded.state() : scheduler.state(),
    midi: midi.status(),
    duck: volume.status(),
    ducking,
    bluetooth: bluetooth.status(),
    sessions: orchestrator.sessionViews(),
    config: config.current(),
    settingSpecs: SETTING_SPECS,
    playlistsDir: playlistsDir(),
  });

  // A hard-kill mute is recovered inside the bridge's start, so it must run before anything else can fail and in any mode.
  if (existsSync(claimPath())) {
    await duck.start();
    await duck.stop();
  }

  let api: Api;
  try {
    api = await startApi({
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
        // Prefer the folder name: session ids change on every restart, so a rule keyed on one stops applying tomorrow.
        const preferLabel = !registry
          .list()
          .some((other) => other.sessionId !== sessionId && other.label === session.label);
        config.setMute({ session, muted, preferLabel });
      },
      onSetSetting: ({ key, value }) => config.setSetting(key, value),
      listBluetooth: () => bluetooth.list(),
      async onConnectBluetooth({ id }) {
        const status = await bluetooth.connect({ id });
        // The device is what decides the mode, so gaining one has to re-derive it.
        await applyAudioMode();
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
  } catch (error) {
    // Nothing brought up on the way in may outlive a start that did not finish — least of all a held mute.
    await duck.stop().catch((failure: unknown) => console.log(`Duck teardown failed: ${String(failure)}`));
    await bluetooth
      .stop()
      .catch((failure: unknown) => console.log(`Bluetooth teardown failed: ${String(failure)}`));
    recorded.stop();
    midi.stop();
    throw new Error(
      isPortInUse(error)
        ? `LLMFM is already running at ${DAEMON_URL}.`
        : `LLMFM could not listen at ${DAEMON_URL}: ${String(error)}`,
    );
  }
  publish = () => api.broadcast();

  const rotateOnEnd = (): void => {
    void advanceRotation({
      current: trackFile ?? null,
      next: (current) =>
        rotation.next({
          library: libraryFor(config.current().playlist),
          current,
          mode: config.current().autoplay,
        }),
      play: playTrack,
    });
  };

  const unsubscribeEnd = scheduler.onEnd(rotateOnEnd);
  const unsubscribeRecordedEnd = recorded.onEnd(rotateOnEnd);

  const unsubscribe = registry.onChange(() => {
    orchestrator.refresh();
    api.broadcast();
  });
  // A hand edit to the config must take effect mid-piece, not at the next restart.
  const unsubscribeConfig = config.onChange(() => {
    mixer.setMasterVolume(config.current().masterVolume);
    recorded.setMasterVolume(config.current().masterVolume);
    recorded.setHoldTransport(holdOurTransport(ducking));
    void applyAudioMode();
    orchestrator.refresh();
    api.broadcast();
  });
  config.start();
  const watcher = WATCH_OPEN_SESSIONS ? watchOpenSessions(registry) : null;

  if (startRecorded && trackFile) {
    void playTrack(trackFile);
  } else if (score) {
    orchestrator.bindScore(score);
  }
  void applyAudioMode();

  /** A dead bridge says nothing, so the latches `applyAudioMode` compares against are cleared on the transition only. */
  const health = setInterval(() => {
    if (stopping) return;
    const lost =
      (ducking && !volume.status().ready) || (receivingBluetooth && !bluetooth.status().ready);
    if (lost) {
      if (ducking && !volume.status().ready) ducking = false;
      if (receivingBluetooth && !bluetooth.status().ready) receivingBluetooth = false;
      // A phone leaving is not a bridge failure, so it is the derived mode rather than a latch that catches it.
    } else if (ducking === wantsDuck()) return;
    void applyAudioMode();
    publish();
  }, BRIDGE_HEALTH_TICK_MS);
  health.unref();

  console.log(`LLMFM listening on ${DAEMON_URL}`);
  console.log(midiStatus.ready ? `MIDI out: ${midiStatus.device}` : `MIDI unavailable: ${midiStatus.error}`);
  if (trackFile) console.log(`Track: ${trackFile}`);

  return {
    async stop(): Promise<void> {
      stopping = true;
      clearInterval(health);
      unsubscribe();
      unsubscribeConfig();
      unsubscribeEnd();
      unsubscribeRecordedEnd();
      // A leaked MCI device keeps sounding after the process it belonged to is gone.
      recorded.stop();
      // Release the audio claim last and stand the bridge down inner-first: a mute that outlives the process is invisible.
      try {
        await audioModeSwitch;
      } finally {
        try {
          await duck.stop();
        } finally {
          await bluetooth.stop();
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
