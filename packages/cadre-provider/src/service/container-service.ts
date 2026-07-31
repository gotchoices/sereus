/**
 * Container lifecycle management service.
 */

import debug from 'debug';
import { nanoid } from 'nanoid';
import type {
  Container,
  ContainerStatus,
  CreateContainerRequest,
  ContainerStatusResponse,
} from '../types.js';
import type { ProviderStore } from './store.js';
import type { Orchestrator } from './orchestrator.js';
import type { ProviderPushConfig, PushCredentials } from '../config/types.js';
import { fetchContainerHealthStatus } from './container-health.js';

const log = debug('cadre:provider:container');

/**
 * Resolve the push credentials for ONE tenant: the per-tenant override keyed by
 * `customerId`, else the provider-level default, else none. This is the single
 * cross-tenant boundary — a tenant only ever sees its own override or the shared
 * default, never another tenant's override.
 */
export function resolveTenantPush(
  push: ProviderPushConfig | undefined,
  customerId: string,
): PushCredentials | undefined {
  if (!push) return undefined;
  return push.tenants?.[customerId] ?? push.default;
}

/**
 * Normalize the tenant-supplied seed-trust anchors to exactly what the node will
 * end up honouring: trimmed, empties dropped, deduped — the same reduction
 * `cadre-cli`'s `collectPinnedOwnerKeys` applies to `CADRE_OWNER_KEYS`. Doing it
 * here means `[""]` (which the CLI parses back to "trust nobody") is recorded and
 * forwarded as no keys at all, rather than as a pin the operator can see but the
 * node does not have. Returns a fresh array, so a later mutation of the caller's
 * array cannot rewrite what the record says the node was told to trust.
 */
function normalizePinnedOwnerKeys(keys: string[] | undefined): string[] {
  return [...new Set((keys ?? []).map(key => key.trim()).filter(key => key.length > 0))];
}

/** Container service options */
export interface ContainerServiceOptions {
  /** Store for persisting container state */
  store: ProviderStore;
  /** Container orchestrator (Docker, K8s, etc.) */
  orchestrator: Orchestrator;
  /**
   * Per-tenant push (FCM/APNs) credentials. Resolved by `customerId` at provision
   * time and injected into that tenant's node only. Omit to disable push.
   */
  push?: ProviderPushConfig;
}

/**
 * Service for managing container lifecycle.
 * Handles creation, status monitoring, and termination.
 */
export class ContainerService {
  private readonly store: ProviderStore;
  private readonly orchestrator: Orchestrator;
  private readonly push?: ProviderPushConfig;

  constructor(options: ContainerServiceOptions) {
    this.store = options.store;
    this.orchestrator = options.orchestrator;
    this.push = options.push;
    log('ContainerService initialized');
  }

  /** Generate a unique container ID */
  private generateId(): string {
    return `ctr_${nanoid(16)}`;
  }

  /** Create a new container */
  async createContainer(request: CreateContainerRequest): Promise<Container> {
    const id = this.generateId();
    const now = new Date();

    log('Creating container %s for customer %s', id, request.customerId);

    const pinnedOwnerKeys = normalizePinnedOwnerKeys(request.pinnedOwnerKeys);
    const container: Container = {
      id,
      customerId: request.customerId,
      partyId: request.partyId,
      profile: request.profile,
      status: 'pending',
      resources: request.resources ?? {},
      tags: request.tags ?? {},
      createdAt: now,
      updatedAt: now,
      ...(pinnedOwnerKeys.length ? { pinnedOwnerKeys } : {}),
    };

    // Save initial state
    await this.store.saveContainer(container);

    // Start provisioning asynchronously
    this.provisionContainer(container, request).catch(err => {
      log('Provisioning failed for %s: %O', id, err);
    });

    return container;
  }

