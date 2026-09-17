import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { DaemonState } from './types.ts';
import type { BluetoothDevice } from './bluetooth-receive.ts';

/** A port of its own, so a test never answers to — or fights with — a daemon the user has
 *  running. Set before the modules that read it are loaded, which is why they are imported
 *  dynamically here. */
const TEST_PORT = '7791';
process.env['LLMFM_PORT'] = TEST_PORT;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;

const { startApi } = await import('./api.ts');
const { SETTING_DEFAULTS, SETTING_SPECS } = await import('./settings.ts');

const PAIRED: BluetoothDevice[] = [{ id: 'bt-device-id', name: 'The Static' }];

let connected: string | null = null;
/** Lets a test fail the radio the way switching it off does. */
let bluetoothFails = false;
let hookEvents = 0;

function daemonState(): DaemonState {
  return {
    mode: SETTING_DEFAULTS.mode,
    fadeSeconds: SETTING_DEFAULTS.fadeSeconds,
    simulating: false,
    track: null,
    transport: { playing: false, position: 0, duration: 0 },
    midi: { ready: false, device: null, error: null },
    duck: { ready: false, deviceId: null, gated: false, gatedSessions: 0, error: null },
    bluetooth: {
      ready: true,
      state: connected ? 'Opened' : 'None',
      device: connected ? (PAIRED[0] ?? null) : null,
      error: null,
    },
    sessions: [],
    config: { ...SETTING_DEFAULTS, muted: [], playlist: 'all' },
    settingSpecs: SETTING_SPECS,
    playlistsDir: '',
  };
}

const HANDLERS = {
  onHookEvent: () => {
    hookEvents += 1;
  },
  onSetMode: () => {},
  onSetFade: () => {},
  onSimulate: () => {},
  onSetMute: () => {},
  onSetSetting: () => true,
  listBluetooth: () =>
    bluetoothFails
      ? Promise.reject(new Error('bluetooth scan timed out'))
      : Promise.resolve(PAIRED),
  onConnectBluetooth({ id }: { id: string }) {
    const known = PAIRED.some((device) => device.id === id);
    if (known) connected = id;
    return Promise.resolve(known);
  },
  tracks: () => [],
  playlists: () => [],
  onSetPlaylist: () => true,
  onSetTrack: () => true,
  onSkipTrack: () => true,
  state: daemonState,
};

const api = await startApi(HANDLERS);

test.after(() => api.stop());

test('the paired devices are published for a dashboard that cannot call the radio itself', async () => {
  const response = await fetch(`${BASE_URL}/bluetooth/devices`);
  assert.ok(response.ok);
  assert.deepEqual(await response.json(), { devices: PAIRED });
});

test('connecting answers with the state the link reached', async () => {
  const response = await fetch(`${BASE_URL}/bluetooth/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: PAIRED[0]?.id }),
  });
  assert.ok(response.ok);
  const state = (await response.json()) as DaemonState;
  assert.equal(state.bluetooth.state, 'Opened');
  assert.equal(state.bluetooth.device?.name, 'The Static');
});

test('a device that gave us no connection is a rejected request, not a silent no-op', async () => {
  for (const body of [{}, { id: '' }, { id: 'no-such-device' }]) {
    const response = await fetch(`${BASE_URL}/bluetooth/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, HTTP_BAD_REQUEST);
  }
});

/** P9 — a route whose work rejects must answer the client and leave the daemon alive,
 *  because the daemon dying is the daemon dying with the user's audio still muted. */
test('a rejected bluetooth scan is a 500, not an unhandled rejection', async () => {
  bluetoothFails = true;
  try {
    const response = await fetch(`${BASE_URL}/bluetooth/devices`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, HTTP_INTERNAL_ERROR);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  } finally {
    bluetoothFails = false;
  }
  const after = await fetch(`${BASE_URL}/state`);
  assert.ok(after.ok);
});

/** P17 — a second daemon must be told the port is taken, not kill the process with an
 *  EventEmitter error the caller cannot catch. */
test('a port already bound rejects the start rather than crashing', async () => {
  await assert.rejects(
    () => startApi(HANDLERS),
    (error: NodeJS.ErrnoException) => {
      assert.match(error.message, /already in use/);
      assert.equal(error.code, 'EADDRINUSE');
      return true;
    },
  );
});

/** P19 — a page the user has open can reach loopback. It cannot suppress these headers,
 *  and the daemon's own callers never send them. */
test('a browser-shaped request cannot drive the gate', async () => {
  const before = hookEvents;
  const forged = await fetch(`${BASE_URL}/event?name=notification`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      origin: 'https://example.invalid',
      'sec-fetch-site': 'cross-site',
    },
    body: '{"sessionId":"aaaaaaaa-0000-0000-0000-000000000000","notification_type":"permission"}',
  });
  assert.equal(forged.status, HTTP_NOT_FOUND);
  assert.equal(hookEvents, before);

  for (const headers of [
    { origin: 'https://example.invalid' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await fetch(`${BASE_URL}/state`, { headers });
    assert.equal(response.status, HTTP_NOT_FOUND);
  }
});

/** P19 — the Host check is what closes DNS rebinding, the only variant that makes the
 *  session list, and every session's cwd, readable. `fetch` cannot forge a Host header,
 *  so the raw client is the only way to state the case. */
test('a request resolved through a foreign hostname is refused before it reads state', async () => {
  const statusFor = (host: string | null): Promise<number> =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: Number(TEST_PORT),
          path: '/state',
          setHost: false,
          headers: host === null ? {} : { host },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });

  for (const host of ['attacker.invalid', `attacker.invalid:${TEST_PORT}`]) {
    assert.equal(await statusFor(host), HTTP_NOT_FOUND);
  }
  // Node's own parser rejects an absent or empty Host before a handler sees it.
  for (const host of ['', null]) {
    assert.notEqual(await statusFor(host), HTTP_OK);
  }
  for (const host of [`127.0.0.1:${TEST_PORT}`, `localhost:${TEST_PORT}`]) {
    assert.equal(await statusFor(host), HTTP_OK);
  }
});

/** P19 — the two callers that must keep working. The hook is run as its own process by
 *  the CLI, so it is checked as one rather than imitated. */
test('the real hook script is still admitted', async () => {
  const before = hookEvents;
  const hook = spawn(process.execPath, [join(import.meta.dirname, '..', 'hooks', 'notify.js'), 'notification'], {
    env: { ...process.env, LLMFM_URL: BASE_URL },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  hook.stdin.end('{"sessionId":"aaaaaaaa-0000-0000-0000-000000000000"}');
  await once(hook, 'exit');
  await setTimeout(50);
  assert.equal(hookEvents, before + 1);
});

test('the dashboard request shape is still admitted', async () => {
  const state = await fetch(`${BASE_URL}/state`, { signal: AbortSignal.timeout(2000) });
  assert.ok(state.ok);
  const command = await fetch(`${BASE_URL}/skip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(2000),
  });
  assert.ok(command.ok);
  const stream = await fetch(`${BASE_URL}/events`, { signal: AbortSignal.timeout(2000) });
  assert.ok(stream.ok);
  await stream.body?.cancel();
});