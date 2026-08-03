/**
 * `ContainerService.reapStuckContainers` — the sweep that finishes off records a
 * dead provider abandoned mid-flight.
 *
 * Every case injects a fixed clock (`now`) so the TTLs are exercised by handing
 * the service a date rather than by moving wall-clock time or faking timers; the
 * one test that does use fake timers is the interval lifecycle, which is about
 * timers and nothing else.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ContainerService,
  CONTAINER_ENROLLMENT_TTL_MS,
  CONTAINER_PROVISIONING_TTL_MS,
} from '../container-service.js';
import { MemoryStore } from '../store.js';
import type { ContainerRunState, RecoverableOrchestrator } from '../orchestrator.js';
import type { Container, ContainerStatus } from '../../types.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const now = (): Date => NOW;

/** A record last touched `msAgo` milliseconds before the fixed clock. */
function record(status: ContainerStatus, msAgo: number, extra: Partial<Container> = {}): Container {
  const updatedAt = new Date(NOW.getTime() - msAgo);
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status,
    resources: {},
    tags: {},
    createdAt: updatedAt,
    updatedAt,
    healthEndpoint: 'http://localhost:18080/health',
    ...extra,
  };
}

interface Stub {
  orchestrator: RecoverableOrchestrator;
  stopContainer: ReturnType<typeof vi.fn>;
  removeContainer: ReturnType<typeof vi.fn>;
  resolveDockerId: ReturnType<typeof vi.fn>;
  inspectRunState: ReturnType<typeof vi.fn>;
}

/**
 * Stub orchestrator. Pass `resolveDockerId: null` for one that does not offer the
 * capability at all — the fallback shape the sweep must keep working against.
 */
function stubOrchestrator(opts: {
  resolveDockerId?: ((containerId: string) => Promise<string | undefined>) | null;
  runState?: () => Promise<ContainerRunState | undefined>;
  removeContainer?: () => Promise<void>;
} = {}): Stub {
  const stopContainer = vi.fn(async () => {});
  const removeContainer = vi.fn(opts.removeContainer ?? (async () => {}));
  const resolveDockerId = vi.fn(opts.resolveDockerId ?? (async () => undefined));
  const inspectRunState = vi.fn(opts.runState ?? (async () => undefined));
  const orchestrator = {
    createContainer: vi.fn(),
    stopContainer,
    removeContainer,
    getStats: vi.fn(),
    isRunning: vi.fn(async () => false),
    getLogs: vi.fn(async () => ''),
    inspectRunState,
    ...(opts.resolveDockerId === null ? {} : { resolveDockerId }),
  } as unknown as RecoverableOrchestrator;
  return { orchestrator, stopContainer, removeContainer, resolveDockerId, inspectRunState };
}

/** Make `/status` answer with a fixed payload (or a non-OK response when omitted). */
function stubStatus(payload?: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async () =>
    (payload
      ? { ok: true, json: async () => payload }
      : { ok: false, json: async () => ({}) }) as unknown as Response,
  ) as typeof globalThis.fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

const PAST_TTL = CONTAINER_PROVISIONING_TTL_MS + 60_000;
const PAST_ENROLLMENT_TTL = CONTAINER_ENROLLMENT_TTL_MS + 60_000;

/** Service + store over one seeded record. */
async function serviceWith(container: Container, stub: Stub): Promise<{
  service: ContainerService;
  store: MemoryStore;
}> {
  const store = new MemoryStore();
  await store.saveContainer(container);
  return { service: new ContainerService({ store, orchestrator: stub.orchestrator, now }), store };
}