  /** Provision the container via orchestrator */
  private async provisionContainer(
    container: Container,
    request: CreateContainerRequest
  ): Promise<void> {
    // Once the orchestrator hands back a dockerId, this service owns cleanup of
    // those resources (bounded host ports) on every non-success exit.
    let dockerId: string | undefined;
    try {
      // Update status to creating
      await this.updateStatus(container.id, 'creating');

      // Resolve push strictly by the OWNING tenant's id — never another tenant's.
      const push = resolveTenantPush(this.push, container.customerId);

      // Seed-trust anchors come from THIS tenant's own create request and nowhere
      // else — same one-tenant-in, one-tenant-out discipline as push above, but
      // with no default tier at all: a provider-wide pin would let one tenant's
      // owner seed another tenant's node. Read off the record (normalized at
      // create time), so the stored field is the single authority on what the
      // node was told to trust and a future re-provision from the record alone
      // reproduces the same pins.
      const pinnedOwnerKeys = container.pinnedOwnerKeys ?? [];
      if (pinnedOwnerKeys.length === 0) {
        // Not an error — a container may legitimately be created before its owner
        // key is known. But it will refuse every seed until recreated, so make the
        // eventual refusal traceable to the create call that caused it.
        log('Container %s created with no pinned owner keys; it will reject any seed delivered to it', container.id);
      }

      // Create the container via orchestrator
      const result = await this.orchestrator.createContainer({
        containerId: container.id,
        partyId: request.partyId,
        bootstrapNodes: request.bootstrapNodes,
        profile: request.profile,
        resources: request.resources,
        strandFilter: request.strandFilter,
        ...(push ? { push } : {}),
        ...(pinnedOwnerKeys.length ? { pinnedOwnerKeys } : {}),
      });
      dockerId = result.dockerId;

      // Update with orchestrator details
      const updated = await this.store.getContainer(container.id);
      if (!updated) {
        // Record vanished after a successful create — reclaim the orchestrator
        // resources we just allocated so the host port range does not leak.
        await this.safeReclaim(dockerId);
        return;
      }

      updated.dockerId = result.dockerId;
      updated.healthEndpoint = result.healthEndpoint;
      updated.metricsEndpoint = result.metricsEndpoint;
      updated.seedEndpoint = result.seedEndpoint;
      updated.seedToken = result.seedToken;
      updated.status = 'enrolling';
      updated.updatedAt = new Date();
      await this.store.saveContainer(updated);

      log('Container %s provisioned, waiting for enrollment', container.id);

      // Wait for enrollment (health check shows healthy)
      await this.waitForEnrollment(container.id, 60000);

    } catch (error) {
      log('Container %s provisioning error: %O', container.id, error);
      const updated = await this.store.getContainer(container.id);
      if (updated) {
        updated.status = 'error';
        updated.error = error instanceof Error ? error.message : String(error);
        updated.updatedAt = new Date();
        await this.store.saveContainer(updated);
      }
      // If a container was created before the failure, reclaim it — otherwise it
      // keeps running with its host ports held.
      if (dockerId) await this.safeReclaim(dockerId);
    }
  }

