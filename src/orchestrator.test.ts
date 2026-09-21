import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from './orchestrator.ts';
import { SETTING_DEFAULTS } from './settings.ts';
import {
  BLOCK_SETTLE_MS,
  DEFAULT_PLAYLIST,
  FOLD_EVIDENCE_MAX_MS,
  MS_PER_MINUTE,
  PROMPT_GAP_RESUME_MS,
  SETTLE_MARGIN_MS,
  SUBAGENT_GRACE_MS,
  WORKING_CLAIM_MAX_MS,
} from './constants.ts';
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

/** Four families, so sessions land on different branches rather than sharing one voice. */
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

/** Gate state only; the real fade is the mixer's business and is tested there. */
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
  // The inversion has to reach the parts themselves, not merely be stored in config.
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
  // Bug: `permission_prompt` fires for pre-approved tools too, chopping holes in the music.
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
  // A muted voice gated silent would be indistinguishable from an agent waiting on the user.
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

/** The fade outlives the gate, so the pause lands on a timer rather than on the event that silenced the music. A client told nothing keeps extrapolating a transport that already stopped. */
test('the transport pausing after the fade notifies clients', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let audible = true;
  const mixer = { ...fakeMixer(), anyAudible: () => audible, anyGateOpen: () => false };
  const scheduler = fakeScheduler();
  let settled = 0;
  const orchestrator = createOrchestrator({
    registry: { list: () => [session({ sessionId: 'a', working: false })] } as unknown as SessionRegistry,
    mixer,
    scheduler,
    config: fakeConfig({ gate: 'any', silenceMode: 'pause', fadeSeconds: 1 }),
    onSettled: () => void (settled += 1),
  });
  built.push(orchestrator);
  orchestrator.bindScore(score());

  assert.equal(scheduler.calls.at(-1), 'play', 'the fade tail must keep the transport running');

  audible = false;
  t.mock.timers.tick(1000 + SETTLE_MARGIN_MS * 2 + 1);

  assert.equal(scheduler.calls.at(-1), 'pause', 'the settle must pause once the fade reaches silence');
  assert.ok(settled > 0, 'the pause must be announced, or the client never learns of it');
});

/** A recorded track pauses inside its own player once the fade reaches silence, so nothing in the gate path announces the stop. This is the mp3 half of the same bug. */
test('a recorded track going silent notifies clients', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const gates: boolean[] = [];
  let settled = 0;
  const orchestrator = createOrchestrator({
    registry: { list: () => [session({ sessionId: 'a', working: false })] } as unknown as SessionRegistry,
    mixer: fakeMixer(),
    scheduler: fakeScheduler(),
    config: fakeConfig({ gate: 'any', silenceMode: 'pause', fadeSeconds: 1 }),
    recorded: { setAudible: ({ audible }) => void gates.push(audible) },
    onSettled: () => void (settled += 1),
  });
  built.push(orchestrator);
  orchestrator.bindRecorded();

  assert.equal(gates.at(-1), false, 'an idle agent must close the gate');
  t.mock.timers.tick(1000 + SETTLE_MARGIN_MS * 2 + 1);

  assert.ok(settled > 0, 'the player pauses on its own timer, so the stop must still be announced');
});

test('silence mode mute keeps the transport running through the quiet', () => {
  const { scheduler, mixer } = harness(
    [session({ sessionId: 'a', working: false })],
    fakeConfig({ silenceMode: 'mute' }),
  );
  assert.equal(mixer.anyAudible(), false);
  assert.equal(scheduler.calls.at(-1), 'play', 'mute must not pause the transport');
});

/** Duck mode rides someone else's audio and has no transport of ours, so `silenceMode` must not reach it. */
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
        config: fakeConfig({ gate: 'any', silenceMode }),
        ducking: () => true,
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


/** The daemon can switch between the two mid-track, and only ever one of them holds the gate. */
test('ducking takes the gate from a recorded track, and gives it back', () => {
  const config = fakeConfig({ gate: 'any' });
  const recordedGates: boolean[] = [];
  const duckGates: boolean[] = [];
  let working = true;
  let ducking = false;
  const registry = {
    list: () => [session({ sessionId: 'a', working })],
  } as unknown as SessionRegistry;
  const orchestrator = createOrchestrator({
    registry,
    mixer: fakeMixer(),
    scheduler: fakeScheduler(),
    config,
    ducking: () => ducking,
    recorded: { setAudible: ({ audible }) => void recordedGates.push(audible) },
    duck: { setAudible: ({ audible }) => void duckGates.push(audible) },
  });
  built.push(orchestrator);
  orchestrator.bindRecorded();

  assert.deepEqual(recordedGates, [true], 'the recorded track holds the gate in midi mode');
  assert.deepEqual(duckGates, [], 'the duck was driven while it was not the mode');

  ducking = true;
  working = false;
  orchestrator.refresh();
  assert.deepEqual(duckGates, [false], 'the duck did not take the gate');
  assert.deepEqual(recordedGates, [true], 'the recorded sink was driven while ducking');

  ducking = false;
  orchestrator.refresh();
  assert.deepEqual(recordedGates, [true, false], 'the recorded track never got the gate back');
  assert.deepEqual(duckGates, [false], 'the duck was still driven after the switch back');
});

