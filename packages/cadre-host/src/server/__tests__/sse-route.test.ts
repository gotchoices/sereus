import { createServer, type AddressInfo } from 'node:net';

import Fastify from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { EventBus } from '../events/bus.js';
import { registerSseRoute } from '../events/sse-route.js';

async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = server.address() as AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

/** Parse SSE chunks and append decoded events to `events`. */
function parseSseChunk(buf: string, state: { current: { type: string; data: string } }, events: Array<{ type: string; data: string }>): string {
  let buffered = buf;
  let nl: number;
  while ((nl = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, nl).replace(/\r$/, '');
    buffered = buffered.slice(nl + 1);
    if (line === '') {
      if (state.current.type || state.current.data) {
        events.push({ ...state.current });
        state.current.type = '';
        state.current.data = '';
      }
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) { state.current.type = line.slice(6).trim(); continue; }
    if (line.startsWith('data:')) { state.current.data = line.slice(5).trim(); continue; }
  }
  return buffered;
}

describe('GET /api/events (SSE)', () => {
  let app: ReturnType<typeof Fastify>;
  let bus: EventBus;
  let port: number;

  beforeEach(async () => {
    port = await pickFreePort();
    bus = new EventBus();
    app = Fastify();
    registerSseRoute(app, { events: bus, heartbeatIntervalMs: 50 });
    await app.listen({ host: '127.0.0.1', port });
  });

  afterEach(async () => {
    await app.close();
  });

  it('delivers published events in order and cleans up on disconnect', async () => {
    const { request: httpRequest } = await import('node:http');
    const events: Array<{ type: string; data: string }> = [];
    const state = { current: { type: '', data: '' } };
    let leftover = '';
    let done = false;

    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/events',
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });

    const responseReady = new Promise<void>((resolve) => {
      req.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          leftover = parseSseChunk(leftover + chunk, state, events);
        });
        res.on('end', () => { done = true; });
        resolve();
      });
    });
    req.end();
    await responseReady;

    // Give the connection a beat to settle on the server, then publish.
    await new Promise<void>((r) => setTimeout(r, 30));
    bus.publish({ type: 'trust-circle-changed', kind: 'invited' });
    bus.publish({ type: 'trust-circle-changed', kind: 'redeemed' });
    bus.publish({ type: 'connectivity-changed', portMode: 'auto-upnp', directReachability: 'reachable' });

    // Wait until at least 3 events have arrived (or 1s).
    const deadline = Date.now() + 1000;
    while (events.length < 3 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }

    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.slice(0, 3).map((e) => e.type)).toEqual([
      'trust-circle-changed',
      'trust-circle-changed',
      'connectivity-changed',
    ]);
    const first = JSON.parse(events[0]!.data) as { kind: string };
    expect(first.kind).toBe('invited');

    expect(bus.listenerCount()).toBe(1);
    req.destroy();
    // Give the server's 'close' handler a tick to run.
    const dropDeadline = Date.now() + 1000;
    while (bus.listenerCount() > 0 && Date.now() < dropDeadline) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    expect(bus.listenerCount()).toBe(0);
    void done;
  });
});
