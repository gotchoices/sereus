/**
 * `GET /containers/:id/code` turns each `NodeCodeRefusal` into the status and code the
 * client reads (`routes.ts` → `NODE_CODE_REFUSALS`): 409 for a container that cannot be
 * claimed as it is, 503 while the node is not ready and the client should poll.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';

const PEER = '12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp';

async function makeServer(): Promise<ProviderServer> {
  const config: ProviderConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0 },
    auth: { mode: 'none', allowInsecureNoAuth: true },
    // A public host, so a claim container may be created at all.
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string, publicHost: 'cadre.example' },
    billing: { enabled: false },
    storage: { type: 'memory' },
  };
  const server = await createProviderServer({
    config,
    orchestrator: new MockOrchestrator(),
    store: new MemoryStore(),
    exitFn: vi.fn(),
  });
  await server.app.ready();
  return server;
}

async function createContainer(server: ProviderServer, payload: Record<string, unknown>): Promise<string> {
  const res = await server.app.inject({ method: 'POST', url: '/api/v1/containers', payload });
  expect(res.statusCode).toBe(201);
  return (res.json() as { data: { container: { id: string } } }).data.container.id;
}

describe('GET /containers/:id/code', () => {
  it.each([
    ['a seed-path container', { partyId: 'party-1', bootstrapNodes: [`/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`] }, 409, 'NOT_CLAIMABLE'],
    // The mock orchestrator runs no node, so a claim container never answers /status.
    ['a claim container whose node is not up', { join: { kind: 'claim' } }, 503, 'NOT_AVAILABLE'],
  ])('answers %s with %i %s', async (_what, payload, status, code) => {
    const server = await makeServer();
    const id = await createContainer(server, payload);

    const res = await server.app.inject({ method: 'GET', url: `/api/v1/containers/${id}/code` });
    expect(res.statusCode).toBe(status);
    expect((res.json() as { error: { code: string } }).error.code).toBe(code);

    await server.stop();
  });

  it('answers 404 for an unknown container', async () => {
    const server = await makeServer();
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/containers/ctr_missing/code' });
    expect(res.statusCode).toBe(404);
    await server.stop();
  });
});
