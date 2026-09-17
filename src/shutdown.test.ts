import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onShutdown, runShutdown } from './shutdown.ts';

/** One module instance holds one teardown, so both properties that matter are asserted
 *  against the same call: it runs exactly once, and a teardown that throws still
 *  resolves, because a rejection here would stop the process exiting at all. */
test('runs the teardown once, and survives it throwing', async () => {
  let calls = 0;
  onShutdown(async () => {
    calls += 1;
    throw new Error('bridge is already gone');
  });
  await assert.doesNotReject(() => Promise.all([runShutdown(), runShutdown()]));
  await runShutdown();
  assert.equal(calls, 1);
});
