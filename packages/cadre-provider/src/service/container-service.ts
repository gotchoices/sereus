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
import { fetchContainerHealthStatus } from './container-health.js';

const log = debug('cadre:provider:container');

/** Container service options */
export interface ContainerServiceOptions {
  /** Store for persisting container state */
  store: ProviderStore;
  /** Container orchestrator (Docker, K8s, etc.) */
  orchestrator: Orchestrator;
}

/**
 * Service for managing container lifecycle.
 * Handles creation, status monitoring, and termination.
 */
export class ContainerService {
  private readonly store: ProviderStore;
  private readonly orchestrator: Orchestrator;

  constructor(options: ContainerServiceOptions) {
    this.store = options.store;
    this.orchestrator = options.orchestrator;
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

      // Create the container via orchestrator
      const result = await this.orchestrator.createContainer({
        containerId: container.id,
        partyId: request.partyId,
        bootstrapNodes: request.bootstrapNodes,
        profile: request.profile,
        resources: request.resources,
        strandFilter: request.strandFilter,
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

      if (container.healthEndpoint) {
        try {
          const response = await fetch(container.healthEndpoint);
          if (response.ok) {
            const health = await response.json() as { status: string };
            if (health.status === 'healthy') {
              await this.updateStatus(containerId, 'running');
              log('Container %s is now running', containerId);
              return;
            }
          }
        } catch {
          // Health check failed, keep waiting
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    log('Container %s enrollment timeout', containerId);
  }

  /** Update container status */
  private async updateStatus(id: string, status: ContainerStatus): Promise<void> {
    const container = await this.store.getContainer(id);
    if (!container) return;
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

    log('Applying seed to container %s', id);

    try {
      const response = await fetch(container.seedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
   * Fetches from the container's health endpoint.
   *
   * @param id - Container ID
   * @returns Peer info or undefined if not available
   */
  async getPeerInfo(id: string): Promise<{ peerId: string; multiaddrs: string[] } | undefined> {
    const container = await this.store.getContainer(id);
    if (!container) return undefined;

    // Return cached values if available
    if (container.peerId && container.multiaddrs?.length) {
      return { peerId: container.peerId, multiaddrs: container.multiaddrs };
    }

    // Fetch from health endpoint
    if (!container.healthEndpoint) return undefined;

    try {
      const response = await fetch(container.healthEndpoint);
      if (!response.ok) return undefined;

      const health = await response.json() as { peerId?: string; multiaddrs?: string[] };
      if (health.peerId && health.multiaddrs) {
        // Cache the values
        container.peerId = health.peerId;
        container.multiaddrs = health.multiaddrs;
        container.updatedAt = new Date();
        await this.store.saveContainer(container);

        return { peerId: health.peerId, multiaddrs: health.multiaddrs };
      }
    } catch {
      // Health fetch failed
    }

    return undefined;
  }
}

