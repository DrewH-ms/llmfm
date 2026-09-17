import { SHUTDOWN_GRACE_MS } from './constants.ts';

/** An exit that skips the daemon's teardown leaves the user muted; runs at most once, never rejects, cannot hold the exit open. */
let teardown: (() => Promise<void>) | null = null;
let running: Promise<void> | null = null;

export function onShutdown(handler: () => Promise<void>): void {
  teardown = handler;
}

export function runShutdown(): Promise<void> {
  running ??= Promise.race([
    (teardown?.() ?? Promise.resolve()).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref()),
  ]);
  return running;
}
