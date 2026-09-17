import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from './orchestrator.ts';
import { SETTING_DEFAULTS } from './settings.ts';
import { BLOCK_SETTLE_MS, DEFAULT_PLAYLIST, SUBAGENT_GRACE_MS } from './constants.ts';
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
  let config: LlmfmConfig = {
    muted: [],
    playlist: DEFAULT_PLAYLIST,
    ...SETTING_DEFAULTS,
    ...over,
  };
  return {
    current: () => config,
    setMute: () => {},
    setSetting(key, value) {
      config = { ...config, [key]: value } as LlmfmConfig;
      return true;
    },
    setPlaylist(name) {
      config = { ...config, playlist: name };
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

  const stopped = harness(
    [session({ sessionId: 'a', working: false })],
    fakeConfig({ silenceMode: 'pause' }),
  );
  assert.ok(stopped.scheduler.calls.at(-1) === 'pause', 'nothing audible must pause the transport');
});

test('silence mode mute keeps the transport running through the quiet', () => {
  const { scheduler, mixer } = harness(
    [session({ sessionId: 'a', working: false })],
    fakeConfig({ silenceMode: 'mute' }),
  );
  assert.equal(mixer.anyAudible(), false);
  assert.equal(scheduler.calls.at(-1), 'play', 'mute must not pause the transport');
});

/** Duck mode rides audio on a device that is not ours, where the output level is the only
 *  lever there is. `silenceMode` describes a transport of our own that duck mode does not
 *  have, so it must not reach the duck in either position. */
test('duck mode answers to the gate alone, whatever "on silence" says', () => {
  for (const silenceMode of ['pause', 'mute'] as const) {
    for (const working of [true, false]) {
      const mixer = fakeMixer();
      const scheduler = fakeScheduler();
      const gates: boolean[] = [];
      const registry = {
        list: () => [session({ sessionId: 'a', working })],
      } as unknown as SessionRegistry;
      const orchestrator = createOrchestrator({
        registry,
        mixer,
        scheduler,
        config: fakeConfig({ audio: 'duck', gate: 'any', silenceMode }),
        duck: { setAudible: ({ audible }) => void gates.push(audible) },
      });
      built.push(orchestrator);
      orchestrator.bindScore(score());

      const where = `${silenceMode}/${working ? 'working' : 'idle'}`;
      assert.deepEqual(gates, [working], `${where}: the duck did not follow the gate`);
      assert.deepEqual(scheduler.calls, [], `${where}: our own transport must stay stopped`);
    }
  }
});


/** A recorded mixdown and someone else's stream are the same shape of problem — one
 *  stream nobody can subdivide — and the daemon can be switched between them mid-track.
 *  Only ever one of them is the gate. */
test('ducking takes the gate from a recorded track, and gives it back', () => {
  const config = fakeConfig({ audio: 'midi', gate: 'any' });
  const recordedGates: boolean[] = [];
  const duckGates: boolean[] = [];
  let working = true;
  const registry = {
    list: () => [session({ sessionId: 'a', working })],
  } as unknown as SessionRegistry;
  const orchestrator = createOrchestrator({
    registry,
    mixer: fakeMixer(),
    scheduler: fakeScheduler(),
    config,
    recorded: { setAudible: ({ audible }) => void recordedGates.push(audible) },
    duck: { setAudible: ({ audible }) => void duckGates.push(audible) },
  });
  built.push(orchestrator);
  orchestrator.bindRecorded();

  assert.deepEqual(recordedGates, [true], 'the recorded track holds the gate in midi mode');
  assert.deepEqual(duckGates, [], 'the duck was driven while it was not the mode');

  config.setSetting('audio', 'duck');
  working = false;
  orchestrator.refresh();
  assert.deepEqual(duckGates, [false], 'the duck did not take the gate');
  assert.deepEqual(recordedGates, [true], 'the recorded sink was driven while ducking');

  config.setSetting('audio', 'midi');
  orchestrator.refresh();
  assert.deepEqual(recordedGates, [true, false], 'the recorded track never got the gate back');
  assert.deepEqual(duckGates, [false], 'the duck was still driven after the switch back');
});

