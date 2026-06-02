/**
 * Billing service for usage metering and payment processing.
 */

import debug from 'debug';
import type { Container, UsageMetrics, BillingPlan, CustomerBilling } from '../types.js';
import type { ProviderStore } from './store.js';
import type { Orchestrator } from './orchestrator.js';
import { fetchContainerHealthStatus } from './container-health.js';
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

/** Billing service options */
export interface BillingServiceOptions {
  config: BillingConfig;
  store: ProviderStore;
  orchestrator: Orchestrator;
  hooks?: BillingHooks;
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
  private collectionInterval?: ReturnType<typeof setInterval>;

  constructor(options: BillingServiceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.hooks = options.hooks ?? {};
    this.plans = new Map(Object.entries(DEFAULT_PLANS));
    log('BillingService initialized, enabled: %s', this.config.enabled);
  }

  /** Start usage collection */
  start(): void {
    if (!this.config.enabled) return;

    const intervalMs = (this.config.usageCollectionIntervalSec ?? 60) * 1000;
    this.collectionInterval = setInterval(() => {
      this.collectUsage().catch(err => log('Usage collection error: %O', err));
    }, intervalMs);

    log('Usage collection started with interval %dms', intervalMs);
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
        const health = await fetchContainerHealthStatus(container);
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

    const containers = await this.store.listContainers(customerId);
    const activeContainers = containers.filter(c => c.status !== 'stopped');

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
    };

    await this.store.saveCustomerBilling(billing);
    return billing;
  }
}

