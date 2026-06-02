import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, relative } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerStaticMount, resolveSafe } from '../static.js';

describe('resolveSafe', () => {
  // POSIX-style fixtures; node:path normalizes separators per-platform, so the
  // containment logic is exercised identically on Windows and POSIX.
  const root = '/srv/app/dist/ui';

  it('resolves a normal in-root asset', () => {
    expect(resolveSafe(root, '/assets/app.js')).toBe(normalize(join(root, 'assets/app.js')));
  });

  it('resolves a bare / to the root directory itself', () => {
    expect(resolveSafe(root, '/')).toBe(normalize(root));
  });

  it('resolves /index.html to the root index', () => {
    expect(resolveSafe(root, '/index.html')).toBe(normalize(join(root, 'index.html')));
  });

  it('rejects the sibling-directory prefix bypass', () => {
    // `ui-private` shares `ui`'s basename as a prefix — the bare startsWith
    // guard accepted this; the relative-based guard must reject it.
    expect(resolveSafe(root, '/../ui-private/secret')).toBeNull();
  });

  it('rejects ordinary out-of-tree traversal', () => {
    expect(resolveSafe(root, '/../../etc/passwd')).toBeNull();
  });

  it('rejects an encoded out-of-tree traversal', () => {
    expect(resolveSafe(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
  });

  it('rejects a NUL-byte path', () => {
    expect(resolveSafe(root, '/app%00.js')).toBeNull();
  });

  it('rejects malformed percent-encoding', () => {
    expect(resolveSafe(root, '/%')).toBeNull();
  });

  it('never returns a path that escapes the root', () => {
    const escapes = [
      '/../ui-private/secret',
      '/../../etc/passwd',
      '/../ui/../ui-private/x',
      '/..',
    ];
    for (const p of escapes) {
      const resolved = resolveSafe(root, p);
      if (resolved !== null) {
        const rel = relative(normalize(root), resolved);
        expect(rel.startsWith('..')).toBe(false);
      }
    }
  });
});

describe('serveStatic (via registerStaticMount)', () => {
  let app: ReturnType<typeof Fastify>;
  let tmpRoot: string;
  let rootDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-static-'));
    rootDir = join(tmpRoot, 'ui');
    mkdirSync(join(rootDir, 'assets'), { recursive: true });
    writeFileSync(join(rootDir, 'index.html'), '<!doctype html><title>spa</title>');
    writeFileSync(join(rootDir, 'assets', 'app.js'), 'console.log("hi");');

    // Sibling directory whose name is a prefix superset of the root basename.
    const sibling = join(tmpRoot, 'ui-private');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'secret.txt'), 'top secret');

    app = Fastify();
    registerStaticMount(app, { rootDir });
  });

  afterEach(async () => {
    await app.close();
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('serves an in-root asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.body).toBe('console.log("hi");');
  });

  it('serves index.html for the bare root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>spa</title>');
  });

  it('serves index.html as SPA fallback for unknown HTML routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/some/client/route',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>spa</title>');
  });

  // Boundary smoke-check (NOT the prefix-bypass regression test — that lives in
  // the `resolveSafe` block above). Fastify's router collapses `../` (literal
  // and `%2e%2e`-encoded) to within-root before the handler runs, so a
  // traversal URL never reaches `resolveSafe` in its escaping form over HTTP.
  // The invariant we assert at the HTTP boundary is simply: sibling content is
  // never served, regardless of vector.
  it('never serves sibling-prefix directory content over HTTP', async () => {
    for (const url of ['/../ui-private/secret.txt', '/%2e%2e/ui-private/secret.txt']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).not.toContain('top secret');
    }
  });
});
