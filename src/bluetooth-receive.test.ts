/** These cases drive a fake bridge — a real PowerShell process speaking the real protocol — so no radio is touched; the one shipped-bridge case only lists devices. */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createBluetoothReceive, bluetoothClaimPath } from './bluetooth-receive.ts';

const SCRATCH_DIR = path.join(import.meta.dirname, '..', '.llmfm-test-bluetooth');
const FAKE_BRIDGE = path.join(SCRATCH_DIR, 'fake-bridge.ps1');
const FAILING_BRIDGE = path.join(SCRATCH_DIR, 'failing-bridge.ps1');
/** Matches the shipped bridge: no spaces in an id, spaces in a name. */
const DEVICE_ID = '\\\\?\\BTHENUM#{0000110a-0000-1000-8000-00805f9b34fb}_VID&0001004c#{6994ad04}\\SNK';
const DEVICE_NAME = 'The Static';

const FAKE_BRIDGE_SOURCE = [
  'param([int] $ParentPid = 0)',
  `$id = '${DEVICE_ID}'`,
  `$name = '${DEVICE_NAME}'`,
  '$connected = $false',
  "function Write-Line([string] $line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }",
  "function Format-State() {",
  "    if (-not $connected) { return 'S None - -' }",
  "    return ('S Opened ' + $id + ' ' + $name)",
  '}',
  'Write-Line \'OK 1\'',
  'while ($true) {',
  '    $line = [Console]::In.ReadLine()',
  '    if ($null -eq $line) { break }',
  '    if ($line.Length -eq 0) { continue }',
  '    $command = $line[0]',
  "    if ($command -eq 'Q') { break }",
  "    if ($command -eq 'L') {",
  "        Write-Line ('D 0 ' + $id + ' ' + $name)",
  "        Write-Line 'N 1'",
  "    } elseif ($command -eq 'C') {",
  '        $reference = $line.Substring(2).Trim()',
  "        if ($reference -eq 'die') { exit 1 }",
  "        if ($reference -eq '0' -or $reference -eq $id) {",
  '            $connected = $true',
  '            Write-Line (Format-State)',
  '        } else {',
  "            Write-Line 'ERR no such device'",
  '        }',
  "    } elseif ($command -eq 'X') {",
  '        $connected = $false',
  '        Write-Line (Format-State)',
  "    } elseif ($command -eq 'G') {",
  '        Write-Line (Format-State)',
  '    } else {',
  "        Write-Line 'ERR unknown command'",
  '    }',
  '}',
].join('\n');

const FAILING_BRIDGE_SOURCE = [
  'param([int] $ParentPid = 0)',
  "[Console]::Out.WriteLine('ERR no bluetooth radio')",
  'exit 1',
].join('\n');

before(() => {
  // Keeps the claim file out of the real install.
  mkdirSync(SCRATCH_DIR, { recursive: true });
  writeFileSync(FAKE_BRIDGE, FAKE_BRIDGE_SOURCE);
  writeFileSync(FAILING_BRIDGE, FAILING_BRIDGE_SOURCE);
  process.env['LLMFM_HOME'] = SCRATCH_DIR;
  process.env['LLMFM_BT_BRIDGE'] = FAKE_BRIDGE;
});

