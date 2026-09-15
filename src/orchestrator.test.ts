import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from './orchestrator.ts';
import { SETTING_DEFAULTS } from './settings.ts';
import { BLOCK_SETTLE_MS } from './constants.ts';
import type { ConfigStore, LlmfmConfig } from './config.ts';
import type { Mixer } from './mixer.ts';
import type { Scheduler } from './scheduler.ts';
import type { SessionRegistry } from './sessions.ts';
import type { Score, Session } from './types.ts';

const part = (partId: string, name: string, program: number, channel: number) => ({
  partId,
  name,
  program,
  channel,
  percussion: false,
  notes: [{ time: 0, duration: 1, midi: 60, velocity: 0.8, channel }],
});

/** Four families, so the voice tree has something to subdivide and sessions land on
 *  different branches rather than sharing one voice. */
const score = (): Score =>
  ({
    name: 'test',
    duration: 1,
    parts: [
      part('p1', 'Violin I', 40, 0),
      part('p2', 'Flute', 73, 1),
      part('p3', 'Trumpet', 56, 2),
      part('p4', 'Cello', 42, 3),
    ],
  }) as never;

const session = (over: Partial<Session> & { sessionId: string }): Session => ({
  working: true,
  cwd: `/repos/${over.sessionId}`,
  label: over.sessionId,
  source: 'hook',
  blockedMidTurn: false,
  blockedSince: null,
  listedByCli: true,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

const fakeConfig = (over: Partial<LlmfmConfig> = {}): ConfigStore => {
  let config: LlmfmConfig = { muted: [], ...SETTING_DEFAULTS, ...over };
  return {
    current: () => config,
    setMute: () => {},
    setSetting(key, value) {
      config = { ...config, [key]: value } as LlmfmConfig;
      return true;
    },
    start: () => {},
    stop: () => {},
    onChange: () => () => {},
  };
};

/** Gate state only. The real fade is the mixer's business and is tested there; here what
 *  matters is which parts the orchestrator asks for. */
const fakeMixer = (): Mixer & { gates: Map<string, boolean> } => {
  const gates = new Map<string, boolean>();
  return {
    gates,
    bindScore: (next: Score) => {
      for (const p of next.parts) gates.set(p.partId, true);
    },
    setPartAudible: ({ partId, audible }) => void gates.set(partId, audible),
    isPartAudible: (partId: string) => gates.get(partId) === true,
    anyAudible: () => [...gates.values()].some(Boolean),
    anyGateOpen: () => [...gates.values()].some(Boolean),
    setMasterVolume: () => {},
    silenceAll: () => {},
    stop: () => {},
  };
};

const fakeScheduler = (): Scheduler & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    load: () => {},
    play: () => void calls.push('play'),
    pause: () => void calls.push('pause'),
    onEnd: () => () => {},
    state: () => ({ playing: true, position: 0, duration: 1 }) as never,
    stop: () => {},
  };
};

const built: { stop(): void }[] = [];
after(() => {
  for (const orchestrator of built) orchestrator.stop();
});

const harness = (sessions: Session[], config: ConfigStore) => {
  const mixer = fakeMixer();
  const scheduler = fakeScheduler();
  const registry = { list: () => sessions } as unknown as SessionRegistry;
  const orchestrator = createOrchestrator({ registry, mixer, scheduler, config });
  built.push(orchestrator);
  orchestrator.bindScore(score());
  return { mixer, scheduler, orchestrator };
};

test('alert mode inverts what sounding means', () => {
  // The whole product rests on silence carrying the signal, so the inversion has to reach
  // the parts themselves rather than only being stored in config.
  const working = [session({ sessionId: 'a', working: true })];

  const reward = harness(working, fakeConfig({ mode: 'reward', gate: 'any' }));
  assert.ok(reward.mixer.anyAudible(), 'a working agent should sound in reward mode');

  const alert = harness(working, fakeConfig({ mode: 'alert', gate: 'any' }));
  assert.equal(alert.mixer.anyAudible(), false, 'a working agent must be silent in alert mode');

  const idle = harness([session({ sessionId: 'a', working: false })], fakeConfig({
    mode: 'alert',
    gate: 'any',
  }));
  assert.ok(idle.mixer.anyAudible(), 'an agent that needs you must sound in alert mode');
});

