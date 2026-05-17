/**
 * Fastify lifecycle for the cadre-host local UI.
 *
 * Bound to `127.0.0.1:<uiPort>` only — never `0.0.0.0`. On `EADDRINUSE`
 * tries the configured port and then nine consecutive ports. On total
 * failure the start() promise rejects with a clear message naming every
 * port that was attempted.
 *
 * Shutdown drains with a 5 s timeout, mirroring cadre-provider's pattern.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import debug from 'debug';

const log = debug('cadre:host:server');

/** Hard cap on Fastify's drain phase during shutdown. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;
/** Inclusive count of ports to try (config port + 9 alternates). */
const PORT_FALLBACK_TRIES = 10;
/** Loopback interface; never serve from 0.0.0.0. */
const LOOPBACK_HOST = '127.0.0.1';

export interface StartServerOptions {
  /** Preferred port. The server tries this then the next 9 on EADDRINUSE. */
  preferredPort: number;
  /**
   * Test override: when 0, lets the OS pick any free port (skips the
   * fallback loop). The returned `port` reflects the actual bound port.
   */
  forcePort?: 0;
}

export interface StartedServer {
  port: number;
  url: string;
}

export interface ShutdownOptions {
  /** Override the 5 s drain timeout (tests). */
  drainTimeoutMs?: number;
}

/**
 * Bind `app` to the loopback interface with port-fallback. Returns the
 * actually-bound port — the configured port may be in use.
 */
export async function startListening(
  app: FastifyInstance,
  opts: StartServerOptions,
): Promise<StartedServer> {
  if (opts.forcePort === 0) {
    const address = await app.listen({ host: LOOPBACK_HOST, port: 0 });
    const port = parsePort(address);
    return { port, url: `http://${LOOPBACK_HOST}:${port}` };
  }

  const tried: number[] = [];
  let lastErr: Error | null = null;
  for (let i = 0; i < PORT_FALLBACK_TRIES; i++) {
    const port = opts.preferredPort + i;
    tried.push(port);
    try {
      const address = await app.listen({ host: LOOPBACK_HOST, port });
      const bound = parsePort(address);
      if (i > 0) {
        log('port %d in use; bound on fallback port %d', opts.preferredPort, bound);
      }
      return { port: bound, url: `http://${LOOPBACK_HOST}:${bound}` };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        throw err;
      }
      lastErr = err as Error;
      log('port %d in use, trying next', port);
    }
  }
  throw new Error(
    `cadre-host: all ${PORT_FALLBACK_TRIES} candidate ports were in use ` +
    `(${tried.join(', ')}). Reconfigure uiPort in host.config.json. ` +
    `Last error: ${lastErr?.message ?? 'unknown'}`,
  );
}

/**
 * Close the server with a hard 5 s drain timeout. Idempotent — safe to call
 * from a SIGINT/SIGTERM handler that may fire twice.
 */
export async function stopListening(
  app: FastifyInstance,
  opts: ShutdownOptions = {},
): Promise<void> {
  const drainMs = opts.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drain = app.close();
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), drainMs);
  });
  const outcome = await Promise.race([drain.then(() => 'drained' as const), timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    log('shutdown drain timeout after %dms', drainMs);
  }
}

/** Create a bare Fastify instance with the project's logging convention. */
export function buildFastify(): FastifyInstance {
  return Fastify({
    // Stay quiet by default — request-level logs are noisy on a local UI.
    // Operators can opt in via the `debug` env var (cadre:host:*).
    logger: false,
    disableRequestLogging: true,
  });
}

function parsePort(address: string): number {
  // address is e.g. http://127.0.0.1:8765
  const m = address.match(/:(\d+)\/?$/);
  if (!m) throw new Error(`cadre-host: unable to parse port from listen address: ${address}`);
  return Number(m[1]);
}
