import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DAEMON_HOST, DAEMON_PORT, GATE_MODES } from './constants.ts';
import type { GateMode } from './constants.ts';
import type { DaemonState } from './types.ts';
import type { BluetoothDevice } from './bluetooth-receive.ts';

/** One shipped file as the UI sees it. Search and filtering happen client side, so this
 *  carries the provenance and the shape of the piece rather than a curated subset. */
export type TrackInfo = {
  file: string;
  /** `mid`, `mp3` or `wav`. Only `mid` can be split into parts and gated per session. */
  format: string;
  title: string | null;
  composer: string | null;
  /** What tracks.json records for this name. It describes the bytes that were curated,
   *  not necessarily the bytes now on disk — see `integrity`. */
  licenceId: string | null;
  /** Whether the file still hashes to what the licence record was written against.
   *  A record can outlive its file: overwrite a curated name with other bytes and the
   *  entry keeps asserting a licence for music it no longer describes. `unrecorded`
   *  means no digest was curated for it, which is the normal case for a user's own file. */
  integrity: 'verified' | 'mismatch' | 'unrecorded';
  /** Independent lines the classifier found, which is how many sessions can be told
   *  apart by ear. */
  voiceCount: number;
  /** Too few voices to carry an ensemble; still playable, but only as hold music. */
  holdMusicOnly: boolean;
  /** The playlist this track belongs to, for grouping the list a user reads. */
  playlist: string;
};

export type PlaylistInfo = {
  name: string;
  /** Whether it is a folder a user can add files to. */
  editable: boolean;
  count: number;
};

export type ApiHandlers = {
  onHookEvent(options: { name: string; body: string }): void;
  onSetMode(mode: GateMode): void;
  onSetFade(seconds: number): void;
  onSimulate(options: { running: boolean }): void;
  onSetMute(options: { sessionId: string; muted: boolean }): void;
  /** False when the key is unknown or the value fails its spec, which the route turns
   *  into a 400 rather than silently accepting a setting that was never applied. */
  onSetSetting(options: { key: string; value: unknown }): boolean;
  /** The phones paired with this machine. Enumeration waits on the radio and can take
   *  tens of seconds, so a caller must show that something is happening. */
  listBluetooth(): Promise<BluetoothDevice[]>;
  /** False when the device did not give us a connection, which the route turns into a
   *  400 rather than reporting a sink that is not open. */
  onConnectBluetooth(options: { id: string }): Promise<boolean>;
  tracks(): TrackInfo[];
  playlists(): PlaylistInfo[];
  /** False when the name is not a playlist that exists, which the route turns into a 400. */
  onSetPlaylist(name: string): boolean;
  /** False when the file is not one we ship, which the route turns into a 400. */
  onSetTrack(file: string): boolean | Promise<boolean>;
  /** False when there is nowhere to go — a library of one, or no track playing. */
  onSkipTrack(): boolean | Promise<boolean>;
  state(): DaemonState;
};

export type Api = {
  /** Pushes the current state to every connected dashboard. */
  broadcast(): void;
  stop(): Promise<void>;
};

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;

/** The names this daemon answers to. A request carrying anything else was resolved through
 *  a hostname that is not ours, which is how a remote page gets to read `/state`. */
const LOCAL_HOSTS = [`${DAEMON_HOST}:${DAEMON_PORT}`, `localhost:${DAEMON_PORT}`];

/** The API is unauthenticated on loopback, so provenance is the only thing separating the
 *  hook and the dashboard from a page the user happens to have open. Node clients send
 *  neither header; a browser cannot suppress them. */
function fromBrowser(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (req.headers['origin']) return true;
  if (typeof site === 'string' && site !== 'none' && site !== 'same-origin') return true;
  return !LOCAL_HOSTS.includes(req.headers['host'] ?? '');
}

/** A rejected route would otherwise be an unhandled rejection, and Node 24 ends the
 *  process for one — taking any unmute the daemon still owes the user with it. The
 *  response is ended here too, so a failed request does not hang to its socket timeout. */
