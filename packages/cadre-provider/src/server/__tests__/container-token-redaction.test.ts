import { describe, it, expect, vi } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';
import type { Container } from '../../types.js';
import { encodedTestInvitation } from './test-invitation.js';

/**
 * The per-container `seedToken` is a credential that gates the node's
 * `POST /seed` route. The provider stores it and presents it on the customer's
 * behalf; it must never cross the API boundary. These tests pin that the
 * read-side routes redact it even after provisioning has populated the field.
 *
 * A container's `join` holds a credential too — the claim secret, handed out by
 * `GET /containers/:id/code` alone, or the invitation bundle with its private key —
 * so the same routes reduce it to its kind. The second suite pins that.
 *
 * `publicHost` is set so a claim container may be created at all.
 */
async function makeServer(): Promise<{ server: ProviderServer; store: MemoryStore }> {
  const config: ProviderConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0 },
    auth: { mode: 'none', allowInsecureNoAuth: true },
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string, publicHost: 'cadre.example' },
    billing: { enabled: false },
    storage: { type: 'memory' },
  };

  const store = new MemoryStore();
  const server = await createProviderServer({
    config,
    orchestrator: new MockOrchestrator(),
    store,
    exitFn: vi.fn(),
  });
  await server.app.ready();
  return { server, store };
}

/** Poll the store until the async provision has stamped a seedToken on the record. */
async function waitForSeedToken(store: MemoryStore, id: string): Promise<Container> {
  for (let i = 0; i < 50; i++) {
    const c = await store.getContainer(id);
    if (c?.seedToken) return c;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('container never received a seedToken');
}

describe('seed token is never serialized to the API', () => {
  it('GET /containers/:id omits seedToken even though the store holds one', async () => {
    const { server, store } = await makeServer();
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { partyId: 'party-1', bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp'] },
    });
    const id = (create.json() as { data: { container: { id: string } } }).data.container.id;

    const stored = await waitForSeedToken(store, id);
    expect(stored.seedToken).toBeTruthy(); // sanity: the secret really is at rest

    const res = await server.app.inject({ method: 'GET', url: `/api/v1/containers/${id}` });
    expect(res.statusCode).toBe(200);
    const container = (res.json() as { data: { container: Record<string, unknown> } }).data.container;
    expect(container.id).toBe(id);
    expect('seedToken' in container).toBe(false);
    expect(res.body).not.toContain(stored.seedToken!);

    await server.stop();
  });

  it('GET /containers omits seedToken for every listed container', async () => {
    const { server, store } = await makeServer();
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { partyId: 'party-1', bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp'] },
    });
    const id = (create.json() as { data: { container: { id: string } } }).data.container.id;
    const stored = await waitForSeedToken(store, id);

    const res = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect(res.statusCode).toBe(200);
    const containers = (res.json() as { data: { containers: Record<string, unknown>[] } }).data.containers;
    expect(containers.length).toBeGreaterThan(0);
    for (const c of containers) expect('seedToken' in c).toBe(false);
    expect(res.body).not.toContain(stored.seedToken!);

    await server.stop();
  });

  it('POST /containers response carries no seedToken', async () => {
    const { server } = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { partyId: 'party-1', bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp'] },
    });
    expect(res.statusCode).toBe(201);
    const container = (res.json() as { data: { container: Record<string, unknown> } }).data.container;
    expect('seedToken' in container).toBe(false);

    await server.stop();
  });
});

/** Every response that carries containers: the create, the read and the list. */
async function containerResponses(server: ProviderServer, payload: Record<string, unknown>): Promise<{ id: string; bodies: string[]; containers: Record<string, unknown>[] }> {
  const create = await server.app.inject({ method: 'POST', url: '/api/v1/containers', payload });
  expect(create.statusCode).toBe(201);
  const created = (create.json() as { data: { container: Record<string, unknown> } }).data.container;
  const id = created.id as string;
  const read = await server.app.inject({ method: 'GET', url: `/api/v1/containers/${id}` });
  const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
  return {
    id,
    bodies: [create.body, read.body, list.body],
    containers: [
      created,
      (read.json() as { data: { container: Record<string, unknown> } }).data.container,
      ...(list.json() as { data: { containers: Record<string, unknown>[] } }).data.containers,
    ],
  };
}

describe('join credentials are never serialized to the API', () => {
  it('a claim container shows join: { kind: "claim" } and its secret in no response', async () => {
    const { server, store } = await makeServer();
    const { id, bodies, containers } = await containerResponses(server, { join: { kind: 'claim' } });

    const stored = await store.getContainer(id);
    const secret = stored?.join?.kind === 'claim' ? stored.join.secret : undefined;
    expect(secret).toBeTruthy(); // sanity: the secret really is at rest
    for (const c of containers) expect(c.join).toEqual({ kind: 'claim' });
    for (const body of bodies) expect(body).not.toContain(secret!);

    await server.stop();
  });

  it('an invitation container shows join: { kind: "invitation" } and the bundle in no response', async () => {
    const { server } = await makeServer();
    const invitation = encodedTestInvitation();
    const { bodies, containers } = await containerResponses(server, { join: { kind: 'invitation', invitation } });

    for (const c of containers) expect(c.join).toEqual({ kind: 'invitation' });
    // Neither the whole bundle nor its body (the part after the prefix) appears anywhere.
    const bundleBody = invitation.slice('sereus-invite:1.'.length);
    for (const body of bodies) expect(body).not.toContain(bundleBody);

    await server.stop();
  });
});
