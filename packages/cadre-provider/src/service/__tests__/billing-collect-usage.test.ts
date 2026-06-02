import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BillingService } from '../billing-service.js';
import { MemoryStore } from '../store.js';
import { MockOrchestrator } from '../orchestrator.js';
import type { Container, UsageMetrics } from '../../types.js';

/** Private surface of BillingService we drive directly in tests. */
type CollectUsageInternal = { collectUsage(): Promise<void> };

function runningContainer(overrides: Partial<Container> = {}): Container {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return {
    id: 'ctr_1',
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status: 'running',
    dockerId: 'docker-1',
    healthEndpoint: 'http://localhost:8080/health',
    resources: {},
    tags: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A fetch Response stand-in carrying a JSON body. */
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

/** Build a BillingService over a MemoryStore seeded with the given containers. */
async function makeService(containers: Container[]): Promise<{ service: BillingService; store: MemoryStore }> {
  const store = new MemoryStore();
  for (const c of containers) await store.saveContainer(c);
  const service = new BillingService({
    config: { enabled: true, usageCollectionIntervalSec: 60 },
    store,
    orchestrator: new MockOrchestrator(),
  });
  return { service, store };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('BillingService.collectUsage strand metering', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sets peakStrands from the live /status active strand count', async () => {
    const { service, store } = await makeService([runningContainer()]);
    const saved = vi.spyOn(store, 'saveUsageMetrics');

    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'healthy',
      uptime: 12,
      node: { strands: { total: 5, active: 3, idle: 1, hibernating: 1 } },
    })) as typeof globalThis.fetch;

    await (service as unknown as CollectUsageInternal).collectUsage();

    expect(saved).toHaveBeenCalledTimes(1);
    const metrics = saved.mock.calls[0][0] as UsageMetrics;
    expect(metrics.peakStrands).toBe(3);
    expect(metrics.bandwidthBytes).toBe(512 * 1024); // MockOrchestrator networkTxBytes
    expect(metrics.storageBytes).toBe(0); // blocked on Arachnode storage ring
  });

  it('hits the derived /status URL (not /health)', async () => {
    const { service } = await makeService([runningContainer()]);
    const fetchMock = vi.fn(async () => jsonResponse({
      status: 'healthy', uptime: 1, node: { strands: { total: 0, active: 0, idle: 0, hibernating: 0 } },
    }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await (service as unknown as CollectUsageInternal).collectUsage();

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/status');
  });

  it('falls back to 0 strands and keeps collecting when /status fetch fails', async () => {
    const { service, store } = await makeService([
      runningContainer({ id: 'ctr_a', healthEndpoint: 'http://localhost:8081/health' }),
      runningContainer({ id: 'ctr_b', healthEndpoint: 'http://localhost:8082/health' }),
    ]);
    const saved = vi.spyOn(store, 'saveUsageMetrics');

    // First container's status fetch throws; second succeeds with 7 active.
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(jsonResponse({
        status: 'healthy', uptime: 3, node: { strands: { total: 9, active: 7, idle: 2, hibernating: 0 } },
      })) as typeof globalThis.fetch;

    await (service as unknown as CollectUsageInternal).collectUsage();

    // Both containers still produce metrics — the failure did not abort the loop.
    expect(saved).toHaveBeenCalledTimes(2);
    const byId = new Map(
      saved.mock.calls.map(([m]) => [(m as UsageMetrics).containerId, m as UsageMetrics])
    );
    expect(byId.get('ctr_a')?.peakStrands).toBe(0);
    expect(byId.get('ctr_b')?.peakStrands).toBe(7);
  });

  it('skips containers that are not running', async () => {
    const { service, store } = await makeService([
      runningContainer({ id: 'ctr_stopped', status: 'stopped' }),
      runningContainer({ id: 'ctr_no_docker', dockerId: undefined }),
    ]);
    const saved = vi.spyOn(store, 'saveUsageMetrics');
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;

    await (service as unknown as CollectUsageInternal).collectUsage();

    expect(saved).not.toHaveBeenCalled();
  });
});
