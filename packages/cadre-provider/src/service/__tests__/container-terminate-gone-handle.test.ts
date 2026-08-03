/**
 * `terminateContainer` against a record whose `dockerId` no longer exists.
 *
 * Every path that writes `status: 'error'` reclaims the container first but
 * leaves the `dockerId` on the record, so a tenant issuing `DELETE
 * /containers/:id` afterwards sends the provider at a handle Docker answers 404
 * for. Without forgiving that, the record can never reach `stopped`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import type { ContainerRunState, RecoverableOrchestrator } from '../orchestrator.js';
import type { Container } from '../../types.js';

function reclaimedRecord(): Container {
  const at = new Date('2026-06-01T12:00:00.000Z');
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status: 'error',
    error: 'container process exited during enrollment (restarts=2, exitCode=1)',
    resources: {},
    tags: {},
    createdAt: at,
    updatedAt: at,
    // Left behind by the reclaim — the container itself is already removed.
    dockerId: 'docker-removed',
  };
}

/** dockerode's shape for "no such container". */
function notFound(): Error {
  return Object.assign(new Error('no such container: docker-removed'), { statusCode: 404 });
}

function stubOrchestrator(opts: {
  stopContainer?: () => Promise<void>;
  runState?: (() => Promise<ContainerRunState | undefined>) | null;
}): { orchestrator: RecoverableOrchestrator; removeContainer: ReturnType<typeof vi.fn> } {
  const removeContainer = vi.fn(async () => {});
  const orchestrator = {
    createContainer: vi.fn(),
    stopContainer: vi.fn(opts.stopContainer ?? (async () => {})),
    removeContainer,
    getStats: vi.fn(),
    isRunning: vi.fn(async () => false),
    getLogs: vi.fn(async () => ''),
    ...(opts.runState === null ? {} : { inspectRunState: vi.fn(opts.runState ?? (async () => undefined)) }),
  } as unknown as RecoverableOrchestrator;
  return { orchestrator, removeContainer };
}

async function serviceOver(orchestrator: RecoverableOrchestrator): Promise<{
  service: ContainerService;
  store: MemoryStore;
}> {
  const store = new MemoryStore();
  await store.saveContainer(reclaimedRecord());
  return { service: new ContainerService({ store, orchestrator }), store };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ContainerService.terminateContainer with an already-gone handle', () => {
  it('reaches stopped when the container the record names is already removed', async () => {
    const { orchestrator } = stubOrchestrator({
      stopContainer: async () => { throw notFound(); },
      runState: async () => undefined, // the orchestrator confirms it is gone
    });
    const { service, store } = await serviceOver(orchestrator);

    expect(await service.terminateContainer('ctr_1')).toBe(true);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('stopped');
  });

  // "Cannot say" is not "it is gone" — a daemon outage must keep the failure path.
  it('keeps the failure path when the orchestrator cannot confirm the handle is gone', async () => {
    const { orchestrator } = stubOrchestrator({
      stopContainer: async () => { throw new Error('docker daemon unreachable'); },
      runState: async () => { throw new Error('docker daemon unreachable'); },
    });
    const { service, store } = await serviceOver(orchestrator);

    expect(await service.terminateContainer('ctr_1')).toBe(false);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe('docker daemon unreachable');
  });

  it('keeps the failure path when the container is still there and refuses to stop', async () => {
    const { orchestrator } = stubOrchestrator({
      stopContainer: async () => { throw new Error('container is restarting'); },
      runState: async () => ({ running: true, restartCount: 0 }),
    });
    const { service, store } = await serviceOver(orchestrator);

    expect(await service.terminateContainer('ctr_1')).toBe(false);
    expect((await store.getContainer('ctr_1'))?.status).toBe('error');
  });

  it('keeps the failure path against an orchestrator with no inspectRunState', async () => {
    const { orchestrator } = stubOrchestrator({
      stopContainer: async () => { throw notFound(); },
      runState: null,
    });
    const { service, store } = await serviceOver(orchestrator);

    expect(await service.terminateContainer('ctr_1')).toBe(false);
    expect((await store.getContainer('ctr_1'))?.status).toBe('error');
  });

  // The removal half can fail the same way once the stop has succeeded.
  it('reaches stopped when the removal — not the stop — finds nothing there', async () => {
    const { orchestrator, removeContainer } = stubOrchestrator({ runState: async () => undefined });
    removeContainer.mockImplementation(async () => { throw notFound(); });
    const { service, store } = await serviceOver(orchestrator);

    expect(await service.terminateContainer('ctr_1')).toBe(true);
    expect((await store.getContainer('ctr_1'))?.status).toBe('stopped');
  });
});
