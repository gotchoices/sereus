/**
 * Billing service for usage metering and payment processing.
 */

import debug from 'debug';
import type {
  Container,
  ContainerStatus,
  UsageMetrics,
  BillingPlan,
  CustomerBilling,
  Subscription,
  SubscriptionStatus,
} from '../types.js';
import type { ProviderStore } from './store.js';
import type { Orchestrator } from './orchestrator.js';
import type { ContainerService } from './container-service.js';
import { type ContainerHealthStatus, fetchContainerHealthStatus } from './container-health.js';
import type { BillingConfig } from '../config/types.js';

const log = debug('cadre:provider:billing');

/** Billing service hooks for payment processor integration */
export interface BillingHooks {
  /** Process a payment for the given amount */
  processPayment?(customerId: string, amountCents: number): Promise<{ success: boolean; transactionId?: string }>;
  /** Get customer's payment method */
  getPaymentMethod?(customerId: string): Promise<{ id: string; last4: string } | undefined>;
  /** Send invoice to customer */
  sendInvoice?(customerId: string, amountCents: number, lineItems: InvoiceLineItem[]): Promise<void>;
}

/** Invoice line item */
export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

/** Default billing plans */
export const DEFAULT_PLANS: Record<string, BillingPlan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    pricePerHourCents: 1, // $0.01/hour ≈ $7.20/month
    storageIncludedBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    storageOverageCentsPerGbMonth: 10, // $0.10/GB/month
    bandwidthIncludedBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    bandwidthOverageCentsPerGb: 5, // $0.05/GB
    maxContainers: 3,
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    pricePerHourCents: 5, // $0.05/hour ≈ $36/month
    storageIncludedBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    storageOverageCentsPerGbMonth: 5,
    bandwidthIncludedBytes: 1024 * 1024 * 1024 * 1024, // 1 TB
    bandwidthOverageCentsPerGb: 2,
    maxContainers: 10,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    pricePerHourCents: 20,
    storageIncludedBytes: 1024 * 1024 * 1024 * 1024, // 1 TB
    storageOverageCentsPerGbMonth: 2,
    bandwidthIncludedBytes: 10 * 1024 * 1024 * 1024 * 1024, // 10 TB
    bandwidthOverageCentsPerGb: 1,
    maxContainers: 100,
  },
};

/**
 * Statuses that consume one of a customer's plan slots: everything that may
 * still name live resources. `stopped` and `error` do not — every path that
 * writes `error` reclaims the container first (provisioning failure, enrollment
 * failure, `ContainerService.reapStuckContainers`), and nothing ever deletes a
 * container record, so counting `error` would lock a tenant out of their plan
 * permanently once enough provisions had failed.
 */
export const QUOTA_CONSUMING_STATUSES: ReadonlySet<ContainerStatus> = new Set<ContainerStatus>([
  'pending',
  'creating',
  'enrolling',
  'running',
  'stopping',
]);

/**
 * What `BillingService.updateSubscription` may write. `lapsed` is not among the statuses: a
 * lapse also stops the customer's containers, so it goes through `lapseSubscription`.
 */
export type SubscriptionPatch = Partial<Omit<Subscription, 'status'>> & {
  status?: Exclude<SubscriptionStatus, 'lapsed'>;
};

/** Whether the record is `past-due` with a lapse date at or before `nowMs`. */
function isOverdue(billing: CustomerBilling, nowMs: number): boolean {
  const { status, lapsesAt } = billing.subscription;
  return status === 'past-due' && lapsesAt !== null && lapsesAt.getTime() <= nowMs;
}

/** Billing service options */
export interface BillingServiceOptions {
  config: BillingConfig;
  store: ProviderStore;
  orchestrator: Orchestrator;
  /** Stops a lapsed customer's containers. ContainerService does not depend on billing, so there is no cycle. */
  containerService: Pick<ContainerService, 'terminateContainer'>;
  hooks?: BillingHooks;
  /**
   * How the usage collector reads a container's live `/status`. The server passes
   * `ContainerService.readStatus`, so the collector's read keeps the record's join state
   * current like every other read the provider makes. Defaults to the bare fetch.
   */
  readStatus?: (container: Container) => Promise<ContainerHealthStatus | undefined>;
  /** Clock override, so the lapse sweep can be tested by handing the service a date. */
  now?: () => Date;
}

/**
 * Service for usage metering, quota enforcement, and billing.
 */
export class BillingService {
  private readonly config: BillingConfig;
  private readonly store: ProviderStore;
  private readonly orchestrator: Orchestrator;
  private readonly hooks: BillingHooks;
  private readonly plans: Map<string, BillingPlan>;
  private readonly readStatus: (container: Container) => Promise<ContainerHealthStatus | undefined>;
  private readonly containerService: Pick<ContainerService, 'terminateContainer'>;
  private readonly now: () => Date;
  private collectionInterval?: ReturnType<typeof setInterval>;
  /** Customers whose lapse is in flight, so a tick and the webhook cannot stop the same containers twice. */
  private readonly lapsing = new Set<string>();

