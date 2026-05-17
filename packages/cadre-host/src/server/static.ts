/**
 * Static-asset mount for the SPA bundle.
 *
 * The SPA bundle is produced by `6.5.2-cadre-host-local-ui-spa` into
 * `<package>/dist/ui/`. When that directory exists we serve files from it
 * with an `index.html` SPA fallback. When it's missing (running from source
 * before the SPA ticket lands) we serve a placeholder page that explains
 * how to install/build the SPA.
 *
 * Hand-rolled rather than pulling in `@fastify/static` — the surface area we
 * need is tiny and the dep would only matter under tests that don't exercise
 * static serving anyway.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import debug from 'debug';

const log = debug('cadre:host:static');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Default location of the SPA bundle when `cadre-host` runs from its
 * installed package.
 * - dist/server/static.js → ../ui  → packages/cadre-host/dist/ui
 */
export function defaultStaticRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'ui');
}

export interface StaticMountOptions {
  /** Absolute path to the SPA build output (defaults to `defaultStaticRoot()`). */
  rootDir?: string;
}

export function registerStaticMount(app: FastifyInstance, opts: StaticMountOptions = {}): void {
  const rootDir = opts.rootDir ?? defaultStaticRoot();

  // Register *after* all routes so API paths win.
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({
        ok: false,
        error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
      });
    }
    // Don't try to serve API paths as static.
    if (
      request.url.startsWith('/api') ||
      request.url.startsWith('/auth') ||
      request.url.startsWith('/nat') ||
      request.url.startsWith('/update')
    ) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
      });
    }
    return serveStatic(rootDir, request, reply);
  });
}

function serveStatic(rootDir: string, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (!existsSync(rootDir)) {
    if (request.url === '/' || request.url === '/index.html') {
      return reply.code(200).type('text/html; charset=utf-8').send(placeholderHtml());
    }
    return reply.code(404).send({
      ok: false,
      error: { code: 'not_found', message: 'SPA bundle not installed' },
    });
  }

  const requested = stripQuery(request.url);
  const target = resolveSafe(rootDir, requested);
  if (!target) {
    return reply.code(404).send({
      ok: false,
      error: { code: 'not_found', message: `No static asset for ${request.url}` },
    });
  }
  try {
    const stat = statSync(target);
    if (stat.isFile()) return sendFile(reply, target);
  } catch {
    // fall through to SPA index
  }
  // SPA fallback: serve index.html for any GET that accepts HTML.
  const accept = (request.headers.accept ?? '').toLowerCase();
  if (accept.includes('text/html') || accept === '' || accept === '*/*') {
    const index = join(rootDir, 'index.html');
    if (existsSync(index)) return sendFile(reply, index);
  }
  return reply.code(404).send({
    ok: false,
    error: { code: 'not_found', message: `No static asset for ${request.url}` },
  });
}

function resolveSafe(rootDir: string, urlPath: string): string | null {
  const cleaned = decodeSafe(urlPath);
  if (cleaned === null) return null;
  const target = normalize(join(rootDir, cleaned === '/' ? '' : cleaned));
  // Disallow path traversal above rootDir.
  if (!target.startsWith(normalize(rootDir))) return null;
  return target;
}

function decodeSafe(urlPath: string): string | null {
  try {
    const decoded = decodeURIComponent(urlPath);
    if (decoded.includes('\0')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function sendFile(reply: FastifyReply, path: string): FastifyReply {
  const buf = readFileSync(path);
  const mime = MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  return reply.code(200).type(mime).send(buf);
}

function placeholderHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>cadre-host</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
      h1 { font-weight: 600; }
      code { background: #f4f4f4; padding: 0.125rem 0.375rem; border-radius: 0.25rem; }
      .endpoint { font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <h1>cadre-host is running</h1>
    <p>
      The local UI bundle is not installed in this build. The HTTP management
      API is fully available — you can browse:
    </p>
    <ul>
      <li><span class="endpoint">GET /api/status</span></li>
      <li><span class="endpoint">GET /api/nodes</span></li>
      <li><span class="endpoint">GET /api/settings</span></li>
      <li><span class="endpoint">GET /api/events</span> (Server-Sent Events)</li>
      <li><span class="endpoint">/auth/*</span>, <span class="endpoint">/nat/*</span>, <span class="endpoint">/update/*</span></li>
    </ul>
    <p>
      To install the SPA, run <code>yarn workspace @serfab/cadre-host build:ui</code>
      (provided by the cadre-host-local-ui-spa ticket).
    </p>
    <p>See <a href="https://github.com/gotchoices/sereus/blob/master/docs/cadre-host.md">docs/cadre-host.md</a>.</p>
  </body>
</html>
`;
}