function settle(res: ServerResponse, action: () => Promise<void>): void {
  Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      console.error(`API route failed: ${String(error)}`);
      if (!res.headersSent) {
        res.writeHead(HTTP_INTERNAL_ERROR, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
}

/** Every client is a separate process, so a request body is as untrusted as a hook's:
 *  anything that is not a JSON object contributes no fields at all. */
function fields(body: string): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload === 'object' && payload !== null) {
      return payload as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

const stringField = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  return typeof value === 'string' ? value : '';
};

export function startApi(handlers: ApiHandlers): Promise<Api> {
  const streams = new Set<ServerResponse>();

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', () => resolve(''));
    });

  const server: Server = createServer((req, res) => {
    if (fromBrowser(req)) {
      res.writeHead(HTTP_NOT_FOUND).end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${DAEMON_HOST}`);

    if (req.method === 'POST' && url.pathname === '/event') {
      settle(res, () =>
        readBody(req).then((body) => {
          handlers.onHookEvent({ name: url.searchParams.get('name') ?? '', body });
          res.writeHead(HTTP_NO_CONTENT).end();
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mode') {
      const requested = url.searchParams.get('mode');
      const mode = GATE_MODES.find((candidate) => candidate === requested);
      if (mode) handlers.onSetMode(mode);
      const fade = Number(url.searchParams.get('fade'));
      if (Number.isFinite(fade) && fade > 0) handlers.onSetFade(fade);
      res.writeHead(HTTP_NO_CONTENT).end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/simulate') {
      handlers.onSimulate({ running: url.searchParams.get('running') === 'true' });
      res.writeHead(HTTP_NO_CONTENT).end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mute') {
      settle(res, () =>
        readBody(req).then((body) => {
          const payload = fields(body);
          const sessionId = stringField(payload, 'sessionId');
          if (sessionId) handlers.onSetMute({ sessionId, muted: payload['muted'] === true });
          res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(handlers.state()));
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/config') {
      settle(res, () =>
        readBody(req).then((body) => {
          const payload = fields(body);
          const key = stringField(payload, 'key');
          // The setting specs own validation, so an unknown key and a value the spec
          // rejects are the same failure here and neither reaches the config file.
          if (!key || !handlers.onSetSetting({ key, value: payload['value'] })) {
            res.writeHead(HTTP_BAD_REQUEST).end();
            return;
          }
          res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(handlers.state()));
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/track') {
      settle(res, () =>
        readBody(req).then(async (body) => {
          // The daemon owns the list of files we ship, so an arbitrary path never becomes
          // a read: the name either matches one of them or the request is rejected.
          const file = stringField(fields(body), 'file');
          if (!file || !(await handlers.onSetTrack(file))) {
            res.writeHead(HTTP_BAD_REQUEST).end();
            return;
          }
          res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(handlers.state()));
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/skip') {
      settle(res, async () => {
        if (!(await handlers.onSkipTrack())) {
          res.writeHead(HTTP_BAD_REQUEST).end();
          return;
        }
        res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handlers.state()));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/playlist') {
      settle(res, () =>
        readBody(req).then((body) => {
          const name = stringField(fields(body), 'name');
          if (!name || !handlers.onSetPlaylist(name)) {
            res.writeHead(HTTP_BAD_REQUEST).end();
            return;
          }
          res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(handlers.state()));
        }),
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/bluetooth/connect') {
      settle(res, () =>
        readBody(req).then(async (body) => {
          const id = stringField(fields(body), 'id');
          if (!id || !(await handlers.onConnectBluetooth({ id }))) {
            res.writeHead(HTTP_BAD_REQUEST).end();
            return;
          }
          res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(handlers.state()));
        }),
      );
      return;
    }

    if (url.pathname === '/bluetooth/devices') {
      settle(res, () =>
        handlers.listBluetooth().then((devices) => {
          res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ devices }));
        }),
      );
      return;
    }

    if (url.pathname === '/playlists') {
      res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ playlists: handlers.playlists() }));
      return;
    }

    if (url.pathname === '/tracks') {
      res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tracks: handlers.tracks() }));
      return;
    }

    if (url.pathname === '/state') {
      res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handlers.state()));
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(HTTP_OK, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(handlers.state())}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    res.writeHead(HTTP_NOT_FOUND).end();
  });

  return new Promise((resolve, reject) => {
    const failToBind = (error: NodeJS.ErrnoException): void => {
      const reason =
        error.code === 'EADDRINUSE'
          ? `port ${DAEMON_PORT} is already in use — another llmfm daemon is probably running`
          : `could not listen on ${DAEMON_HOST}:${DAEMON_PORT}: ${error.message}`;
      reject(Object.assign(new Error(reason), { code: error.code }));
    };
    server.once('error', failToBind);

    server.listen(DAEMON_PORT, DAEMON_HOST, () => {
      // Past this point an `error` is a runtime fault, not a failed bind, and must not
      // reach the process as an uncaught EventEmitter error.
      server.off('error', failToBind);
      server.on('error', (error: Error) => console.error(`API server error: ${error.message}`));
      resolve({
        broadcast(): void {
          const payload = `data: ${JSON.stringify(handlers.state())}\n\n`;
          for (const stream of streams) stream.write(payload);
        },
        stop(): Promise<void> {
          for (const stream of streams) stream.end();
          streams.clear();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
