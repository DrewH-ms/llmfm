import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createSessionRegistry } from './sessions.ts';
import { HOOK_AUTHORITY_MS } from './constants.ts';
import type { HookEventName } from './constants.ts';
import type { HookEvent, OpenSessionEntry } from './types.ts';

const SESSION_ID = 'db68be72-4a96-42a5-9631-ce6d32687dee';
/** Roughly the age of the oldest entries sitting in the author's own state file. */
const DAYS_OLD_MS = 57 * 60 * 60 * 1000;

function hookEvent(name: HookEventName, notificationType: string | null = null): HookEvent {
  return { name, sessionId: SESSION_ID, cwd: 'C:\\repo', notificationType };
}

function fileEntry(working: boolean, refreshedAt: number | null = null): OpenSessionEntry {
  return { sessionId: SESSION_ID, working, refreshedAt };
}

/** Moves past the window in which a hook reading outranks the file. */
function elapseHookAuthority(t: TestContext): void {
  t.mock.timers.tick(HOOK_AUTHORITY_MS + 1);
}

function sessionOf(registry: ReturnType<typeof createSessionRegistry>) {
  const session = registry.list().find((entry) => entry.sessionId === SESSION_ID);
  assert.ok(session, 'session should still be tracked');
  return session;
}

function workingOf(registry: ReturnType<typeof createSessionRegistry>): boolean {
  return sessionOf(registry).working;
}

test('the file may not restore a session the hooks have silenced', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyFileState([fileEntry(true)]);
  registry.applyHookEvent(hookEvent('agentStop'));
  assert.equal(workingOf(registry), false);

  // A background process keeps the CLI reporting the session as busy long after the
  // agent handed control back. The file cannot tell the two apart.
  elapseHookAuthority(t);
  registry.applyFileState([fileEntry(true)]);

  assert.equal(workingOf(registry), false, 'agentStop must survive a busy file reading');
});

test('the file may not restore a session blocked mid-turn', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));
  assert.equal(workingOf(registry), false);

  elapseHookAuthority(t);
  registry.applyFileState([fileEntry(true)]);

  assert.equal(workingOf(registry), false, 'a permission prompt must survive the file');
});

test('the file may still silence a session whose agentStop was missed', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  assert.equal(workingOf(registry), true);

  elapseHookAuthority(t);
  registry.applyFileState([fileEntry(false)]);

  assert.equal(workingOf(registry), false, 'the file must remain able to stop the music');
});

test('the file registers a session it cannot vouch for, without starting it', () => {
  const registry = createSessionRegistry();

  // A session the hooks have never reported -- opened before install, or resumed
  // elsewhere. The file knows it exists, which is worth recording: it is what tells a
  // real session apart from a sub-agent. What the file cannot do is vouch for the work,
  // so the session is registered silent rather than sounding on an unverifiable claim.
  registry.applyFileState([fileEntry(true)]);
  assert.equal(workingOf(registry), false);

  registry.applyFileState([fileEntry(false)]);
  assert.equal(workingOf(registry), false);
});

test('a repeated permission prompt leaves the session blocked exactly once', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));
  assert.equal(workingOf(registry), false);

  registry.applyHookEvent(hookEvent('postToolUse'));

  assert.equal(workingOf(registry), true, 'approval must resume after a duplicate prompt');
});

test('a session the file never lists stays unlisted, marking it a sub-agent', () => {
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  const session = registry.list().find((entry) => entry.sessionId === SESSION_ID);
  assert.ok(session);

  assert.equal(session.listedByCli, false, 'hooks alone never prove the CLI listed it');
  assert.equal(session.source, 'hook');
});

test('the file listing a hook session upgrades it even when nothing else changed', () => {
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  // Same working state the hook already set, so the entry is otherwise a no-op. The
  // listing itself is the news: it is what separates a real session from a sub-agent.
  registry.applyFileState([fileEntry(true)]);

  const session = registry.list().find((entry) => entry.sessionId === SESSION_ID);
  assert.ok(session);
  assert.equal(session.listedByCli, true, 'the flag must not go stale behind a no-op');
});

test('startedAt is fixed for the lifetime of a session', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  const first = registry.list()[0];
  assert.ok(first);

  // A busy sub-agent refreshes updatedAt constantly; ageing off updatedAt would mean it
  // never aged out at all.
  t.mock.timers.tick(60_000);
  registry.applyHookEvent(hookEvent('postToolUse'));

  const later = registry.list()[0];
  assert.ok(later);
  assert.equal(later.startedAt, first.startedAt);
  assert.notEqual(later.updatedAt, first.updatedAt);
});

