/**
 * Which container statuses consume one of a customer's plan slots.
 *
 * Nothing ever deletes a container record and `DELETE /containers/:id` only ever
 * reaches `stopped`, so counting `error` against the plan locked a tenant out
 * permanently once enough provisions had failed. Every path that writes `error`
 * reclaims the container first, so an `error` record names nothing live.
 */

import { describe, it, expect } from 'vitest';
import { BillingService, DEFAULT_PLANS } from '../billing-service.js';
import { ContainerService } from '../container-service.js';
import { MemoryStore } from '../store.js';
import { MockOrchestrator } from '../orchestrator.js';
import type { Container, ContainerStatus, SubscriptionStatus } from '../../types.js';

const PLAN = DEFAULT_PLANS.starter!;

function container(id: string, status: ContainerStatus): Container {
  const at = new Date('2026-06-01T12:00:00.000Z');
  return {
    id,
    customerId: 'cust-1',
    partyId: 'party-1',
    profile: 'transaction',
    status,
    resources: {},
    tags: {},
    createdAt: at,
    updatedAt: at,
  };
}

/** A starter-plan customer whose subscription is `subscription`, holding `count` records in `status`. */
async function serviceFor(subscription: SubscriptionStatus, count = 0, status: ContainerStatus = 'running'): Promise<BillingService> {
  const store = new MemoryStore();
  await store.saveCustomerBilling({
    customerId: 'cust-1',
    planId: PLAN.id,
    balanceCents: 0,
    currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
    subscription: {
      status: subscription,
      renewsAt: null,
      lapsesAt: subscription === 'past-due' ? new Date('2026-07-08T00:00:00.000Z') : null,
    },
  });
  for (let i = 0; i < count; i++) {
    await store.saveContainer(container(`ctr_${i}`, status));
  }
  const orchestrator = new MockOrchestrator();
  return new BillingService({
    config: { enabled: true },
    store,
    orchestrator,
    containerService: new ContainerService({ store, orchestrator }),
  });
}

/** A customer on the starter plan holding `plan.maxContainers` records in `status`. */
function serviceAtPlanLimit(status: ContainerStatus): Promise<BillingService> {
  return serviceFor('active', PLAN.maxContainers, status);
}

describe('BillingService.canCreateContainer quota statuses', () => {
  it.each<ContainerStatus>(['pending', 'creating', 'enrolling', 'running', 'stopping'])(
    'counts a %s container against the plan limit',
    async (status) => {
      const billing = await serviceAtPlanLimit(status);

      const result = await billing.canCreateContainer('cust-1');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(`Plan limit reached (${PLAN.maxContainers} containers)`);
    }
  );

  // The tenant-visible half of the fix: a customer sitting at their limit purely
  // because of failed provisions can create containers again.
  it.each<ContainerStatus>(['error', 'stopped'])(
    'does not count a %s container against the plan limit',
    async (status) => {
      const billing = await serviceAtPlanLimit(status);

      expect(await billing.canCreateContainer('cust-1')).toEqual({ allowed: true });
    }
  );
});

describe('BillingService.canCreateContainer subscription status', () => {
  it('refuses a lapsed customer', async () => {
    const billing = await serviceFor('lapsed');

    expect(await billing.canCreateContainer('cust-1')).toEqual({ allowed: false, reason: 'Subscription lapsed' });
  });

  // The grace period is the operator's call: a past-due customer keeps renting until it lapses.
  it('allows a past-due customer', async () => {
    const billing = await serviceFor('past-due');

    expect(await billing.canCreateContainer('cust-1')).toEqual({ allowed: true });
  });
});