after(() => {
  delete process.env['LLMFM_BT_BRIDGE'];
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

test('lists paired devices, keeping a name that contains spaces', async () => {
  const bluetooth = createBluetoothReceive();
  const status = await bluetooth.start();
  assert.equal(status.ready, true, status.error ?? '');
  try {
    assert.deepEqual(await bluetooth.list(), [{ id: DEVICE_ID, name: DEVICE_NAME }]);
  } finally {
    await bluetooth.stop();
  }
});

test('connects, claims the chosen device, and gives it back on disconnect', async () => {
  const bluetooth = createBluetoothReceive();
  assert.equal((await bluetooth.start()).ready, true);
  try {
    const connected = await bluetooth.connect({ id: DEVICE_ID });
    assert.equal(connected.state, 'Opened');
    assert.deepEqual(connected.device, { id: DEVICE_ID, name: DEVICE_NAME });
    assert.equal(connected.error, null);
    assert.deepEqual(bluetooth.status(), connected);
    assert.equal(existsSync(bluetoothClaimPath()), true);

    const released = await bluetooth.disconnect();
    assert.equal(released.state, 'None');
    assert.equal(released.device, null);
    assert.equal(existsSync(bluetoothClaimPath()), false, 'the choice goes with the device');
  } finally {
    await bluetooth.stop();
  }
});

test('re-opens the claimed device on the next start without being asked', async () => {
  const first = createBluetoothReceive();
  await first.start();
  await first.connect({ id: DEVICE_ID });
  await first.stop();
  assert.equal(existsSync(bluetoothClaimPath()), true, 'a stop keeps the choice');

  const restarted = createBluetoothReceive();
  const status = await restarted.start();
  try {
    assert.equal(status.state, 'Opened');
    assert.deepEqual(status.device, { id: DEVICE_ID, name: DEVICE_NAME });
  } finally {
    await restarted.stop();
    rmSync(bluetoothClaimPath(), { force: true });
  }
});

test('drops a claim for a device that is no longer there', async () => {
  writeFileSync(
    bluetoothClaimPath(),
    JSON.stringify({ device: { id: 'gone', name: 'Old Phone' }, at: Date.now() }),
  );
  const bluetooth = createBluetoothReceive();
  const status = await bluetooth.start();
  try {
    assert.equal(status.ready, true);
    assert.equal(status.device, null);
    assert.equal(status.error, 'no such device');
    assert.equal(existsSync(bluetoothClaimPath()), false);
  } finally {
    await bluetooth.stop();
  }
});

test('reports a device it cannot reach instead of rejecting', async () => {
  const bluetooth = createBluetoothReceive();
  await bluetooth.start();
  try {
    const refused = await bluetooth.connect({ id: 'not-a-device' });
    assert.equal(refused.device, null);
    assert.equal(refused.error, 'no such device');
    assert.equal(existsSync(bluetoothClaimPath()), false);
  } finally {
    await bluetooth.stop();
  }
});

test('reports a bridge that cannot start instead of rejecting', async () => {
  process.env['LLMFM_BT_BRIDGE'] = FAILING_BRIDGE;
  const bluetooth = createBluetoothReceive();
  try {
    const status = await bluetooth.start();
    assert.equal(status.ready, false);
    assert.equal(status.error, 'no bluetooth radio');
    assert.equal(status.state, 'None');
    // Commands against a bridge that never came up answer rather than hang.
    assert.deepEqual(await bluetooth.list(), []);
  } finally {
    await bluetooth.stop();
    process.env['LLMFM_BT_BRIDGE'] = FAKE_BRIDGE;
  }
});

/** The bridge process is the sink, and the daemon latches "the sink is held" from the start result, so this module reporting its own death is all a health check has. */
test('a bridge that dies reports itself as not ready rather than still holding the sink', async () => {
  rmSync(bluetoothClaimPath(), { force: true });
  const bluetooth = createBluetoothReceive();
  assert.equal((await bluetooth.start()).ready, true);
  try {
    assert.equal((await bluetooth.connect({ id: DEVICE_ID })).state, 'Opened');
    assert.equal(bluetooth.status().ready, true);

    const lost = await bluetooth.connect({ id: 'die' });
    assert.equal(lost.ready, false, 'a dead bridge still claimed to be holding the sink');
    assert.equal(bluetooth.status().ready, false);
    assert.equal(bluetooth.status().device, null);
  } finally {
    await bluetooth.stop();
    rmSync(bluetoothClaimPath(), { force: true });
  }
});

/** Enumerates only: connecting would leave the machine speaking to someone's phone after the suite ends. */
test('the shipped bridge enumerates without a phone present', async () => {
  delete process.env['LLMFM_BT_BRIDGE'];
  const bluetooth = createBluetoothReceive();
  try {
    const status = await bluetooth.start();
    if (!status.ready) {
      console.log(`no Bluetooth here: ${status.error}`);
      return;
    }
    const devices = await bluetooth.list();
    for (const device of devices) {
      assert.equal(device.id.includes(' '), false, 'a device id is one token');
      assert.ok(device.name.length > 0);
    }
    console.log(`paired A2DP sources: ${devices.map((device) => device.name).join(', ') || 'none'}`);
    assert.equal(bluetooth.status().device, null, 'enumerating connects nothing');
  } finally {
    await bluetooth.stop();
    process.env['LLMFM_BT_BRIDGE'] = FAKE_BRIDGE;
  }
});