describe('ContainerService.reapStuckContainers — abandoned provisions', () => {
  it('terminalizes a stuck pending record and reclaims nothing when no handle resolves', async () => {
    const stub = stubOrchestrator();
    const { service, store } = await serviceWith(record('pending', PAST_TTL), stub);

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe(
      'stuck in pending past TTL — provider likely restarted mid-provision'
    );
    expect(stub.stopContainer).not.toHaveBeenCalled();
    expect(stub.removeContainer).not.toHaveBeenCalled();
  });

  // The whole point of the label lookup: the provider died before it could write
  // a dockerId, but Docker still has the container it started.
  it('reclaims a stuck creating record via the handle the orchestrator resolves', async () => {
    const stub = stubOrchestrator({ resolveDockerId: async () => 'docker-resolved' });
    const { service, store } = await serviceWith(record('creating', PAST_TTL), stub);

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe(
      'stuck in creating past TTL — provider likely restarted mid-provision'
    );
    expect(stub.resolveDockerId).toHaveBeenCalledWith('ctr_1');
    expect(stub.stopContainer).toHaveBeenCalledWith('docker-resolved');
    expect(stub.removeContainer).toHaveBeenCalledWith('docker-resolved');
  });

  it('uses the dockerId already on the record and never asks the orchestrator', async () => {
    const stub = stubOrchestrator({ resolveDockerId: async () => 'docker-resolved' });
    const { service } = await serviceWith(
      record('creating', PAST_TTL, { dockerId: 'docker-on-record' }), stub
    );

    await service.reapStuckContainers();

    expect(stub.resolveDockerId).not.toHaveBeenCalled();
    expect(stub.stopContainer).toHaveBeenCalledWith('docker-on-record');
    expect(stub.removeContainer).toHaveBeenCalledWith('docker-on-record');
  });

  // The TTL is the only thing standing between a slow image pull and a false
  // reap of a provision that is genuinely still in flight.
  it('leaves a creating record that is younger than the TTL alone', async () => {
    const stub = stubOrchestrator({ resolveDockerId: async () => 'docker-resolved' });
    const { service, store } = await serviceWith(
      record('creating', CONTAINER_PROVISIONING_TTL_MS - 60_000), stub
    );

    expect(await service.reapStuckContainers()).toEqual([]);

    expect((await store.getContainer('ctr_1'))?.status).toBe('creating');
    expect(stub.removeContainer).not.toHaveBeenCalled();
  });

  // The candidate list is a snapshot and every reclaim awaits, so an in-flight
  // provision in this process can advance a record before the sweep acts on it.
  it('skips a record an in-flight provision advanced between snapshot and action', async () => {
    const stub = stubOrchestrator({ resolveDockerId: async () => 'docker-resolved' });
    const store = new MemoryStore();
    await store.saveContainer(record('creating', PAST_TTL));
    const service = new ContainerService({ store, orchestrator: stub.orchestrator, now });

    // The re-read hands back the record as the provision has just left it.
    const advanced = record('enrolling', 0, { dockerId: 'docker-live' });
    vi.spyOn(store, 'getContainer').mockResolvedValue(advanced);

    expect(await service.reapStuckContainers()).toEqual([]);
    expect(stub.stopContainer).not.toHaveBeenCalled();
    expect(stub.removeContainer).not.toHaveBeenCalled();
    expect(advanced.status).toBe('enrolling');
  });

  it('finishes a stuck stopping record off to stopped, reclaiming as it goes', async () => {
    const stub = stubOrchestrator();
    const { service, store } = await serviceWith(
      record('stopping', PAST_TTL, { dockerId: 'docker-stopping' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('stopped');
    expect(stored?.error).toBeUndefined();
    expect(stub.stopContainer).toHaveBeenCalledWith('docker-stopping');
    expect(stub.removeContainer).toHaveBeenCalledWith('docker-stopping');
  });

  // A reclaim that fails must not roll back the terminal write or abort the sweep
  // — the record is what the tenant's quota is counted from.
  it('still terminalizes and reports the record when the reclaim throws', async () => {
    const stub = stubOrchestrator({
      removeContainer: async () => { throw new Error('docker daemon unreachable'); },
    });
    const { service, store } = await serviceWith(
      record('creating', PAST_TTL, { dockerId: 'docker-gone' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);
    expect((await store.getContainer('ctr_1'))?.status).toBe('error');
  });

  it('terminalizes with nothing to reclaim against an orchestrator with no resolveDockerId', async () => {
    const stub = stubOrchestrator({ resolveDockerId: null });
    const { service, store } = await serviceWith(record('creating', PAST_TTL), stub);

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);
    expect((await store.getContainer('ctr_1'))?.status).toBe('error');
    expect(stub.removeContainer).not.toHaveBeenCalled();
  });

  // Status, never "Docker has a container": an already-terminal record whose
  // handle still resolves is not the sweep's business.
  it('never touches a terminal record even when a handle still resolves for it', async () => {
    const stub = stubOrchestrator({ resolveDockerId: async () => 'docker-lingering' });
    const { service, store } = await serviceWith(
      record('error', PAST_TTL, { dockerId: 'docker-lingering' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual([]);
    expect((await store.getContainer('ctr_1'))?.status).toBe('error');
    expect(stub.removeContainer).not.toHaveBeenCalled();
  });
});

describe('ContainerService.reapStuckContainers — abandoned enrollments', () => {
  // The never-metered hole: a container that came up healthy while the provider
  // was down has no waiter left to promote it, and billing reads only `running`.
  it('enrols a container that came up healthy while nothing was watching', async () => {
    stubStatus({ status: 'healthy', peerId: '12D3Koo' });
    const stub = stubOrchestrator();
    const { service, store } = await serviceWith(
      record('enrolling', PAST_ENROLLMENT_TTL, { dockerId: 'docker-live' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('running');
    expect(stored?.peerId).toBe('12D3Koo');
    expect(stub.removeContainer).not.toHaveBeenCalled();
  });

  it('terminalizes and reclaims an enrolling record whose child is gone', async () => {
    stubStatus();
    const stub = stubOrchestrator({
      runState: async () => ({
        running: false,
        restartCount: 0,
        exitedAt: new Date('2026-06-01T11:00:00.000Z'),
        exitCode: 1,
      }),
    });
    const { service, store } = await serviceWith(
      record('enrolling', PAST_ENROLLMENT_TTL, { dockerId: 'docker-dead' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe(
      'container process exited during enrollment (restarts=0, exitCode=1)'
    );
    expect(stub.stopContainer).toHaveBeenCalledWith('docker-dead');
    expect(stub.removeContainer).toHaveBeenCalledWith('docker-dead');
  });

  // An alive container is genuinely consuming its resources and `enrolling` is
  // still seedable — a merely-slow node must not be terminalized.
  it('leaves an alive-but-unhealthy enrolling container exactly as it is', async () => {
    stubStatus({ status: 'starting' });
    const stub = stubOrchestrator({ runState: async () => ({ running: true, restartCount: 0 }) });
    const { service, store } = await serviceWith(
      record('enrolling', PAST_ENROLLMENT_TTL, { dockerId: 'docker-slow' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual([]);

    const stored = await store.getContainer('ctr_1');
    expect(stored?.status).toBe('enrolling');
    expect(stored?.error).toBeUndefined();
    expect(stub.removeContainer).not.toHaveBeenCalled();
  });

  // Below the TTL the in-process `waitForEnrollment` still owns the record, and
  // two writers on one record is exactly what the TTL exists to prevent.
  it('leaves an enrolling record younger than its TTL to the in-process waiter', async () => {
    stubStatus({ status: 'healthy', peerId: '12D3Koo' });
    const stub = stubOrchestrator();
    const { service, store } = await serviceWith(
      record('enrolling', CONTAINER_ENROLLMENT_TTL_MS - 60_000, { dockerId: 'docker-live' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual([]);
    expect((await store.getContainer('ctr_1'))?.status).toBe('enrolling');
  });

  // A crash-looping child is condemned on a single reading here: the record has
  // already sat on `enrolling` for minutes, so there is no "booting again" left
  // to protect.
  it('condemns a crash-looping child on one reading', async () => {
    stubStatus();
    const stub = stubOrchestrator({
      runState: async () => ({ running: true, restartCount: 4, exitedAt: new Date(), exitCode: 1 }),
    });
    const { service, store } = await serviceWith(
      record('enrolling', PAST_ENROLLMENT_TTL, { dockerId: 'docker-loop' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual(['ctr_1']);
    expect((await store.getContainer('ctr_1'))?.error).toBe(
      'container process exited during enrollment (restarts=4, exitCode=1)'
    );
  });

  // A failed probe is not evidence of anything; the container keeps its record.
  it('leaves the record alone when the liveness probe itself fails', async () => {
    stubStatus();
    const stub = stubOrchestrator({
      runState: async () => { throw new Error('docker daemon unreachable'); },
    });
    const { service, store } = await serviceWith(
      record('enrolling', PAST_ENROLLMENT_TTL, { dockerId: 'docker-unknown' }), stub
    );

    expect(await service.reapStuckContainers()).toEqual([]);
    expect((await store.getContainer('ctr_1'))?.status).toBe('enrolling');
  });
});

describe('ContainerService reaper lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sweeps immediately, then on the interval, and stops when told to', async () => {
    vi.useFakeTimers();
    const stub = stubOrchestrator();
    const service = new ContainerService({
      store: new MemoryStore(), orchestrator: stub.orchestrator, now,
    });
    const sweep = vi.spyOn(service, 'reapStuckContainers');

    service.startReaper(1_000);
    await vi.advanceTimersByTimeAsync(0);
    // Records recovered from disk must be handled at startup, not an interval later.
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweep).toHaveBeenCalledTimes(3);

    service.stopReaper();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  // A sweep over many containers can outlast its own interval; two concurrent
  // sweeps would race on the same records.
  it('does not start a second sweep while one is still in flight', async () => {
    vi.useFakeTimers();
    const stub = stubOrchestrator();
    const service = new ContainerService({
      store: new MemoryStore(), orchestrator: stub.orchestrator, now,
    });

    let release: (() => void) | undefined;
    const sweep = vi.spyOn(service, 'reapStuckContainers').mockImplementation(
      () => new Promise<string[]>(resolve => { release = () => resolve([]); })
    );

    service.startReaper(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    service.stopReaper();
  });
});
