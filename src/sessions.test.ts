import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createSessionRegistry } from './sessions.ts';
import { HOOK_AUTHORITY_MS } from './constants.ts';
import type { HookEventName } from './constants.ts';
import type { HookEvent } from './types.ts';

const SESSION_ID = 'db68be72-4a96-42a5-9631-ce6d32687dee';

function hookEvent(name: HookEventName, notificationType: string | null = null): HookEvent {
  return { name, sessionId: SESSION_ID, cwd: 'C:\\repo', notificationType };
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
  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);
  registry.applyHookEvent(hookEvent('agentStop'));
  assert.equal(workingOf(registry), false);

  // A background process keeps the CLI reporting the session as busy long after the
  // agent handed control back. The file cannot tell the two apart.
  elapseHookAuthority(t);
  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);

  assert.equal(workingOf(registry), false, 'agentStop must survive a busy file reading');
});

test('the file may not restore a session blocked mid-turn', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  registry.applyHookEvent(hookEvent('notification', 'permission_prompt'));
  assert.equal(workingOf(registry), false);

  elapseHookAuthority(t);
  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);

  assert.equal(workingOf(registry), false, 'a permission prompt must survive the file');
});

test('the file may still silence a session whose agentStop was missed', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const registry = createSessionRegistry();

  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  assert.equal(workingOf(registry), true);

  elapseHookAuthority(t);
  registry.applyFileState([{ sessionId: SESSION_ID, working: false }]);

  assert.equal(workingOf(registry), false, 'the file must remain able to stop the music');
});

test('the file registers a session it cannot vouch for, without starting it', () => {
  const registry = createSessionRegistry();

  // A session the hooks have never reported -- opened before install, or resumed
  // elsewhere. The file knows it exists, which is worth recording: it is what tells a
  // real session apart from a sub-agent. What the file cannot do is vouch for the work,
  // so the session is registered silent rather than sounding on an unverifiable claim.
  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);
  assert.equal(workingOf(registry), false);

  registry.applyFileState([{ sessionId: SESSION_ID, working: false }]);
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
  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);

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
  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);
  assert.equal(workingOf(registry), false, 'the file may not assert work on its own');

  // Nor on any later poll: an idle agent fires no hook, so nothing would correct it.
  t.mock.timers.tick(HOOK_AUTHORITY_MS + 1);
  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);
  assert.equal(workingOf(registry), false);

  // A genuinely busy session still corrects itself on its next hook event.
  registry.applyHookEvent(hookEvent('userPromptSubmitted'));
  assert.equal(workingOf(registry), true);
});
