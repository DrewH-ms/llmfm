import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApi } from './api.ts';
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
import { WATCH_OPEN_SESSIONS, LOG_EVENTS } from './constants.ts';
import type { DaemonState } from './types.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TRACKS_DIR = join(PROJECT_ROOT, 'tracks');
const MIDI_FILE_PATTERN = /\.midi?$/i;
const SESSION_ID_LOG_LENGTH = 8;

export type Daemon = { stop(): Promise<void> };

export function listTracks(): string[] {
  return readdirSync(TRACKS_DIR).filter((file) => MIDI_FILE_PATTERN.test(file));
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

  const trackFile = options.track ?? listTracks()[0];
  const midiStatus = await midi.start();
  const score = trackFile ? loadScore(join(TRACKS_DIR, trackFile)) : null;

  mixer.setMasterVolume(config.current().masterVolume);

  const state = (): DaemonState => ({
    mode: orchestrator.mode(),
    fadeSeconds: orchestrator.fadeSeconds(),
    simulating: simulation.running(),
    track: trackFile ?? null,
    transport: scheduler.state(),
    midi: midi.status(),
    sessions: orchestrator.sessionViews(),
    config: config.current(),
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
    state,
  });

  const unsubscribe = registry.onChange(() => {
    // A session arriving means the orchestra has something to say; the sting yields to it
    // rather than playing over the first notes of the real performance.
    motif?.cancel();
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
      config.stop();
      watcher?.stop();
      simulation.stop();
      scheduler.stop();
      mixer.silenceAll();
      mixer.stop();
      await api.stop();
      midi.stop();
    },
  };
}
