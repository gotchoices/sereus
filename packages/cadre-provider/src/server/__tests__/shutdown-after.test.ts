import { describe, it, expect, vi } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';

/** Build a server preconfigured for in-process testing */
async function makeServer(overrides?: {
  exitFn?: (code: number) => void;
  hangCloseMs?: number;
}): Promise<{ server: ProviderServer; exitFn: ReturnType<typeof vi.fn> }> {
  const config: ProviderConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0 },
    auth: { mode: 'none' },
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string },
    billing: { enabled: false },
    storage: { type: 'memory' },
  };

  const exitFn = vi.fn();
  const server = await createProviderServer({
    config,
    orchestrator: new MockOrchestrator(),
    store: new MemoryStore(),
    exitFn: overrides?.exitFn ?? exitFn,
  });

  if (overrides?.hangCloseMs !== undefined) {
    // Replace app.close with a deferred resolver to test the drain-timeout cap.
    const ms = overrides.hangCloseMs;
    server.app.close = (() => new Promise<void>(resolve => setTimeout(resolve, ms))) as typeof server.app.close;
  }

  await server.app.ready();
  return { server, exitFn: exitFn };
}

describe('shutdownAfter flag', () => {
  it('POST /containers triggers shutdown on success', async () => {
    const { server, exitFn } = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: {
        partyId: 'party-1',
        bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'],
        shutdownAfter: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { ok: true; shutdownInitiated?: boolean };
    expect(body.ok).toBe(true);
    expect(body.shutdownInitiated).toBe(true);

    // Let the setImmediate + drain run
    await new Promise(r => setTimeout(r, 50));
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('POST /containers omits shutdownInitiated when flag is false/absent', async () => {
    const { server, exitFn } = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: {
        partyId: 'party-1',
        bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect('shutdownInitiated' in body).toBe(false);

    await new Promise(r => setTimeout(r, 20));
    expect(exitFn).not.toHaveBeenCalled();
    await server.stop();
  });

  it('POST /containers with shutdownAfter:true does NOT shutdown on validation failure', async () => {
    const { server, exitFn } = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { shutdownAfter: true }, // missing partyId
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error?: unknown };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();

    await new Promise(r => setTimeout(r, 20));
    expect(exitFn).not.toHaveBeenCalled();
    await server.stop();
  });

  it('DELETE /containers/:id with body {shutdownAfter:true} triggers shutdown on success', async () => {
    const { server, exitFn } = await makeServer();
    // Provision first
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { partyId: 'party-1', bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'] },
    });
    const created = (create.json() as { data: { container: { id: string } } }).data.container;

    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/containers/${created.id}`,
      payload: { shutdownAfter: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; shutdownInitiated?: boolean };
    expect(body.ok).toBe(true);
    expect(body.shutdownInitiated).toBe(true);

    await new Promise(r => setTimeout(r, 50));
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('DELETE /containers/:id?shutdownAfter=true (query form) triggers shutdown', async () => {
    const { server, exitFn } = await makeServer();
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { partyId: 'party-1', bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'] },
    });
    const created = (create.json() as { data: { container: { id: string } } }).data.container;

    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/containers/${created.id}?shutdownAfter=true`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; shutdownInitiated?: boolean };
    expect(body.shutdownInitiated).toBe(true);

    await new Promise(r => setTimeout(r, 50));
    expect(exitFn).toHaveBeenCalledTimes(1);
  });

  it('DELETE: body wins over query — body:false, query:true → no shutdown', async () => {
    const { server, exitFn } = await makeServer();
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { partyId: 'party-1', bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'] },
    });
    const created = (create.json() as { data: { container: { id: string } } }).data.container;

    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/containers/${created.id}?shutdownAfter=true`,
      payload: { shutdownAfter: false },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect('shutdownInitiated' in body).toBe(false);

    await new Promise(r => setTimeout(r, 20));
    expect(exitFn).not.toHaveBeenCalled();
    await server.stop();
  });

  it('DELETE: body wins over query — body:true, query:false → shutdown', async () => {
    const { server, exitFn } = await makeServer();
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: { partyId: 'party-1', bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'] },
    });
    const created = (create.json() as { data: { container: { id: string } } }).data.container;

    const res = await server.app.inject({
      method: 'DELETE',
      url: `/api/v1/containers/${created.id}?shutdownAfter=false`,
      payload: { shutdownAfter: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { shutdownInitiated?: boolean };
    expect(body.shutdownInitiated).toBe(true);

    await new Promise(r => setTimeout(r, 50));
    expect(exitFn).toHaveBeenCalledTimes(1);
  });

  it('DELETE on nonexistent container does NOT trigger shutdown', async () => {
    const { server, exitFn } = await makeServer();
    const res = await server.app.inject({
      method: 'DELETE',
      url: '/api/v1/containers/ctr_nope?shutdownAfter=true',
    });
    expect(res.statusCode).toBe(404);
    await new Promise(r => setTimeout(r, 20));
    expect(exitFn).not.toHaveBeenCalled();
    await server.stop();
  });

  it('requestShutdown is idempotent — second call is a no-op', async () => {
    const { server, exitFn } = await makeServer();
    server.requestShutdown('first');
    server.requestShutdown('second');
    server.requestShutdown('third');
    await new Promise(r => setTimeout(r, 50));
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('caps app.close() at the 5s drain timeout', async () => {
    // Make close hang past the cap. The shutdown sequence must still exit
    // within ~5.5s.
    const { server, exitFn } = await makeServer({ hangCloseMs: 20000 });
    const start = Date.now();
    server.requestShutdown('cap-test');
    // Poll until exitFn is called or we hit the timeout
    while (exitFn.mock.calls.length === 0 && Date.now() - start < 8000) {
      await new Promise(r => setTimeout(r, 100));
    }
    const elapsed = Date.now() - start;
    expect(exitFn).toHaveBeenCalledWith(0);
    expect(elapsed).toBeLessThan(7000);
    expect(elapsed).toBeGreaterThanOrEqual(4500);
  }, 15000);
});