  /** Best-effort orchestrator removal; logs but never throws (already on an error/cleanup path). */
  private async safeReclaim(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.removeContainer(dockerId);
    } catch (err) {
      log('Failed to reclaim orchestrator resources for %s: %O', dockerId, err);
    }
  }

  /** Wait for container to become healthy */
  private async waitForEnrollment(containerId: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startTime < timeoutMs) {
      const container = await this.store.getContainer(containerId);
      if (!container || container.status === 'error') return;

      // Read `/status` rather than `/health`: it reports the same `status` field
      // and additionally carries the node's `peerId`, which we record once here.
      // `fetchContainerHealthStatus` swallows unreachable/non-OK responses, so a
      // node that is still starting simply keeps the loop waiting.
      const health = await fetchContainerHealthStatus(container);
      if (health?.status === 'healthy') {
        // peerId is durable for the life of the container's volume, so the
        // first healthy report is authoritative; it is absent only if the node
        // reports healthy before acquiring a libp2p identity.
        // NOTE: nothing backfills it afterwards. Harmless while every consumer of
        // peerId reads live `/status` (`getPeerInfo`); if the stored field ever
        // becomes a read path of its own, add a backfill on the next status read.
        await this.updateStatus(containerId, 'running', health.peerId ? { peerId: health.peerId } : undefined);
        log('Container %s is now running (peer %s)', containerId, health.peerId ?? 'unknown');
        return;
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    log('Container %s enrollment timeout', containerId);
  }

  /** Update container status, optionally stamping additional fields in the same save. */
  private async updateStatus(
    id: string,
    status: ContainerStatus,
    patch?: Partial<Container>
  ): Promise<void> {
    const container = await this.store.getContainer(id);
    if (!container) return;
    if (patch) Object.assign(container, patch);
    container.status = status;
    container.updatedAt = new Date();
    await this.store.saveContainer(container);
  }

  /** Get container by ID */
  async getContainer(id: string): Promise<Container | undefined> {
    return this.store.getContainer(id);
  }

  /** Get detailed container status including health */
  async getContainerStatus(id: string): Promise<ContainerStatusResponse | undefined> {
    const container = await this.store.getContainer(id);
    if (!container) return undefined;

    const response: ContainerStatusResponse = { container };

    // Fetch live `/status` for running containers. The shared helper derives the
    // `/status` URL, short-circuits to `undefined` when there is no health
    // endpoint / the fetch fails / the response is non-OK, and parses into the
    // wire-accurate ContainerHealthStatus — so the declared type stays honest.
    if (container.status === 'running') {
      response.health = await fetchContainerHealthStatus(container);
    }

    return response;
  }

  /** List containers, optionally filtered by customer */
  async listContainers(customerId?: string): Promise<Container[]> {
    return this.store.listContainers(customerId);
  }

  /** Terminate a container */
  async terminateContainer(id: string): Promise<boolean> {
    const container = await this.store.getContainer(id);
    if (!container) return false;

    log('Terminating container %s', id);

    try {
      await this.updateStatus(id, 'stopping');

      if (container.dockerId) {
        await this.orchestrator.stopContainer(container.dockerId);
        await this.orchestrator.removeContainer(container.dockerId);
      }

      await this.updateStatus(id, 'stopped');
      log('Container %s terminated', id);
      return true;
    } catch (error) {
      log('Container %s termination error: %O', id, error);
      const updated = await this.store.getContainer(id);
      if (updated) {
        updated.status = 'error';
        updated.error = error instanceof Error ? error.message : String(error);
        updated.updatedAt = new Date();
        await this.store.saveContainer(updated);
      }
      return false;
    }
  }

  /**
   * Apply a seed to a container.
   * The seed is forwarded to the container's seed endpoint.
   *
   * @param id - Container ID
   * @param encodedSeed - Base64url-encoded seed
   * @returns Result of seed application
   */
  async applySeed(id: string, encodedSeed: string): Promise<{ success: boolean; peersAdded?: number; error?: string }> {
    const container = await this.store.getContainer(id);
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    if (container.status !== 'running' && container.status !== 'enrolling') {
      return { success: false, error: `Container is not running (status: ${container.status})` };
    }

    if (!container.seedEndpoint) {
      return { success: false, error: 'Container does not have a seed endpoint' };
    }

    // The container gates `POST /seed` behind `Authorization: Bearer <token>`; a
    // record with an endpoint but no token (e.g. a legacy container provisioned
    // before token injection) can never authenticate, so fail loudly here rather
    // than letting the node reject the request with an opaque 401.
    if (!container.seedToken) {
      return { success: false, error: 'Container does not have a seed token' };
    }

    log('Applying seed to container %s', id);

    try {
      const response = await fetch(container.seedEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${container.seedToken}`,
        },
        body: JSON.stringify({ seed: encodedSeed }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Seed endpoint returned ${response.status}: ${errorText}` };
      }

      const result = await response.json() as { success: boolean; peersAdded?: number; error?: string };
      log('Seed applied to container %s: %O', id, result);
      return result;
    } catch (error) {
      log('Failed to apply seed to container %s: %O', id, error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Get the peer info for a container (peerId and multiaddrs).
   *
   * Reads the live `/status` payload on **every** call with no cache — matching
   * `getContainerStatus`'s freshness model so both `/status` read paths agree.
   * Caching peerId/multiaddrs warm-once served stale dial info forever after a
   * restart re-keyed the node's libp2p identity or remapped its multiaddrs.
   *
   * peerId/multiaddrs live in `/status` (not `/health`, which carries only
   * `{ status }`); the shared `fetchContainerHealthStatus` helper keeps the
   * `/status` URL derivation and wire shape in one place.
   *
   * @param id - Container ID
   * @returns Peer info, or undefined when the node has no peer identity yet
   */
  async getPeerInfo(id: string): Promise<{ peerId: string; multiaddrs: string[] } | undefined> {
    const container = await this.store.getContainer(id);
    if (!container) return undefined;

    // Fetch the live `/status` payload. `peerId` is `null` while the node is
    // still starting — treat that (and missing multiaddrs) as "not available".
    const status = await fetchContainerHealthStatus(container);
    if (!status?.peerId || !status.multiaddrs?.length) return undefined;

    return { peerId: status.peerId, multiaddrs: status.multiaddrs };
  }
}