const REPO = '/repos/app';

/** Unlisted and past the grace window — all a sub-agent ever looks like from the outside. */
const subAgent = (over: Partial<Session> = {}): Session =>
  session({
    sessionId: 'sub',
    cwd: REPO,
    working: true,
    listedByCli: false,
    startedAt: Date.now() - SUBAGENT_GRACE_MS - 1,
    ...over,
  });

/** Between turns because it dispatched the work and is waiting on it. */
const parent = (over: Partial<Session> = {}): Session =>
  session({ sessionId: 'parent', cwd: REPO, working: false, ...over });

const viewOf = (orchestrator: ReturnType<typeof harness>['orchestrator'], sessionId: string) =>
  orchestrator.sessionViews().find((view) => view.sessionId === sessionId);

test('a parent waiting on a sub-agent keeps sounding, and says why', () => {
  // Bug: the parent fires agentStop the moment it hands off, so its voice faded mid-work.
  const { orchestrator } = harness([parent(), subAgent()], fakeConfig({ gate: 'per-agent' }));

  const view = viewOf(orchestrator, 'parent');
  assert.equal(view?.audible, true, 'the dispatching session must not fall silent');
  assert.equal(view?.folded, true, 'the row has to show the work is not its own');
  assert.equal(view?.working, false, 'folding must not rewrite what the CLI reported');
  assert.equal(viewOf(orchestrator, 'sub'), undefined, 'a folded sub-agent holds no voice');
});

test('a blocked parent stays silent however busy its sub-agents are', () => {
  // A prompt is a positive request for the user; inferred activity must never mask it.
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
  // cwd is the whole parent link, so a sub-agent elsewhere belongs to another session.
  const { orchestrator } = harness(
    [parent(), subAgent({ cwd: '/repos/other' })],
    fakeConfig({ gate: 'per-agent' }),
  );
  assert.equal(viewOf(orchestrator, 'parent')?.audible, false);
});


test('a working claim nothing can refresh eventually gives up its voice', () => {
  // Close the terminal mid-tool and the CLI leaves `working: true` in its file for ever.
  const killed = session({
    sessionId: 'a',
    working: true,
    updatedAt: Date.now() - WORKING_CLAIM_MAX_MS - 1,
  });
  const { orchestrator, mixer } = harness([killed], fakeConfig({ gate: 'per-agent' }));

  assert.equal(viewOf(orchestrator, 'a')?.voiceName, null, 'a dead claim must hold no voice');
  assert.equal(mixer.anyAudible(), false);
});

test('a long tool call is not mistaken for a dead terminal', () => {
  const busy = session({
    sessionId: 'a',
    working: true,
    updatedAt: Date.now() - WORKING_CLAIM_MAX_MS + MS_PER_MINUTE,
  });
  const { orchestrator } = harness([busy], fakeConfig({ gate: 'per-agent' }));

  assert.equal(viewOf(orchestrator, 'a')?.audible, true, 'silencing a live agent is the inverse lie');
});

test('folding expires, so a dead sub-agent stops holding its parent on', () => {
  // The registry can never retire an unlisted sub-agent, so the inference has to expire.
  const dead = subAgent({ updatedAt: Date.now() - FOLD_EVIDENCE_MAX_MS - 1 });
  const { orchestrator } = harness([parent(), dead], fakeConfig({ gate: 'per-agent' }));

  const view = viewOf(orchestrator, 'parent');
  assert.equal(view?.folded, false, 'stale evidence must not keep claiming work');
  assert.equal(view?.audible, false);
});

test('resume brings the music back on its own clock', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const gates: boolean[] = [];
  const blocked = session({
    sessionId: 'a',
    working: false,
    blockedMidTurn: true,
    blockedSince: Date.now(),
  });
  const orchestrator = createOrchestrator({
    registry: { list: () => [blocked] } as unknown as SessionRegistry,
    mixer: fakeMixer(),
    scheduler: fakeScheduler(),
    config: fakeConfig({ gate: 'any', promptGap: 'resume' }),
    ducking: () => true,
    duck: { setAudible: ({ audible }) => void gates.push(audible) },
  });
  built.push(orchestrator);
  orchestrator.bindScore(score());

  assert.equal(gates.at(-1), true, 'an unsettled block must not cut the music');
  t.mock.timers.tick(BLOCK_SETTLE_MS + SETTLE_MARGIN_MS + 1);
  assert.equal(gates.at(-1), false, 'a settled block silences');

  // Approving a prompt fires no hook, so only a scheduled wake can resume the music here.
  t.mock.timers.tick(PROMPT_GAP_RESUME_MS + SETTLE_MARGIN_MS + 1);
  assert.equal(gates.at(-1), true, 'resume must wake itself at the prompt-gap mark');
});