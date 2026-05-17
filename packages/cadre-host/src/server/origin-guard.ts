/**
 * Origin guard — defeats DNS-rebind attacks against the loopback listener.
 *
 * The listener is bound to 127.0.0.1 only, but a malicious page on
 * `evil.example.com` can still resolve its own hostname to 127.0.0.1 and
 * speak HTTP to us. We mitigate by requiring that:
 *   - `Host` is `127.0.0.1[:port]` or `localhost[:port]` (case-insensitive),
 *   - `Origin` (when present) matches one of those origins.
 *
 * Forbidden requests return 403 with the standard error envelope.
 *
 * The expected port can be supplied as a constant or as a getter — the
 * server's port-fallback loop discovers the bound port only after `listen`,
 * but Fastify hooks must be registered before `ready`, so the guard reads
 * the port at request time via the getter.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface OriginGuardOptions {
  /** Bound port (constant) or a getter for the current bound port. */
  port: number | (() => number);
  /** Allow these additional hosts (test harnesses, integrations). */
  extraAllowedHosts?: ReadonlyArray<string>;
}

const ALLOWED_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]', '::1'] as const;

export function registerOriginGuard(app: FastifyInstance, opts: OriginGuardOptions): void {
  const getPort = typeof opts.port === 'function' ? opts.port : () => opts.port as number;
  const extras = (opts.extraAllowedHosts ?? []).map((e) => e.toLowerCase());

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const port = getPort();
    const allowedHosts = buildAllowedHostHeaders(port, extras);
    const allowedOrigins = buildAllowedOrigins(port, extras);

    const hostHeader = (request.headers.host ?? '').toLowerCase();
    if (!hostHeader || !allowedHosts.has(hostHeader)) {
      return reply.code(403).send({
        ok: false,
        error: {
          code: 'forbidden_origin',
          message: `Host header "${request.headers.host ?? ''}" is not allowed`,
        },
      });
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      if (!allowedOrigins.has(origin.toLowerCase())) {
        return reply.code(403).send({
          ok: false,
          error: {
            code: 'forbidden_origin',
            message: `Origin "${origin}" is not allowed`,
          },
        });
      }
    }
    return undefined;
  });
}

function buildAllowedHostHeaders(port: number, extras: ReadonlyArray<string>): Set<string> {
  const set = new Set<string>();
  for (const host of ALLOWED_HOSTNAMES) {
    set.add(host);
    set.add(`${host}:${port}`);
  }
  for (const e of extras) set.add(e);
  return set;
}

function buildAllowedOrigins(port: number, extras: ReadonlyArray<string>): Set<string> {
  const set = new Set<string>();
  for (const host of ALLOWED_HOSTNAMES) {
    set.add(`http://${host}`);
    set.add(`http://${host}:${port}`);
    set.add(`https://${host}`);
    set.add(`https://${host}:${port}`);
  }
  for (const e of extras) set.add(e);
  return set;
}