test('a block younger than the settle window does not silence anything', () => {
  // Bug: `permission_prompt` fires even when the tool is pre-approved and never blocks,
  // which chopped 1-2s holes in the music during sessions that never waited on anyone.
  const justBlocked = [
    session({
      sessionId: 'a',
      working: false,
      blockedMidTurn: true,
      blockedSince: Date.now(),
    }),
  ];
  const fresh = harness(justBlocked, fakeConfig({ gate: 'any' }));
  assert.ok(fresh.mixer.anyAudible(), 'an unsettled prompt must not cut the music');

  const settled = [
    session({
      sessionId: 'a',
      working: false,
      blockedMidTurn: true,
      blockedSince: Date.now() - BLOCK_SETTLE_MS - 1,
    }),
  ];
  const old = harness(settled, fakeConfig({ gate: 'any' }));
  assert.equal(old.mixer.anyAudible(), false, 'a real block must still silence its part');
});

test('a muted session frees its voice instead of sounding like a stopped agent', () => {
  // Muting is a display choice. Gating the voice silent would make it indistinguishable
  // from an agent waiting on the user, which is the one confusion we cannot afford.
  const sessions = [
    session({ sessionId: 'a', label: 'quiet', working: true }),
    session({ sessionId: 'b', label: 'loud', working: true }),
  ];
  const { orchestrator } = harness(sessions, fakeConfig({ muted: ['quiet'], gate: 'per-agent' }));
  const views = orchestrator.sessionViews();
  const muted = views.find((view) => view.label === 'quiet');
  const heard = views.find((view) => view.label === 'loud');

  assert.ok(muted?.muted, 'the mute rule should match the session');
  assert.equal(muted?.voiceName, null, 'a muted session should hold no voice at all');
  assert.ok(heard?.voiceName, 'an unmuted session should still hold a voice');
});

test('one blocked agent silences only its own voice', () => {
  // The ensemble promise: a part going quiet names the agent that needs you, so a second
  // working session must be unaffected.
  const sessions = [
    session({ sessionId: 'a', working: false }),
    session({ sessionId: 'b', working: true }),
  ];
  const { orchestrator } = harness(sessions, fakeConfig({ gate: 'per-agent' }));

  const views = orchestrator.sessionViews();
  const silent = views.find((view) => view.sessionId === 'a');
  const sounding = views.find((view) => view.sessionId === 'b');

  assert.ok(silent?.voiceName, 'both sessions need voices for this to mean anything');
  assert.ok(sounding?.voiceName);
  assert.notEqual(silent.voiceName, sounding.voiceName, 'a voice must never be double-booked');
  assert.equal(silent.audible, false, 'the blocked agent should be silent');
  assert.equal(sounding.audible, true, 'the working agent should still sound');
});

test('the transport runs while anything sounds and pauses when nothing does', () => {
  const { scheduler } = harness([session({ sessionId: 'a', working: true })], fakeConfig());
  assert.ok(scheduler.calls.includes('play'));

  const stopped = harness([session({ sessionId: 'a', working: false })], fakeConfig());
  assert.ok(stopped.scheduler.calls.at(-1) === 'pause', 'nothing audible must pause the transport');
});

test('silence mode mute keeps the transport running through the quiet', () => {
  // Ducking rides audio we do not own, and there is no pausing another application's
  // stream, so the transport has to keep time even when every part is gated off.
  const { scheduler, mixer } = harness(
    [session({ sessionId: 'a', working: false })],
    fakeConfig({ silenceMode: 'mute' }),
  );
  assert.equal(mixer.anyAudible(), false);
  assert.equal(scheduler.calls.at(-1), 'play', 'mute must not pause the transport');
});

