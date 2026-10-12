import { describe, it, expect, vi } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';
import { encodedTestInvitation } from './test-invitation.js';

/**
 * A container's `join` holds a credential — the claim secret, handed out by
 * `GET /containers/:id/code` alone, or the invitation bundle with its private key —
 * so the create, read and list routes reduce it to its kind.
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
