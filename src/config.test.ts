import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, createConfigStore, handleFor, matchesHandle } from './config.ts';

const SESSION = { label: 'Rasa', sessionId: 'cb75a9e8-1234-5678-9abc-def012345678' };
const OTHER = { label: 'Rasa', sessionId: 'a83b9096-1234-5678-9abc-def012345678' };

/** Points the config at a throwaway home, so a test writes a real file rather than a
 *  stubbed one and the user's own config is never the thing under test. LLMFM_HOME is the
 *  variable that moves it: set the wrong one and this writes into the real install. */
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
  // The point of the label form: session ids change on every restart, so a rule keyed on
  // one would silently stop applying the next morning.
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

  // Repeating the same call must not stack duplicate rules; a key repeat sends it twice.
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

  // They used to live only in the orchestrator, so a restart silently reverted them and
  // the fade the user had set was never the fade they got back.
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

/** Bluetooth receive has no gate of its own: the phone's stream is silenced only by duck
 *  mode's endpoint mute. Left alone with `audio: 'midi'` it plays on under our own score
 *  while an agent waits, which is the failure the whole product is defined against. */
test('turning Bluetooth receive on switches the sound source to ducking', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  assert.equal(store.setSetting('audio', 'midi'), true);
  assert.equal(store.current().audio, 'midi');
  assert.equal(store.setSetting('bluetoothReceive', true), true);
  assert.equal(store.current().audio, 'duck');
  assert.equal(store.current().bluetoothReceive, true);

  const reopened = createConfigStore();
  assert.equal(reopened.current().audio, 'duck');
  assert.equal(reopened.current().bluetoothReceive, true);
});

test('choosing the MIDI score turns Bluetooth receive off', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  store.setSetting('bluetoothReceive', true);
  assert.equal(store.setSetting('audio', 'midi'), true);
  assert.equal(store.current().audio, 'midi');
  assert.equal(store.current().bluetoothReceive, false);
});

test('a hand-edited file holding both Bluetooth and MIDI is repaired on load', (t) => {
  useTempHome(t);

  writeFileSync(configPath(), JSON.stringify({ audio: 'midi', bluetoothReceive: true }));
  const store = createConfigStore();
  assert.equal(store.current().bluetoothReceive, true);
  assert.equal(store.current().audio, 'duck');
});

/** The migration reaches outside the install by design, to a path a redirected home does
 *  not move. It must therefore not run at all when the home has been redirected — or a
 *  test pointed at a temp folder carries the user's real config off into it, and takes it
 *  with the temp folder when it goes. That is not hypothetical; it happened. */
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

/** The file holds every tuned setting, and a truncated one parses as nothing, so the
 *  next start would come up on defaults with no error shown. Replacement by rename is
 *  what makes a kill mid-write survivable; the identity change is the evidence that the
 *  bytes never went into the live file. */
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

/** A crash between write and rename leaves the temp file; the next write must reclaim it
 *  rather than fail or start a second one. */
test('a stray temp file from an interrupted write does not block the next one', (t) => {
  useTempHome(t);

  const store = createConfigStore();
  store.setSetting('fadeSeconds', 1.5);
  writeFileSync(`${configPath()}.tmp`, 'truncated{');

  store.setSetting('fadeSeconds', 3.5);

  assert.equal(existsSync(`${configPath()}.tmp`), false);
  assert.equal(createConfigStore().current().fadeSeconds, 3.5);
});
