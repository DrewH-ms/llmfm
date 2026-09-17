import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onShutdown, runShutdown } from './shutdown.ts';

/** A teardown that throws must still resolve, or a rejection here stops the process exiting at all. */
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
