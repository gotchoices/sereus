/**
 * `POST /containers` acceptance + validation of `pinnedOwnerKeys` — the tenant
 * owner key(s) the created node is started with as cold-start seed-trust
 * anchors. Create time is the last point where a caller can supply them, so a
 * malformed field is refused here rather than surfacing later as a seed the node
 * silently refuses.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';

async function makeServer(): Promise<ProviderServer> {
  const config: ProviderConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0 },
    auth: { mode: 'none', allowInsecureNoAuth: true },
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string },
    billing: { enabled: false },
    storage: { type: 'memory' },
  };
  const server = await createProviderServer({
    config,
    orchestrator: new MockOrchestrator(),
    store: new MemoryStore(),
    exitFn: () => {},
  });
  await server.app.ready();
  return server;
}

function createPayload(pinnedOwnerKeys?: unknown): Record<string, unknown> {
  return {
    partyId: 'party-1',
    bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'],
    ...(pinnedOwnerKeys === undefined ? {} : { pinnedOwnerKeys }),
  };
}

describe('POST /containers pinnedOwnerKeys', () => {
  it('accepts a list of keys and records them on the container', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload(['owner-key-1', 'owner-key-2']),
    });

    expect(res.statusCode).toBe(201);
    const container = (res.json() as { data: { container: { pinnedOwnerKeys?: string[] } } }).data.container;
    expect(container.pinnedOwnerKeys).toEqual(['owner-key-1', 'owner-key-2']);
    await server.stop();
  });

  it('accepts a request with no pinnedOwnerKeys (container simply trusts no seed signer)', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload(),
    });

    expect(res.statusCode).toBe(201);
    const container = (res.json() as { data: { container: { pinnedOwnerKeys?: string[] } } }).data.container;
    expect(container.pinnedOwnerKeys).toBeUndefined();
    await server.stop();
  });

  it('rejects a non-array pinnedOwnerKeys with INVALID_REQUEST', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload('owner-key-1'),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
    await server.stop();
  });

  it('rejects an array with a non-string element with INVALID_REQUEST', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload(['owner-key-1', 42]),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
    await server.stop();
  });

  it('does not provision a container when the field is invalid', async () => {
    const server = await makeServer();
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload({ not: 'an array' }),
    });

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect((list.json() as { data: { containers: unknown[] } }).data.containers).toHaveLength(0);
    await server.stop();
  });
});
