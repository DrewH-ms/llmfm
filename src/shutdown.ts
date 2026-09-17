import { SHUTDOWN_GRACE_MS } from './constants.ts';

/** When one process runs both the daemon and the dashboard, the dashboard owns every
 *  exit path — and an exit that skips the daemon's teardown leaves the user muted. The
 *  launcher registers its teardown here; the dashboard awaits it before exiting. It runs
 *  at most once, never rejects, and cannot hold the exit open indefinitely. */
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
