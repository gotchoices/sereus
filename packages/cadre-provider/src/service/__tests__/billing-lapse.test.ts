/**
 * A lapsed subscription stops its customer's containers, and the billing tick lapses a
 * past-due subscription once its grace period has ended.
 */

import { describe, it, expect } from 'vitest';
import { BillingService } from '../billing-service.js';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import { MockOrchestrator } from '../orchestrator.js';
import type { Container, Subscription } from '../../types.js';

const NOW = new Date('2026-07-10T00:00:00.000Z');

function running(id: string, customerId: string): Container {
  const at = new Date('2026-06-01T12:00:00.000Z');
  return {
    id,
    customerId,
    partyId: 'party-1',
    profile: 'transaction',
    status: 'running',
    dockerId: `docker-${id}`,
    resources: {},
    tags: {},
    createdAt: at,
    updatedAt: at,
  };
}

async function saveCustomer(store: MemoryStore, customerId: string, subscription: Subscription): Promise<void> {
  await store.saveCustomerBilling({
    customerId,
    planId: 'starter',
    balanceCents: 0,
    currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
    subscription,
  });
}

function makeService(store: MemoryStore): BillingService {
  const orchestrator = new MockOrchestrator();
  return new BillingService({
    config: { enabled: true },
    store,
    orchestrator,
    containerService: new ContainerService({ store, orchestrator }),
    now: () => NOW,
  });
}

describe('BillingService.lapseSubscription', () => {
  it("stops the customer's running containers for non-payment and leaves another customer's running", async () => {
    const store = new MemoryStore();
    await saveCustomer(store, 'cust-1', { status: 'active', renewsAt: new Date('2026-08-01T00:00:00.000Z'), lapsesAt: null });
    await saveCustomer(store, 'cust-2', { status: 'active', renewsAt: new Date('2026-08-01T00:00:00.000Z'), lapsesAt: null });
    await store.saveContainer(running('ctr_a', 'cust-1'));
    await store.saveContainer(running('ctr_b', 'cust-1'));
    await store.saveContainer(running('ctr_c', 'cust-2'));

    await makeService(store).lapseSubscription('cust-1');

    for (const id of ['ctr_a', 'ctr_b']) {
      const stopped = await store.getContainer(id);
      expect(stopped?.status).toBe('stopped');
      expect(stopped?.stopReason).toBe('non-payment');
    }
    const other = await store.getContainer('ctr_c');
    expect(other?.status).toBe('running');
    expect(other?.stopReason).toBeUndefined();
    expect((await store.getCustomerBilling('cust-1'))?.subscription)
      .toEqual({ status: 'lapsed', renewsAt: null, lapsesAt: null });
  });
});

describe('BillingService.lapseOverdue', () => {
  it('lapses a past-due subscription whose lapsesAt has passed, and not one whose lapsesAt is later', async () => {
    const store = new MemoryStore();
    await saveCustomer(store, 'cust-due', { status: 'past-due', renewsAt: null, lapsesAt: new Date('2026-07-09T00:00:00.000Z') });
    await saveCustomer(store, 'cust-grace', { status: 'past-due', renewsAt: null, lapsesAt: new Date('2026-07-11T00:00:00.000Z') });
    await store.saveContainer(running('ctr_due', 'cust-due'));
    await store.saveContainer(running('ctr_grace', 'cust-grace'));

    expect(await makeService(store).lapseOverdue()).toEqual(['cust-due']);

    expect((await store.getCustomerBilling('cust-due'))?.subscription.status).toBe('lapsed');
    expect((await store.getContainer('ctr_due'))?.stopReason).toBe('non-payment');
    expect((await store.getCustomerBilling('cust-grace'))?.subscription.status).toBe('past-due');
    expect((await store.getContainer('ctr_grace'))?.status).toBe('running');
  });
});
