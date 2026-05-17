/**
 * Server-Sent Events route — `GET /api/events`.
 *
 * Hand-rolled (~40 lines vs. the 30 KB @fastify/sse-v2 dep). The wire format:
 *
 *   retry: 5000\n\n          ← reconnect hint
 *   : heartbeat\n\n          ← comment line, every 15 s
 *   event: <type>\n          ← event name
 *   data: <json>\n\n         ← payload
 *
 * The handler subscribes to the bus on connect, unsubscribes on client
 * disconnect, and ticks a heartbeat so corporate proxies don't close the
 * connection at the idle timeout.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import debug from 'debug';

import type { EventBus } from './bus.js';
import type { LocalUiEvent } from './types.js';

const log = debug('cadre:host:sse');

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_HINT_MS = 5_000;

export interface SseRouteOptions {
  events: EventBus;
  /** Test override: shorter heartbeat. */
  heartbeatIntervalMs?: number;
}

export function registerSseRoute(app: FastifyInstance, opts: SseRouteOptions): void {
  const heartbeatMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  app.get('/api/events', (request: FastifyRequest, reply: FastifyReply) => {
    // Tell Fastify we're handling the reply ourselves — it won't try to
    // serialise or send a payload.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`retry: ${RECONNECT_HINT_MS}\n\n`);
    reply.raw.write(`: connected\n\n`);

    const onEvent = (event: LocalUiEvent): void => {
      try {
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        log('write failed (client likely gone): %s', (err as Error).message);
      }
    };
    const unsubscribe = opts.events.subscribe(onEvent);

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch (err) {
        log('heartbeat write failed: %s', (err as Error).message);
      }
    }, heartbeatMs);
    // Don't hold the event loop open for the heartbeat alone.
    if (typeof heartbeat === 'object' && 'unref' in heartbeat) {
      (heartbeat as { unref?: () => void }).unref?.();
    }

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // The reply object is intentionally not returned — Fastify must not
    // attempt to serialise an SSE response.
  });
}
