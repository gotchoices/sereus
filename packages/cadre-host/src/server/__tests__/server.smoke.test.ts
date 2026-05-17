import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createLocalUiServer } from '../index.js';
import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { TrustCircleService } from '../../auth/index.js';
import type { NatService } from '../../nat/index.js';
import type { NatStatusSnapshot } from '../../nat/types.js';

function fakeOrchestrator(): HostProcessOrchestrator {
  return {
    listNodes: () => [],
    getNode: () => undefined,
    resolveDockerId: () => undefined,
    onStateChange: () => () => undefined,
  } as unknown as HostProcessOrchestrator;
}

function fakeTrustCircle(): TrustCircleService {
  const pending = new Map<string, { token: string; label: string; createdAt: string }>();
  return {
    list: async () => ({
      members: [],
      pending: [...pending.values()],
    }),
    issueInvite: async (opts: { label: string }) => {
      const token = `tok-${pending.size + 1}`;
      pending.set(token, { token, label: opts.label, createdAt: new Date().toISOString() });
      return {
        encodedInvite: `invite:${token}`,
        invite: {} as never,
        token,
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
    redeemInvite: async () => ({ peerId: 'p', label: 'l' }),
    revokePending: async () => undefined,
    removeMember: async () => undefined,
  } as unknown as TrustCircleService;
}

const SAMPLE_CONNECTIVITY: NatStatusSnapshot = {
  portMode: 'disabled',
  externalPort: 4001,
  internalPort: 4001,
  routerExternalIp: null,
  mappingLeaseExpiresAt: null,
  externalIp: null,
  externalIpDetectedAt: null,
  cgnatDetected: false,
  directReachability: 'unknown',
  lastTestedAt: null,
  ddns: {
    providerId: null,
    hostname: null,
    externallyManaged: false,
    lastUpdateAt: null,
    lastUpdateOk: null,
    lastError: null,
  },
};

function fakeNat(): NatService {
  return {
    getStatus: () => SAMPLE_CONNECTIVITY,
    putSettings: async () => SAMPLE_CONNECTIVITY,
    testReachability: async () => SAMPLE_CONNECTIVITY,
    listDdnsProviders: () => [],
    putDdns: async () => SAMPLE_CONNECTIVITY,
  } as unknown as NatService;
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
      trustCircle: fakeTrustCircle(),
      nat: fakeNat(),
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
    const body = await res.json() as { service: { name: string } };
    expect(body.service.name).toBe('cadre-host');
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

  it('round-trips an invite through /auth/* and reflects it in /auth/trust-circle', async () => {
    const post = await fetch(`${baseUrl}/auth/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Mom\'s phone' }),
    });
    expect(post.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/auth/trust-circle`);
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { pending: Array<{ label: string }> };
    expect(body.pending.length).toBe(1);
    expect(body.pending[0]?.label).toBe('Mom\'s phone');
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
