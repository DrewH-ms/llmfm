// Forwards a raw Copilot CLI hook payload to the Agent Orchestra daemon.
//
// Stays plain JavaScript and imports nothing from the project: type stripping and module
// resolution cost startup time the CLI's hook timeout does not have to spare.
//
// Always exits 0, never writes to stdout or stderr, and treats a daemon that is not
// listening as a normal outcome.

import http from 'node:http';
import fs from 'node:fs';

const DAEMON_URL = process.env.AGENT_ORCHESTRA_URL || 'http://127.0.0.1:7777';
const REQUEST_TIMEOUT_MS = 200;
const WATCHDOG_MARGIN_MS = 50;

// The CLI omits the event name from several payloads, so the hook config passes it here.
const eventName = process.argv[2] || '';

const exitQuietly = () => process.exit(0);

try {
  let body = '';
  try {
    body = fs.readFileSync(0, 'utf8');
  } catch {
    body = '';
  }

  const endpoint = new URL(`/event?name=${encodeURIComponent(eventName)}`, DAEMON_URL);
  const request = http.request(
    {
      host: endpoint.hostname,
      port: endpoint.port || 80,
      path: endpoint.pathname + endpoint.search,
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    exitQuietly,
  );
  request.on('error', exitQuietly);
  request.on('timeout', () => {
    request.destroy();
    exitQuietly();
  });
  request.end(body);
  setTimeout(exitQuietly, REQUEST_TIMEOUT_MS + WATCHDOG_MARGIN_MS).unref();
} catch {
  exitQuietly();
}