  constructor(options: BillingServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.hooks = options.hooks ?? {};
    this.readStatus = options.readStatus ?? fetchContainerHealthStatus;
    this.containerService = options.containerService;
    this.now = options.now ?? (() => new Date());
    this.plans = new Map(Object.entries(DEFAULT_PLANS));
    log('BillingService initialized, enabled: %s', this.config.enabled);
  }

  /** Start the billing tick: usage collection, then the lapse of overdue subscriptions. */
  start(): void {
    if (!this.config.enabled) return;

    const intervalMs = (this.config.usageCollectionIntervalSec ?? 60) * 1000;
    this.collectionInterval = setInterval(() => { void this.tick(); }, intervalMs);

    log('Usage collection started with interval %dms', intervalMs);
  }

  private async tick(): Promise<void> {
    await this.collectUsage().catch(err => log('Usage collection error: %O', err));
    await this.lapseOverdue().catch(err => log('Lapse sweep error: %O', err));
  }

  /** Stop usage collection */
  stop(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = undefined;
    }
  }

  /** Collect usage metrics from all running containers */
  private async collectUsage(): Promise<void> {
    const containers = await this.store.listContainers();
    const now = new Date();
    const periodStart = new Date(now.getTime() - (this.config.usageCollectionIntervalSec ?? 60) * 1000);

    for (const container of containers) {
      if (container.status !== 'running' || !container.dockerId) continue;

      try {
        const stats = await this.orchestrator.getStats(container.dockerId);

        // Sample live strand counts from the container's /status endpoint.
        // Resolves to undefined on any fetch failure (helper swallows errors),
        // so a single unreachable container degrades to 0 strands rather than
        // aborting the whole collection pass.
        const health = await this.readStatus(container);
        const peakStrands = health?.node?.strands?.active ?? 0;

        const metrics: UsageMetrics = {
          containerId: container.id,
          periodStart,
          periodEnd: now,
          uptimeSeconds: (this.config.usageCollectionIntervalSec ?? 60),
          // Storage usage is not observable yet: neither the container health
          // server nor orchestrator stats surface bytes-on-disk. Real metering
          // is blocked on the Arachnode storage ring — see
          // tickets/backlog/later/5-quota-enforcement.md. Report 0 until then.
          storageBytes: 0,
          bandwidthBytes: stats.networkTxBytes,
          // Instantaneous active-strand sample at collection time, not a true
          // period peak (a real peak needs continuous sampling — separate
          // enhancement). 0 when /status is unavailable.
          peakStrands,
        };
        await this.store.saveUsageMetrics(metrics);
      } catch (err) {
        log('Failed to collect usage for %s: %O', container.id, err);
      }
    }
  }

  /** Check if customer can create more containers */
  async canCreateContainer(customerId: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.config.enabled) return { allowed: true };

    const billing = await this.store.getCustomerBilling(customerId);
    if (!billing) return { allowed: true }; // No billing record = free tier or new customer

    const plan = this.plans.get(billing.planId);
    if (!plan) return { allowed: true };

    // `past-due` still creates: the grace period is the operator's call.
    if (billing.subscription.status === 'lapsed') {
      return { allowed: false, reason: 'Subscription lapsed' };
    }

    const containers = await this.store.listContainers(customerId);
    const activeContainers = containers.filter(c => QUOTA_CONSUMING_STATUSES.has(c.status));

    if (activeContainers.length >= plan.maxContainers) {
      return { allowed: false, reason: `Plan limit reached (${plan.maxContainers} containers)` };
    }

    if (billing.balanceCents > 0 && !billing.paymentMethodId) {
      return { allowed: false, reason: 'Outstanding balance requires payment method' };
    }

    return { allowed: true };
  }

  /** Get billing plan */
  getPlan(planId: string): BillingPlan | undefined {
    return this.plans.get(planId);
  }

  /** List available plans */
  listPlans(): BillingPlan[] {
    return Array.from(this.plans.values());
  }

  /** Get customer billing status */
  async getCustomerBilling(customerId: string): Promise<CustomerBilling | undefined> {
    return this.store.getCustomerBilling(customerId);
  }

  /** Initialize billing for a new customer */
  async initializeCustomer(customerId: string, planId?: string): Promise<CustomerBilling> {
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const billing: CustomerBilling = {
      customerId,
      planId: planId ?? this.config.defaultPlanId ?? 'starter',
      balanceCents: 0,
      currentPeriodStart: now,
      currentPeriodEnd: endOfMonth,
      subscription: { status: 'active', renewsAt: endOfMonth, lapsesAt: null },
    };

    await this.store.saveCustomerBilling(billing);
    return billing;
  }

  /**
   * Write what the operator's payment processor reports about a customer's subscription: the
   * one write its webhook makes (README → Custom Billing). Only writes fields; `lapsesAt` is
   * cleared whenever the result is not `past-due`, since it means nothing otherwise.
   *
   * @throws when the customer has no billing record, or when asked to write `lapsed`.
   */
  async updateSubscription(customerId: string, patch: SubscriptionPatch): Promise<Subscription> {
    // The type already excludes it; a JavaScript caller writing it would lapse the record
    // without stopping anything, and `lapseSubscription` would then find nothing to do.
    if ((patch.status as SubscriptionStatus | undefined) === 'lapsed') {
      throw new Error('A subscription lapses through lapseSubscription, which also stops its containers');
    }
    const billing = await this.requireBilling(customerId);
    const next: Subscription = { ...billing.subscription, ...patch };
    if (next.status !== 'past-due') next.lapsesAt = null;
    billing.subscription = next;
    await this.store.saveCustomerBilling(billing);
    log('Subscription for %s is now %s', customerId, next.status);
    return next;
  }

  /**
   * Mark the customer's subscription `lapsed` and stop every container of theirs that is
   * still up, with `stopReason: 'non-payment'`. A renewal afterwards does not restart them:
   * each container's volume went with it.
   *
   * NOTE: the record is marked before the containers are stopped, so a lapsed customer
   * cannot create one mid-lapse; a provider that dies partway leaves the rest running for a
   * lapsed customer, and nothing retries. If that is ever seen, have the tick also stop the
   * live containers of lapsed customers.
   *
   * @throws when the customer has no billing record.
   */
  async lapseSubscription(customerId: string): Promise<void> {
    await this.lapseWhen(customerId, billing => billing.subscription.status !== 'lapsed');
  }

  /**
   * Lapse every `past-due` subscription whose `lapsesAt` has passed. Runs on the billing
   * tick; a failure on one customer is logged and the sweep continues.
   *
   * @returns the customers lapsed.
   */
  async lapseOverdue(): Promise<string[]> {
    const nowMs = this.now().getTime();
    const overdue = (await this.store.listCustomerBilling()).filter(billing => isOverdue(billing, nowMs));
    const lapsed: string[] = [];
    for (const { customerId } of overdue) {
      try {
        // Re-tested on the stored record: the webhook may have renewed it since the list.
        if (await this.lapseWhen(customerId, billing => isOverdue(billing, nowMs))) lapsed.push(customerId);
      } catch (err) {
        log('Failed to lapse subscription for %s: %O', customerId, err);
      }
    }
    return lapsed;
  }

  /**
   * Lapse the customer's subscription if `due` holds for the stored record. A second caller
   * for the same customer (an overlapping tick, or the webhook) returns while the first is in
   * flight, and finds the record already lapsed once it is done.
   *
   * @returns whether this call lapsed it.
   */
  private async lapseWhen(customerId: string, due: (billing: CustomerBilling) => boolean): Promise<boolean> {
    if (this.lapsing.has(customerId)) return false;
    this.lapsing.add(customerId);
    try {
      const billing = await this.requireBilling(customerId);
      if (!due(billing)) return false;
      billing.subscription = { status: 'lapsed', renewsAt: null, lapsesAt: null };
      await this.store.saveCustomerBilling(billing);
      log('Subscription for %s lapsed; stopping its containers', customerId);
      await this.stopForNonPayment(customerId);
      return true;
    } finally {
      this.lapsing.delete(customerId);
    }
  }

  /**
   * Terminate the customer's containers that are still up, one at a time, logging and
   * continuing past a failure. A `stopping` record is skipped: a `DELETE` or the reap is
   * already stopping it.
   */
  private async stopForNonPayment(customerId: string): Promise<void> {
    const live = (await this.store.listContainers(customerId))
      .filter(c => c.status !== 'stopping' && QUOTA_CONSUMING_STATUSES.has(c.status));
    for (const container of live) {
      try {
        if (!(await this.containerService.terminateContainer(container.id, { reason: 'non-payment' }))) {
          log('Container %s of lapsed customer %s could not be stopped', container.id, customerId);
        }
      } catch (err) {
        log('Failed to stop container %s of lapsed customer %s: %O', container.id, customerId, err);
      }
    }
  }

  /** The customer's billing record; throws when there is none. */
  private async requireBilling(customerId: string): Promise<CustomerBilling> {
    const billing = await this.store.getCustomerBilling(customerId);
    if (!billing) throw new Error(`No billing record for customer ${customerId}`);
    return billing;
  }
}

