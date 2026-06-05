/**
 * Type definitions for the Sereus Cadre Provider service.
 */

import type { ContainerHealthStatus } from './service/container-health.js';

// ============================================================================
// Container Types
// ============================================================================

/** Container status lifecycle */
export type ContainerStatus =
  | 'pending'      // Container requested, not yet created
  | 'creating'     // Container being provisioned
  | 'enrolling'    // Container started, awaiting enrollment
  | 'running'      // Container running and enrolled
  | 'stopping'     // Container shutting down
  | 'stopped'      // Container terminated
  | 'error';       // Container in error state

/** Container resource specifications */
export interface ContainerResources {
  /** Memory limit (e.g., "512M", "2G") */
  memoryLimit?: string;
  /** CPU limit (e.g., "0.5", "2") */
  cpuLimit?: string;
  /** Storage quota in bytes */
  storageQuotaBytes?: number;
}

/** Container configuration for creation */
export interface CreateContainerRequest {
  /** Customer/user ID who owns this container */
  customerId: string;
  /** Party ID for the control network */
  partyId: string;
  /** Bootstrap nodes for the control network */
  bootstrapNodes: string[];
  /** Node profile: storage or transaction */
  profile: 'storage' | 'transaction';
  /** Resource specifications */
  resources?: ContainerResources;
  /** Optional strand filter */
  strandFilter?: string;
  /** Optional tags for the container */
  tags?: Record<string, string>;
}

/** Container record in the provider database */
export interface Container {
  /** Unique container ID */
  id: string;
  /** Customer/user ID */
  customerId: string;
  /** Party ID for the control network */
  partyId: string;
  /** Node profile */
  profile: 'storage' | 'transaction';
  /** Current status */
  status: ContainerStatus;
  /** Docker container ID */
  dockerId?: string;
  /** Resource specifications */
  resources: ContainerResources;
  /** Container tags */
  tags: Record<string, string>;
  /** Creation timestamp */
  createdAt: Date;
  /** Last updated timestamp */
  updatedAt: Date;
  /** Error message if status is 'error' */
  error?: string;
  /** Health check endpoint URL */
  healthEndpoint?: string;
  /** Metrics endpoint URL */
  metricsEndpoint?: string;
  /** Seed API endpoint URL (for applying seeds) */
  seedEndpoint?: string;
  /**
   * Bearer token gating the container's `POST /seed` route (injected as
   * `CADRE_SEED_TOKEN` at provision time). `applySeed` presents it as
   * `Authorization: Bearer <seedToken>`; without it the container rejects the seed.
   */
  seedToken?: string;
}

/** Container status response */
export interface ContainerStatusResponse {
  container: Container;
  /**
   * Live `/status` payload from the container's health server, or `undefined`
   * when unavailable. Strand counts live under `health.node.strands` (matching
   * the real wire shape) — read them as `health?.node?.strands?.active ?? 0`.
   */
  health?: ContainerHealthStatus;
}

// ============================================================================
// Billing Types
// ============================================================================

/** Usage metrics for billing */
export interface UsageMetrics {
  /** Container ID */
  containerId: string;
  /** Measurement period start */
  periodStart: Date;
  /** Measurement period end */
  periodEnd: Date;
  /** Uptime in seconds */
  uptimeSeconds: number;
  /** Storage used in bytes */
  storageBytes: number;
  /** Bandwidth in bytes (egress) */
  bandwidthBytes: number;
  /** Number of active strands (peak) */
  peakStrands: number;
}

/** Billing plan definition */
export interface BillingPlan {
  /** Plan ID */
  id: string;
  /** Plan name */
  name: string;
  /** Price per hour in cents */
  pricePerHourCents: number;
  /** Storage included in bytes */
  storageIncludedBytes: number;
  /** Price per GB-month for additional storage in cents */
  storageOverageCentsPerGbMonth: number;
  /** Bandwidth included in bytes */
  bandwidthIncludedBytes: number;
  /** Price per GB for additional bandwidth in cents */
  bandwidthOverageCentsPerGb: number;
  /** Maximum containers allowed */
  maxContainers: number;
}

/** Customer billing status */
export interface CustomerBilling {
  /** Customer ID */
  customerId: string;
  /** Current billing plan */
  planId: string;
  /** Current balance in cents (negative = credit) */
  balanceCents: number;
  /** Payment method on file */
  paymentMethodId?: string;
  /** Billing email */
  billingEmail?: string;
  /** Current period start */
  currentPeriodStart: Date;
  /** Current period end */
  currentPeriodEnd: Date;
}

// ============================================================================
// API Types
// ============================================================================

/** API key record */
export interface ApiKey {
  /** Hashed key (for lookup) */
  keyHash: string;
  /** Customer ID */
  customerId: string;
  /** Key name/description */
  name: string;
  /** Key permissions */
  permissions: string[];
  /** Creation timestamp */
  createdAt: Date;
  /** Last used timestamp */
  lastUsedAt?: Date;
  /** Expiration timestamp (optional) */
  expiresAt?: Date;
}