test('a busy sub-agent does not let the file wake the session that dispatched it', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();
  const SUB_ID = 'f0e7c1a2-0000-4000-8000-000000000001';

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyFileState([fileEntry(true)]);
  registry.applyHookEvent(hookEvent('agentStop'));

  // The CLI stays busy while the sub-agent it dispatched runs, and reports the parent
  // working again. Attributing that work is the orchestrator's job, and only under the
  // rules it applies there; a registry that took the file's word would sound the parent
  // even while it sat on a prompt.
  registry.applyHookEvent({ ...hookEvent('preToolUse'), sessionId: SUB_ID });
  elapseHookAuthority(t);
  registry.applyFileState([fileEntry(true)]);

  assert.equal(workingOf(registry), false, 'the file must not assert work for the parent');
  const sub = registry.list().find((entry) => entry.sessionId === SUB_ID);
  assert.equal(sub?.working, true, 'the sub-agent is the only one actually working');
  assert.equal(sub?.listedByCli, false, 'and it is unlisted, which is what marks it one');
});

test('a repeated prompt notification does not restart the block clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));
  const first = sessionOf(registry).blockedSince;
  assert.ok(first !== null);

  // The CLI re-announces the same pending prompt. Taking the age from updatedAt here
  // would report the block as new, hiding precisely the long wait it exists to surface.
  t.mock.timers.tick(30_000);
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));

  assert.equal(sessionOf(registry).blockedSince, first);
});

test('clearing a block clears the block clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));
  registry.applyHookEvent(hookEvent('postToolUse'));

  assert.equal(sessionOf(registry).blockedSince, null);
});

test('a cold start does not bring pre-existing sessions up working', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  // The daemon starts with sessions already open. The file is the only signal it has,
  // and it reports every one of them busy -- including agents sitting on a prompt.
  registry.applyFileState([fileEntry(true)]);
  assert.equal(workingOf(registry), false, 'the file may not assert work on its own');

  // Nor on any later poll: an idle agent fires no hook, so nothing would correct it.
  t.mock.timers.tick(HOOK_AUTHORITY_MS + 1);
  registry.applyFileState([fileEntry(true)]);
  assert.equal(workingOf(registry), false);

  // A genuinely busy session still corrects itself on its next hook event.
  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  assert.equal(workingOf(registry), true);
});


test('a file entry is dated by the CLI, not by when the daemon happened to start', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.tick(DAYS_OLD_MS * 2);
  const registry = createSessionRegistry();
  const closedOnSunday = Date.now() - DAYS_OLD_MS;

  // The CLI never deletes an entry, so a cold start sees terminals that closed days ago.
  // Registering them as if they had just appeared hands each one an instrument for the
  // whole idle-dropout window -- and leaves nothing for the session actually running.
  registry.applyFileState([fileEntry(false, closedOnSunday)]);

  assert.equal(sessionOf(registry).updatedAt, closedOnSunday);
  assert.equal(sessionOf(registry).startedAt, closedOnSunday);
});

test('an entry with no usable timestamp still registers', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.tick(DAYS_OLD_MS);
  const registry = createSessionRegistry();

  registry.applyFileState([fileEntry(false, null)]);

  assert.equal(sessionOf(registry).updatedAt, Date.now());
});

test('a block arriving after the agent stopped tells the listeners', () => {
  const registry = createSessionRegistry();
  let changes = 0;
  registry.onChange(() => void (changes += 1));

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyHookEvent(hookEvent('agentStop'));
  const beforeBlock = changes;

  // `working` is already false, so nothing else about the session changes -- but the
  // block decides whether a sub-agent may fold the voice back on. Unannounced, the music
  // keeps the gate it last computed and plays straight over the permission prompt.
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));
  assert.equal(changes, beforeBlock + 1, 'a new block must reach the mixer');

  registry.applyHookEvent(hookEvent('postToolUse'));
  assert.equal(changes, beforeBlock + 2, 'and so must its release');
});

test('the poller does not re-create a session the hooks ended', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyFileState([fileEntry(true, Date.now())]);
  registry.applyHookEvent(hookEvent('sessionEnd'));
  assert.equal(registry.list().length, 0);

  // The CLI leaves ended sessions in its file for days, so every later poll offers this
  // id back. Taking it would resurrect a closed terminal a quarter-second after the one
  // authoritative signal that it is over.
  t.mock.timers.tick(HOOK_AUTHORITY_MS + 1);
  registry.applyFileState([fileEntry(false, Date.now())]);

  assert.deepEqual(registry.list(), [], 'sessionEnd must outlive the file entry');
});

test('a resumed session comes back despite having been ended', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyHookEvent(hookEvent('sessionEnd'));
  registry.applyFileState([fileEntry(false, Date.now())]);

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  assert.equal(workingOf(registry), true, 'a hook is authoritative over its own tombstone');

  t.mock.timers.tick(HOOK_AUTHORITY_MS + 1);
  registry.applyFileState([fileEntry(false, Date.now())]);
  assert.equal(sessionOf(registry).listedByCli, true, 'and the file may list it again');
});