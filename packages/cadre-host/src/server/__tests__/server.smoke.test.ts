import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createLocalUiServer } from '../index.js';
import { fakeFounder } from './fakes.js';
import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import { GrantService, GrantStore } from '../../donation/index.js';

function fakeOrchestrator(): HostProcessOrchestrator {
  return {
    listNodes: () => [],
    getNode: () => undefined,
    resolveDockerId: () => undefined,
    onStateChange: () => () => undefined,
  } as unknown as HostProcessOrchestrator;
}

function writeConfig(dir: string): void {
  const cfg = {
    version: 2,
    installId: 'inst-x',
    uiPort: 8765,
    libp2pPort: 4001,
    dataDir: dir,
    identityPath: join(dir, 'identity.key'),
    upnpEnabled: true,
    installedAt: '2025-01-01T00:00:00Z',
    installerVersion: '0.6.0',
    updates: { autoApply: false },
  };
  writeFileSync(join(dir, 'host.config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

describe('createLocalUiServer smoke', () => {
  let dataDir: string;
  let server: ReturnType<typeof createLocalUiServer>;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cadre-host-smoke-'));
    writeConfig(dataDir);
    server = createLocalUiServer({
      uiPort: 8765,
      dataDir,
      orchestrator: fakeOrchestrator(),
      founder: fakeFounder(),
      forcePort: 0,
    });
    const { url } = await server.start();
    baseUrl = url;
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves /api/status and respects the origin guard', async () => {
    // Without host header: undici's fetch sets it; this is the happy path.
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { service: { name: string }; role: string };
    expect(body.service.name).toBe('cadre-host');
    expect(body.role).toBe('founder');
  });

  it('rejects requests with a foreign Host header', async () => {
    // fetch() forbids overriding the Host header — use node:http directly.
    const { request: httpRequest } = await import('node:http');
    const u = new URL(`${baseUrl}/api/status`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'GET',
          headers: { host: 'evil.example.com' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('serves a placeholder index.html when dist/ui is missing', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const text = await res.text();
    expect(text).toContain('cadre-host is running');
  });

  it('an unknown /api path returns 404 (not the static SPA)', async () => {
    const res = await fetch(`${baseUrl}/api/this-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

// Donor-only mode: the common case (ownCadre.enabled=false). No owner node, so
// no NAT is wired. The donor surface (/grants-admin) is up, and the
// founder-only surface (/nat) 404s to keep the surface honest.
describe('createLocalUiServer smoke — donor-only (no owner node)', () => {
  let dataDir: string;
  let server: ReturnType<typeof createLocalUiServer>;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cadre-host-donor-'));
    writeConfig(dataDir);
    server = createLocalUiServer({
      uiPort: 8765,
      dataDir,
      orchestrator: fakeOrchestrator(),
      grants: new GrantService({ store: new GrantStore(dataDir) }),
      forcePort: 0,
    });
    const { url } = await server.start();
    baseUrl = url;
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves /api/status as role donor, with no connectivity and no nodes', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      service: { name: string };
      role: string;
      nodes: unknown[];
      connectivity?: unknown;
    };
    expect(body.service.name).toBe('cadre-host');
    expect(body.role).toBe('donor');
    expect(body.nodes).toEqual([]);
    expect(body.connectivity).toBeUndefined();
  });

  it('serves the donor surface: POST /grants-admin issues a grant', async () => {
    const res = await fetch(`${baseUrl}/grants-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: "Alice's cadre", maxNodes: 2 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { grant: { token: string; maxNodes: number } };
    expect(body.grant.token).toBeTruthy();
    expect(body.grant.maxNodes).toBe(2);
  });

  it('404s the founder-only NAT surface (GET /nat/status)', async () => {
    const res = await fetch(`${baseUrl}/nat/status`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
