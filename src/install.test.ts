import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { installHooks, installedHookPath, hooksPointHere } from './install.ts';

function useTempCopilotHome(t: TestContext): void {
  const home = mkdtempSync(join(tmpdir(), 'llmfm-hooks-'));
  const previous = process.env['COPILOT_HOME'];
  process.env['COPILOT_HOME'] = home;
  t.after(() => {
    if (previous === undefined) delete process.env['COPILOT_HOME'];
    else process.env['COPILOT_HOME'] = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

test('a config we just wrote is recognised as ours', (t: TestContext) => {
  useTempCopilotHome(t);

  assert.equal(hooksPointHere(), false, 'nothing is installed yet');
  installHooks();
  assert.equal(hooksPointHere(), true);
});

/** Deleting the folder leaves the machine-level config behind, pointing at a path that is gone. Its hooks then fail silently and every session reads as idle forever. */
test('a config left by a copy that no longer exists is not mistaken for ours', (t: TestContext) => {
  useTempCopilotHome(t);

  const target = installedHookPath();
  mkdirSync(dirname(target), { recursive: true });
  const stale = {
    version: 1,
    hooks: {
      sessionStart: [
        {
          type: 'command',
          exec: 'node',
          args: ['C:\\Users\\someone\\Downloads\\llmfm-old\\hooks\\notify.js', 'sessionStart'],
          timeoutSec: 5,
        },
      ],
    },
  };
  writeFileSync(target, `${JSON.stringify(stale, null, 2)}\n`);

  assert.equal(hooksPointHere(), false, 'a stale path must not read as installed');
  installHooks();
  assert.equal(hooksPointHere(), true, 'reinstalling must adopt the config');
  assert.equal(
    readFileSync(target, 'utf8').includes('llmfm-old'),
    false,
    'the dead path must be gone, not merged alongside ours',
  );
});
