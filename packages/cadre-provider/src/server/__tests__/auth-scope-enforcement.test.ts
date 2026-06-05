import { describe, it, expect, vi } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';
import { loadConfig } from '../../config/loader.js';
import type { AuthHooks } from '../auth.js';

/** Base config for in-process testing: random port, mock docker, memory store. */
function baseConfig(auth: ProviderConfig['auth']): ProviderConfig {
  return {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0 },
    auth,
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string },
    billing: { enabled: false },
    storage: { type: 'memory' },
  };
}

async function makeServer(auth: ProviderConfig['auth'], authHooks?: AuthHooks): Promise<ProviderServer> {
  const server = await createProviderServer({
    config: baseConfig(auth),
    orchestrator: new MockOrchestrator(),
    store: new MemoryStore(),
    authHooks,
    exitFn: vi.fn(),
  });
  await server.app.ready();
  return server;
}

/** Build a server whose api-key hook hands back an identity with the given scopes. */
function makeScopedServer(permissions: string[]): Promise<ProviderServer> {
  return makeServer(
    { mode: 'api-key' },
    { validateApiKey: async () => ({ customerId: 'cust-1', permissions }) }
  );
}

const AUTH = { authorization: 'Bearer test-key' };

const VALID_CREATE = {
  partyId: 'party-1',
  bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'],
};

describe('closed-by-default auth', () => {
  it('api-key mode with no keys rejects an unmatched credential with 401', async () => {
    const server = await makeServer({ mode: 'api-key' });
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      headers: { authorization: 'Bearer does-not-match-anything' },
      payload: VALID_CREATE,
    });
    expect(res.statusCode).toBe(401);
    await server.stop();
  });

  it('a server built straight from loadConfig() (no file, no env) is closed', async () => {
    // Faithful end-to-end of the ticket's "default is closed" criterion: the
    // bare config must default to api-key and reject an unmatched credential.
    const savedMode = process.env.PROVIDER_AUTH_MODE;
    const savedAck = process.env.PROVIDER_ALLOW_INSECURE_NO_AUTH;
    delete process.env.PROVIDER_AUTH_MODE;
    delete process.env.PROVIDER_ALLOW_INSECURE_NO_AUTH;
    try {
      const config = loadConfig();
      expect(config.auth.mode).toBe('api-key');
      const server = await createProviderServer({
        config: { ...config, server: { ...config.server, port: 0 } },
        orchestrator: new MockOrchestrator(),
        store: new MemoryStore(),
        exitFn: vi.fn(),
      });
      await server.app.ready();
      const res = await server.app.inject({
        method: 'POST',
        url: '/api/v1/containers',
        headers: { authorization: 'Bearer nope' },
        payload: VALID_CREATE,
      });
      expect(res.statusCode).toBe(401);
      await server.stop();
    } finally {
      if (savedMode === undefined) delete process.env.PROVIDER_AUTH_MODE;
      else process.env.PROVIDER_AUTH_MODE = savedMode;
      if (savedAck === undefined) delete process.env.PROVIDER_ALLOW_INSECURE_NO_AUTH;
      else process.env.PROVIDER_ALLOW_INSECURE_NO_AUTH = savedAck;
    }
  });

  it('api-key mode with no Authorization header returns 401', async () => {
    const server = await makeServer({ mode: 'api-key' });
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect(res.statusCode).toBe(401);
    await server.stop();
  });

  it("mode 'none' without opt-in refuses to construct the server", async () => {
    await expect(makeServer({ mode: 'none' })).rejects.toThrow(/allowInsecureNoAuth/);
  });

  it("mode 'none' with opt-in starts and grants the dev-customer wildcard", async () => {
    const server = await makeServer({ mode: 'none', allowInsecureNoAuth: true });
    // No Authorization header at all — 'none' mode injects the wildcard identity.
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { containers: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.containers)).toBe(true);
    await server.stop();
  });

  it('/status is reachable without auth even in api-key mode', async () => {
    const server = await makeServer({ mode: 'api-key' });
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(res.statusCode).toBe(200);
    await server.stop();
  });
});

describe('permission scope enforcement', () => {
  it("['containers:read'] permits GET /containers but blocks write/seed scopes", async () => {
    const server = await makeScopedServer(['containers:read']);

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers', headers: AUTH });
    expect(list.statusCode).toBe(200);

    const create = await server.app.inject({
      method: 'POST', url: '/api/v1/containers', headers: AUTH, payload: VALID_CREATE,
    });
    expect(create.statusCode).toBe(403);
    expect((create.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE');

    // Scope is enforced before the container lookup, so a bogus id still 403s.
    const del = await server.app.inject({ method: 'DELETE', url: '/api/v1/containers/ctr_x', headers: AUTH });
    expect(del.statusCode).toBe(403);
    expect((del.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE');

    const seed = await server.app.inject({
      method: 'PUT', url: '/api/v1/containers/ctr_x/seed', headers: AUTH, payload: { seed: 'abc' },
    });
    expect(seed.statusCode).toBe(403);
    expect((seed.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE');

    await server.stop();
  });

  it("['containers:create'] permits POST /containers but blocks GET /containers", async () => {
    const server = await makeScopedServer(['containers:create']);

    const create = await server.app.inject({
      method: 'POST', url: '/api/v1/containers', headers: AUTH, payload: VALID_CREATE,
    });
    expect(create.statusCode).toBe(201);

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers', headers: AUTH });
    expect(list.statusCode).toBe(403);
    expect((list.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE');

    await server.stop();
  });

  it("['*'] passes every scope gate", async () => {
    const server = await makeScopedServer(['*']);

    const create = await server.app.inject({
      method: 'POST', url: '/api/v1/containers', headers: AUTH, payload: VALID_CREATE,
    });
    expect(create.statusCode).toBe(201);

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers', headers: AUTH });
    expect(list.statusCode).toBe(200);

    const billing = await server.app.inject({ method: 'GET', url: '/api/v1/billing/status', headers: AUTH });
    expect(billing.statusCode).toBe(200);

    await server.stop();
  });

  it("['containers:*'] passes container scopes but not billing:read", async () => {
    const server = await makeScopedServer(['containers:*']);

    const create = await server.app.inject({
      method: 'POST', url: '/api/v1/containers', headers: AUTH, payload: VALID_CREATE,
    });
    expect(create.statusCode).toBe(201);

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers', headers: AUTH });
    expect(list.statusCode).toBe(200);

    const billing = await server.app.inject({ method: 'GET', url: '/api/v1/billing/status', headers: AUTH });
    expect(billing.statusCode).toBe(403);
    expect((billing.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE');

    await server.stop();
  });

  it('GET /billing/plans needs no scope (unauthenticated listing)', async () => {
    // Even an identity with an empty permission set can list plans.
    const server = await makeScopedServer([]);
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/billing/plans', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { plans: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.plans.length).toBeGreaterThan(0);
    await server.stop();
  });
});
