import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, createConfigStore, handleFor, matchesHandle } from './config.ts';

const SESSION = { label: 'Rasa', sessionId: 'cb75a9e8-1234-5678-9abc-def012345678' };
const OTHER = { label: 'Rasa', sessionId: 'a83b9096-1234-5678-9abc-def012345678' };

/** LLMFM_HOME is the variable that redirects the config; the wrong one writes into the real install. */
function useTempHome(t: TestContext): void {
  const home = mkdtempSync(join(tmpdir(), 'llmfm-test-'));
  const previous = process.env['LLMFM_HOME'];
  process.env['LLMFM_HOME'] = home;
  t.after(() => {
    if (previous === undefined) delete process.env['LLMFM_HOME'];
    else process.env['LLMFM_HOME'] = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

test('the printed handle is what the user can type back', () => {
  assert.equal(handleFor(SESSION), 'Rasa (cb75a9e8)');
  assert.ok(matchesHandle(handleFor(SESSION), SESSION));
});

test('a folder label mutes every session in that folder', () => {
  // Session ids change on every restart, so a rule keyed on one would stop applying.
  assert.ok(matchesHandle('Rasa', SESSION));
  assert.ok(matchesHandle('Rasa', OTHER));
});

test('a full handle mutes only the session it names', () => {
  assert.ok(matchesHandle('Rasa (cb75a9e8)', SESSION));
  assert.equal(matchesHandle('Rasa (cb75a9e8)', OTHER), false);
});

test('a session id prefix matches, but a short fragment never does', () => {
  assert.ok(matchesHandle('cb75a9e8', SESSION));
  assert.ok(matchesHandle('cb75', SESSION));
  // Three characters would collide constantly and mute sessions the user never named.
  assert.equal(matchesHandle('cb7', SESSION), false);
});

test('matching ignores case and surrounding whitespace', () => {
  assert.ok(matchesHandle('  rasa  ', SESSION));
  assert.ok(matchesHandle('RASA (CB75A9E8)', SESSION));
});

test('an empty rule matches nothing', () => {
  // A blank line left in the config must not silence the whole orchestra.
  assert.equal(matchesHandle('', SESSION), false);
  assert.equal(matchesHandle('   ', SESSION), false);
});

test('an unrelated label does not match', () => {
  assert.equal(matchesHandle('llmfm', SESSION), false);
});

test('a session with no cwd does not print its id twice', () => {
  // File-sourced sessions carry no cwd, so their label is already the short id.
  const fileOnly = { label: 'cedd6c59', sessionId: 'cedd6c59-1111-2222-3333-444455556666' };
  assert.equal(handleFor(fileOnly), 'cedd6c59');
  assert.ok(matchesHandle(handleFor(fileOnly), fileOnly));
});

test('setMute is idempotent and persists the durable form', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  const session = { label: 'Rasa', sessionId: 'db68be72-1111-2222-3333-444455556666' };

  // preferLabel is what keeps a rule working after a restart, when the id has changed.
  store.setMute({ session, muted: true, preferLabel: true });
  assert.deepEqual(store.current().muted, ['Rasa']);

  // A key repeat sends the same call twice; it must not stack duplicate rules.
  store.setMute({ session, muted: true, preferLabel: true });
  assert.deepEqual(store.current().muted, ['Rasa']);

  store.setMute({ session, muted: false, preferLabel: true });
  assert.deepEqual(store.current().muted, []);
});

test('unmuting clears a rule the user wrote in another form', (t) => {
  useTempHome(t);

  const session = { label: 'Rasa', sessionId: 'db68be72-1111-2222-3333-444455556666' };
  const store = createConfigStore();
  store.setMute({ session, muted: true, preferLabel: false });
  assert.deepEqual(store.current().muted, ['Rasa (db68be72)']);

  // Unmuting must clear whatever form matches, not just the form it would have written.
  store.setMute({ session, muted: false, preferLabel: true });
  assert.deepEqual(store.current().muted, []);
});

test('mode and fade persist like any other setting', (t) => {
  useTempHome(t);

  // They used to live only in the orchestrator, so a restart silently reverted them.
  const store = createConfigStore();
  assert.equal(store.setSetting('mode', 'alert'), true);
  assert.equal(store.setSetting('fadeSeconds', 2.5), true);
  assert.equal(store.setSetting('mode', 'sideways'), false);
  assert.equal(store.current().mode, 'alert');

  const reopened = createConfigStore();
  assert.equal(reopened.current().mode, 'alert');
  assert.equal(reopened.current().fadeSeconds, 2.5);
});

test('one bad value in a hand-edited file costs only that setting', (t) => {
  useTempHome(t);

  writeFileSync(
    configPath(),
    JSON.stringify({ mode: 'nonsense', fadeSeconds: 3, autoplay: 'random', muted: ['Rasa'] }),
  );
  const store = createConfigStore();
  assert.equal(store.current().mode, 'reward');
  assert.equal(store.current().fadeSeconds, 3);
  assert.equal(store.current().autoplay, 'random');
  assert.deepEqual(store.current().muted, ['Rasa']);
});

/** The sound source is derived from whether a phone is connected, so it is no longer a key anyone can set. */
test('the sound source is not a settable key', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  assert.equal(store.setSetting('audio', 'duck'), false);
  assert.equal('audio' in store.current(), false);
});

test('Bluetooth receive survives a reopen on its own', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  assert.equal(store.current().bluetoothReceive, false);
  assert.equal(store.setSetting('bluetoothReceive', true), true);

  const reopened = createConfigStore();
  assert.equal(reopened.current().bluetoothReceive, true);
});

