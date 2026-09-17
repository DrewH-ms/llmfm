import test from 'node:test';
import assert from 'node:assert/strict';
import type { DaemonState } from './types.ts';
import type { BluetoothDevice } from './bluetooth-receive.ts';

/** A port of its own, so a test never answers to — or fights with — a daemon the user has
 *  running. Set before the modules that read it are loaded, which is why they are imported
 *  dynamically here. */
const TEST_PORT = '7791';
process.env['LLMFM_PORT'] = TEST_PORT;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const HTTP_BAD_REQUEST = 400;

const { startApi } = await import('./api.ts');
const { SETTING_DEFAULTS, SETTING_SPECS } = await import('./settings.ts');

const PAIRED: BluetoothDevice[] = [{ id: 'bt-device-id', name: 'The Static' }];

let connected: string | null = null;

function daemonState(): DaemonState {
  return {
    mode: SETTING_DEFAULTS.mode,
    fadeSeconds: SETTING_DEFAULTS.fadeSeconds,
    simulating: false,
    track: null,
    transport: { playing: false, position: 0, duration: 0 },
    midi: { ready: false, device: null, error: null },
    duck: { ready: false, deviceId: null, error: null },
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

const api = await startApi({
  onHookEvent: () => {},
  onSetMode: () => {},
  onSetFade: () => {},
  onSimulate: () => {},
  onSetMute: () => {},
  onSetSetting: () => true,
  listBluetooth: () => Promise.resolve(PAIRED),
  onConnectBluetooth({ id }) {
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
});

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
