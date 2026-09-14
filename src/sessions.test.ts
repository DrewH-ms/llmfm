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

function workingOf(registry: ReturnType<typeof createSessionRegistry>): boolean {
  const session = registry.list().find((entry) => entry.sessionId === SESSION_ID);
  assert.ok(session, 'session should still be tracked');
  return session.working;
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

test('a session without hooks is driven entirely by the file', () => {
  const registry = createSessionRegistry();

  registry.applyFileState([{ sessionId: SESSION_ID, working: true }]);
  assert.equal(workingOf(registry), true);

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
