/**
 * The reap sweep's interval is owned by the server lifecycle. A leaked interval
 * keeps the process — and this test runner — alive after shutdown, so both
 * `stop()` and the graceful-shutdown sequence must clear it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';

async function makeServer(): Promise<{ server: ProviderServer; exitFn: ReturnType<typeof vi.fn> }> {
  const config: ProviderConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0 },
    auth: { mode: 'none', allowInsecureNoAuth: true },
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string },
    billing: { enabled: false },
    storage: { type: 'memory' },
  };

  const exitFn = vi.fn();
  const server = await createProviderServer({
    config,
    orchestrator: new MockOrchestrator(),
    store: new MemoryStore(),
    exitFn,
  });
  return { server, exitFn };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('provider server reaper wiring', () => {
  it('starts the reap sweep on start() and clears it on stop()', async () => {
    const { server } = await makeServer();
    const startReaper = vi.spyOn(server.containerService, 'startReaper');
    const stopReaper = vi.spyOn(server.containerService, 'stopReaper');
    const clearInterval = vi.spyOn(globalThis, 'clearInterval');
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    await server.start();
    expect(startReaper).toHaveBeenCalledTimes(1);
    const results = setInterval.mock.results;
    const sweepTimer = results[results.length - 1]?.value as unknown;
    expect(sweepTimer).toBeDefined();

    await server.stop();
    expect(stopReaper).toHaveBeenCalledTimes(1);
    // The interval the reaper set is the one that was cleared — proof no handle
    // is left holding the event loop open.
    expect(clearInterval.mock.calls.map(call => call[0] as unknown)).toContain(sweepTimer);
  });

  it('clears the reap sweep in the graceful-shutdown sequence too', async () => {
    const { server, exitFn } = await makeServer();
    const stopReaper = vi.spyOn(server.containerService, 'stopReaper');

    await server.start();
    server.requestShutdown('test');

    await vi.waitFor(() => expect(exitFn).toHaveBeenCalledWith(0));
    expect(stopReaper).toHaveBeenCalled();
  });
});
