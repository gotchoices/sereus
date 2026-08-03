/**
 * Enrollment must notice the container's process died rather than waiting out
 * the fixed window and leaving the record stranded on 'enrolling'.
 *
 * Every case injects a tiny `enrollmentTimeoutMs`/`enrollmentPollMs` so no test
 * burns wall clock; the death case deliberately keeps a LARGE timeout, so a
 * regression that stops detecting the exit fails by hitting vitest's own test
 * timeout instead of quietly passing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import type {
  ContainerRunState,
  OrchestratorCreateResult,
  RecoverableOrchestrator,
} from '../orchestrator.js';
import type { Container, CreateContainerRequest } from '../../types.js';

/** Private surface of ContainerService we drive directly in tests. */
type ProvisionInternal = {
  provisionContainer(container: Container, request: CreateContainerRequest): Promise<void>;
};

function pendingContainer(): Container {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status: 'pending',
    resources: {},
    tags: {},
    createdAt: now,
    updatedAt: now,
  };
}

const provisionRequest: CreateContainerRequest = {
  customerId: 'cust-1',
  partyId: 'party-1',
  bootstrapNodes: [],
  profile: 'transaction',
};

const createResult: OrchestratorCreateResult = {
  dockerId: 'docker-xyz',
  healthEndpoint: 'http://localhost:18080/health',
  metricsEndpoint: 'http://localhost:19090/metrics',
  seedEndpoint: 'http://localhost:18080/seed',
  seedToken: 'seed-token-xyz',
  p2pPort: 14001,
};

type Stub = {
  orchestrator: RecoverableOrchestrator;
  removeContainer: ReturnType<typeof vi.fn>;
  getLogs: ReturnType<typeof vi.fn>;
  inspectRunState: ReturnType<typeof vi.fn>;
};

/**
 * Stub orchestrator whose `inspectRunState` is supplied per test. Pass `null`
 * for an orchestrator that does not offer the capability at all — the
 * pre-existing shape every caller must keep working against.
 */
function stubOrchestrator(
  runState: (() => Promise<ContainerRunState | undefined>) | null
): Stub {
  const removeContainer = vi.fn(async () => {});
  const getLogs = vi.fn(async () => 'tail of container output\n');
  const inspectRunState = vi.fn(runState ?? (async () => undefined));
  const orchestrator = {
    createContainer: vi.fn(async () => createResult),
    removeContainer,
    stopContainer: vi.fn(async () => {}),
    getStats: vi.fn(),
    isRunning: vi.fn(async () => false),
    getLogs,
    ...(runState ? { inspectRunState } : {}),
  } as unknown as RecoverableOrchestrator;
  return { orchestrator, removeContainer, getLogs, inspectRunState };
}

/**
 * Store standing in for a `DELETE /containers/:id` that lands the instant the
 * enrollment wait starts: the first read of an `enrolling` record hands back a
 * record already moved to `stopping`, exactly as `terminateContainer` leaves it.
 */
class TerminatingStore extends MemoryStore {
  override async getContainer(id: string): Promise<Container | undefined> {
    const record = await super.getContainer(id);
    if (record?.status === 'enrolling') record.status = 'stopping';
    return record;
  }
}

/** Make `/status` answer with a fixed payload (or a non-OK response when omitted). */
function stubStatus(payload?: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async () =>
    (payload
      ? { ok: true, json: async () => payload }
      : { ok: false, json: async () => ({}) }) as unknown as Response,
  ) as typeof globalThis.fetch;
}