const REPO = '/repos/app';

/** A session the CLI never listed, old enough that the file's lag no longer explains it.
 *  This is all a sub-agent ever looks like from the outside. */
const subAgent = (over: Partial<Session> = {}): Session =>
  session({
    sessionId: 'sub',
    cwd: REPO,
    working: true,
    listedByCli: false,
    startedAt: Date.now() - SUBAGENT_GRACE_MS - 1,
    ...over,
  });

/** The session the user is sitting in front of, between turns because it dispatched the
 *  work and is waiting on it. */
const parent = (over: Partial<Session> = {}): Session =>
  session({ sessionId: 'parent', cwd: REPO, working: false, ...over });

const viewOf = (orchestrator: ReturnType<typeof harness>['orchestrator'], sessionId: string) =>
  orchestrator.sessionViews().find((view) => view.sessionId === sessionId);

test('a parent waiting on a sub-agent keeps sounding, and says why', () => {
  // The defect this exists to prevent: the parent fires agentStop the moment it hands off,
  // so its voice faded while the work ran on and the silence claimed the user was needed.
  const { orchestrator } = harness([parent(), subAgent()], fakeConfig({ gate: 'per-agent' }));

  const view = viewOf(orchestrator, 'parent');
  assert.equal(view?.audible, true, 'the dispatching session must not fall silent');
  assert.equal(view?.folded, true, 'the row has to show the work is not its own');
  assert.equal(view?.working, false, 'folding must not rewrite what the CLI reported');
  assert.equal(viewOf(orchestrator, 'sub'), undefined, 'a folded sub-agent holds no voice');
});

test('a blocked parent stays silent however busy its sub-agents are', () => {
  // The hard rule. A permission prompt is a positive request for the user, and inferred
  // activity that talked over it would mask exactly the moment the product exists for.
  const blocked = parent({
    blockedMidTurn: true,
    blockedSince: Date.now() - BLOCK_SETTLE_MS - 1,
  });
  const { orchestrator } = harness([blocked, subAgent()], fakeConfig({ gate: 'per-agent' }));

  const view = viewOf(orchestrator, 'parent');
  assert.equal(view?.audible, false, 'a prompt must outrank a working sub-agent');
  assert.equal(view?.folded, false);
});

test('ignore leaves the parent silent, voice gives the sub-agent its own part', () => {
  const ignored = harness(
    [parent(), subAgent()],
    fakeConfig({ gate: 'per-agent', subagents: 'ignore' }),
  );
  assert.equal(viewOf(ignored.orchestrator, 'parent')?.audible, false);
  assert.equal(viewOf(ignored.orchestrator, 'sub'), undefined, 'ignore means unlisted too');

  const voiced = harness(
    [parent(), subAgent()],
    fakeConfig({ gate: 'per-agent', subagents: 'voice' }),
  );
  const sub = viewOf(voiced.orchestrator, 'sub');
  assert.ok(sub?.voiceName, 'voice mode gives a sub-agent an instrument of its own');
  assert.equal(sub.audible, true, 'and it sounds on its own work');
  assert.equal(
    viewOf(voiced.orchestrator, 'parent')?.audible,
    false,
    'a sub-agent with its own voice is not also folded into its parent',
  );
});

test('a sub-agent on another repo does not hold a parent on', () => {
  // cwd is the whole parent link, so a sub-agent that does not share one belongs to
  // someone else's session and must not speak for this one.
  const { orchestrator } = harness(
    [parent(), subAgent({ cwd: '/repos/other' })],
    fakeConfig({ gate: 'per-agent' }),
  );
  assert.equal(viewOf(orchestrator, 'parent')?.audible, false);
});
