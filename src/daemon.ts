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
import { createSimulation } from './simulate.ts';
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
  const orchestrator = createOrchestrator({ registry, mixer, scheduler });
  const simulation = createSimulation(registry);

  const trackFile = options.track ?? listTracks()[0];
  const midiStatus = await midi.start();

  if (trackFile) orchestrator.bindScore(loadScore(join(TRACKS_DIR, trackFile)));

  const state = (): DaemonState => ({
    mode: orchestrator.mode(),
    fadeSeconds: orchestrator.fadeSeconds(),
    simulating: simulation.running(),
    track: trackFile ?? null,
    transport: scheduler.state(),
    midi: midi.status(),
    sessions: orchestrator.sessionViews(),
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
    state,
  });

  const unsubscribe = registry.onChange(() => {
    orchestrator.refresh();
    api.broadcast();
  });
  const watcher = WATCH_OPEN_SESSIONS ? watchOpenSessions(registry) : null;

  console.log(`Agent Orchestra listening on http://127.0.0.1:7777`);
  console.log(midiStatus.ready ? `MIDI out: ${midiStatus.device}` : `MIDI unavailable: ${midiStatus.error}`);
  if (trackFile) console.log(`Track: ${trackFile}`);

  return {
    async stop(): Promise<void> {
      unsubscribe();
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