async function provision(service: ContainerService, container: Container): Promise<void> {
  await (service as unknown as ProvisionInternal).provisionContainer(container, provisionRequest);
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('ContainerService enrollment liveness probe', () => {
  it('fails the provision and reclaims when the child exited during enrollment', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    stubStatus(); // never healthy

    const { orchestrator, removeContainer, getLogs } = stubOrchestrator(async () => ({
      running: false,
      restartCount: 2,
      exitedAt: new Date('2026-06-01T00:00:05.000Z'),
      exitCode: 1,
    }));
    // A large window: if the probe stops detecting death this hangs rather than
    // silently reverting to the old wait-it-out behaviour.
    const service = new ContainerService({
      store, orchestrator, enrollmentTimeoutMs: 60_000, enrollmentPollMs: 5,
    });

    await provision(service, container);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe(
      'container process exited during enrollment (restarts=2, exitCode=1)'
    );
    expect(removeContainer).toHaveBeenCalledWith('docker-xyz');
    // Operator's only view of WHY it died goes to the debug log, not the record.
    expect(getLogs).toHaveBeenCalledWith('docker-xyz', 50);
    expect(stored?.error).not.toContain('tail of container output');
  });

  it('enrols normally when the container restarted but is healthy on this poll', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    stubStatus({ status: 'healthy', peerId: '12D3Koo' });

    const { orchestrator, removeContainer, inspectRunState } = stubOrchestrator(async () => ({
      running: true,
      restartCount: 1,
      exitedAt: new Date('2026-06-01T00:00:03.000Z'),
      exitCode: 1,
    }));
    const service = new ContainerService({
      store, orchestrator, enrollmentTimeoutMs: 60_000, enrollmentPollMs: 5,
    });

    await provision(service, container);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('running');
    expect(stored?.peerId).toBe('12D3Koo');
    expect(removeContainer).not.toHaveBeenCalled();
    // Health is read first, so a healthy poll never reaches the probe at all.
    expect(inspectRunState).not.toHaveBeenCalled();
  });

  it('leaves a slow-but-alive container on enrolling and does not reclaim', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    stubStatus({ status: 'starting' });

    const { orchestrator, removeContainer, inspectRunState } = stubOrchestrator(async () => ({
      running: true,
      restartCount: 0,
    }));
    const service = new ContainerService({
      store, orchestrator, enrollmentTimeoutMs: 30, enrollmentPollMs: 5,
    });

    await provision(service, container);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('enrolling');
    expect(stored?.error).toBeUndefined();
    expect(inspectRunState).toHaveBeenCalled();
    expect(removeContainer).not.toHaveBeenCalled();
  });

  it('keeps waiting when the liveness probe itself throws', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    stubStatus();

    const { orchestrator, removeContainer } = stubOrchestrator(async () => {
      throw new Error('docker daemon unreachable');
    });
    const service = new ContainerService({
      store, orchestrator, enrollmentTimeoutMs: 30, enrollmentPollMs: 5,
    });

    await provision(service, container);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('enrolling');
    expect(stored?.error).toBeUndefined();
    expect(removeContainer).not.toHaveBeenCalled();
  });

  it('behaves exactly as before against an orchestrator with no inspectRunState', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    stubStatus();

    const { orchestrator, removeContainer } = stubOrchestrator(null);
    const service = new ContainerService({
      store, orchestrator, enrollmentTimeoutMs: 30, enrollmentPollMs: 5,
    });

    await provision(service, container);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('enrolling');
    expect(removeContainer).not.toHaveBeenCalled();
  });

  // `terminateContainer` stops the container and only then removes it. During
  // that gap the orchestrator honestly reports an exit — which is a deliberate
  // teardown, not a crash. The wait bails on any record it no longer owns.
  it('does not fail a provision that a concurrent terminate moved to stopping', async () => {
    const store = new TerminatingStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    stubStatus();

    const { orchestrator, removeContainer, inspectRunState } = stubOrchestrator(async () => ({
      running: false,
      restartCount: 0,
      exitedAt: new Date('2026-06-01T00:00:04.000Z'),
      exitCode: 0,
    }));
    const service = new ContainerService({
      store, orchestrator, enrollmentTimeoutMs: 60_000, enrollmentPollMs: 5,
    });

    await provision(service, container);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('stopping');
    expect(stored?.error).toBeUndefined();
    expect(inspectRunState).not.toHaveBeenCalled();
    expect(removeContainer).not.toHaveBeenCalled();
  });

  // A concurrent DELETE removes the container out from under the wait. "The
  // orchestrator no longer knows it" is not evidence the child crashed.
  it('does not record an error when the orchestrator no longer knows the container', async () => {
    const store = new MemoryStore();
    const container = pendingContainer();
    await store.saveContainer(container);
    stubStatus();

    const { orchestrator, removeContainer } = stubOrchestrator(async () => undefined);
    const service = new ContainerService({
      store, orchestrator, enrollmentTimeoutMs: 30, enrollmentPollMs: 5,
    });

    await provision(service, container);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('enrolling');
    expect(stored?.error).toBeUndefined();
    expect(removeContainer).not.toHaveBeenCalled();
  });
});
