import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DAEMON_HOST, DAEMON_PORT, GATE_MODES } from './constants.ts';
import type { GateMode } from './constants.ts';
import type { DaemonState } from './types.ts';

export type ApiHandlers = {
  onHookEvent(options: { name: string; body: string }): void;
  onSetMode(mode: GateMode): void;
  onSetFade(seconds: number): void;
  onSimulate(options: { running: boolean }): void;
  onToggleMute(handle: string): void;
  state(): DaemonState;
};

export type Api = {
  /** Pushes the current state to every connected dashboard. */
  broadcast(): void;
  stop(): Promise<void>;
};

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

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
    const url = new URL(req.url ?? '/', `http://${DAEMON_HOST}`);

    if (req.method === 'POST' && url.pathname === '/event') {
      void readBody(req).then((body) => {
        handlers.onHookEvent({ name: url.searchParams.get('name') ?? '', body });
        res.writeHead(HTTP_NO_CONTENT).end();
      });
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
      void readBody(req).then((body) => {
        // The dashboard is a separate process and its payload is as untrusted as a hook's.
        let handle = '';
        try {
          const payload: unknown = JSON.parse(body);
          if (typeof payload === 'object' && payload !== null) {
            const candidate = (payload as Record<string, unknown>)['handle'];
            if (typeof candidate === 'string') handle = candidate;
          }
        } catch {
          handle = '';
        }
        if (handle) handlers.onToggleMute(handle);
        res.writeHead(HTTP_OK, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handlers.state()));
      });
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

  return new Promise((resolve) => {
    server.listen(DAEMON_PORT, DAEMON_HOST, () => {
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