/** Every 0.9.0 config on disk holds `audio: duck`; honouring it would leave upgraders as silent as before. */
test('a sound source left by an older version is ignored', (t) => {
  useTempHome(t);

  writeFileSync(configPath(), JSON.stringify({ audio: 'duck', bluetoothReceive: false }));
  const store = createConfigStore();
  assert.equal('audio' in store.current(), false);
  assert.equal(store.current().bluetoothReceive, false);
});

/** The migration reaches outside the install, so a redirected home must not run it — it once carried the user's real config into a temp folder that then vanished. */
test('a redirected home never migrates the real config out of ~/.copilot', (t: TestContext) => {
  const legacyHome = mkdtempSync(join(tmpdir(), 'llmfm-legacy-'));
  const legacy = join(legacyHome, 'llmfm.config.json');
  writeFileSync(legacy, JSON.stringify({ muted: ['Precious'] }));
  const previousCopilot = process.env['COPILOT_HOME'];
  process.env['COPILOT_HOME'] = legacyHome;
  t.after(() => {
    if (previousCopilot === undefined) delete process.env['COPILOT_HOME'];
    else process.env['COPILOT_HOME'] = previousCopilot;
    rmSync(legacyHome, { recursive: true, force: true });
  });

  useTempHome(t);
  createConfigStore().current();

  assert.ok(existsSync(legacy), 'the legacy config was moved out from under the user');
});

/** Replacement by rename is what makes a kill mid-write survivable; the inode change is the evidence. */
test('a settings write replaces the file rather than truncating it in place', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  store.setSetting('fadeSeconds', 1.5);
  const before = statSync(configPath()).ino;
  store.setSetting('fadeSeconds', 2.5);
  const after = statSync(configPath()).ino;

  assert.notEqual(after, before, 'the config was written in place, so a kill can truncate it');
  assert.equal(existsSync(`${configPath()}.tmp`), false, 'a temp file was left behind');
  assert.equal(createConfigStore().current().fadeSeconds, 2.5);
});

/** A crash between write and rename leaves the temp file; the next write must reclaim it. */
test('a stray temp file from an interrupted write does not block the next one', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  store.setSetting('fadeSeconds', 1.5);
  writeFileSync(`${configPath()}.tmp`, 'truncated{');

  store.setSetting('fadeSeconds', 3.5);

  assert.equal(existsSync(`${configPath()}.tmp`), false);
  assert.equal(createConfigStore().current().fadeSeconds, 3.5);
});
