/**
 * Container orchestrator abstraction.
 * Allows swapping between Docker, Kubernetes, etc.
 */

import type { ContainerResources } from '../types.js';
import type { PushCredentials } from '../config/types.js';

/** Container creation request for orchestrator */
export interface OrchestratorCreateRequest {
  /** Provider-assigned container ID */
  containerId: string;
  /** Party ID for control network */
  partyId: string;
  /** Bootstrap nodes */
  bootstrapNodes: string[];
  /** Node profile */
  profile: 'storage' | 'transaction';
  /** Resource limits */
  resources?: ContainerResources;
  /** Strand filter */
  strandFilter?: string;
  /**
   * Already-resolved push credentials for THIS tenant's node (or undefined). The
   * orchestrator injects exactly what it is handed and performs no tenant lookup
   * itself — cross-tenant isolation is guaranteed upstream, by ContainerService
   * resolving strictly by the launching tenant's id before calling this.
   */
  push?: PushCredentials;
  /**
   * Base64url owner public key(s) to pin as cold-start seed-trust anchors on the
   * spawned node (repeatable `--pin-owner-key` / `CADRE_OWNER_KEYS`). The pins are
   * the ONLY way trust reaches such a node: seed trust anchors on the node-local
   * trusted-owner store, which nothing in the replicated control state can seed —
   * so a node meant to accept a seed signed by a *foreign* cadre owner (the
   * node-donation flow in cadre-host) MUST be started with that owner's key(s)
   * pinned, or `POST /seed` is refused forever.
   *
   * Both implementations thread the list into the spawned node as the
   * comma-separated `CADRE_OWNER_KEYS`: cadre-host's `HostProcessOrchestrator`
   * into the child process's env, cadre-provider's `DockerOrchestrator` into the
   * container's env. Each caller passes exactly the keys of the one tenant /
   * requester the node is being launched for; no orchestrator supplies a default,
   * because a shared pin would let one tenant's owner seed another tenant's node.
   */
  pinnedOwnerKeys?: string[];
}

/** Container creation result from orchestrator */
export interface OrchestratorCreateResult {
  /** Orchestrator-specific container ID (e.g., Docker container ID) */
  dockerId: string;
  /** Health check endpoint URL */
  healthEndpoint: string;
  /** Metrics endpoint URL */
  metricsEndpoint: string;
  /** The URL of the node's seed API (`POST /seed`), served on the health server's port */
  seedEndpoint: string;
  /**
   * Per-container secret injected as `CADRE_SEED_TOKEN`. The container gates
   * `POST /seed` behind `Authorization: Bearer <seedToken>`, so the provider must
   * present this token when delivering a seed (see `ContainerService.applySeed`).
   */
  seedToken: string;
  /** P2P listening port */
  p2pPort: number;
}

/** Container stats from orchestrator */
export interface OrchestratorStats {
  /** CPU usage percentage */
  cpuPercent: number;
  /** Memory usage in bytes */
  memoryBytes: number;
  /** Network bytes received */
  networkRxBytes: number;
  /** Network bytes transmitted */
  networkTxBytes: number;
}

/**
 * Orchestrator interface for container management.
 * Implementations handle platform-specific details.
 */
export interface Orchestrator {
  /** Create and start a container */
  createContainer(request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult>;

  /** Stop a running container */
  stopContainer(dockerId: string): Promise<void>;

  /** Remove a stopped container */
  removeContainer(dockerId: string): Promise<void>;

  /** Get container stats */
  getStats(dockerId: string): Promise<OrchestratorStats>;

  /** Check if container is running */
  isRunning(dockerId: string): Promise<boolean>;

  /** Get container logs */
  getLogs(dockerId: string, tail?: number): Promise<string>;
}

/** How a container the orchestrator started is actually doing right now. */
export interface ContainerRunState {
  /** The container's process is up at this instant. */
  running: boolean;
  /** Times the orchestrator has restarted the child since it was created. */
  restartCount: number;
  /** When the child last exited; absent when it has never exited. */
  exitedAt?: Date;
  /** Exit code of that last exit; meaningful only alongside `exitedAt`. */
  exitCode?: number;
}

/**
 * Optional recovery capabilities beyond the base `Orchestrator`. Optional
 * because a test double or a future orchestrator may not offer them — every
 * caller must keep working (with the pre-existing, weaker behaviour) when the
 * method is absent.
 *
 * Deliberately NOT folded into `Orchestrator`: `@serfab/cadre-host`'s
 * `HostProcessOrchestrator` declares `implements Orchestrator` and carries its
 * own members, so widening the base interface would break that package.
 */
export interface RecoverableOrchestrator extends Orchestrator {
  /**
   * Live run state of a started container, or `undefined` when the
   * orchestrator no longer knows the container at all (already removed).
   * Throws when the run state could not be read — a broken control-plane
   * connection must not read as "the child is fine".
   */
  inspectRunState?(dockerId: string): Promise<ContainerRunState | undefined>;
}

/**
 * Mock orchestrator for testing.
 */
export class MockOrchestrator implements RecoverableOrchestrator {
  private containers = new Map<string, {
    running: boolean;
    request: OrchestratorCreateRequest;
    exitedAt?: Date;
    exitCode?: number;
  }>();
  private idCounter = 0;

  async createContainer(request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult> {
    const dockerId = `mock_${++this.idCounter}`;
    this.containers.set(dockerId, { running: true, request });

    return {
      dockerId,
      healthEndpoint: `http://localhost:${8080 + this.idCounter}/health`,
      metricsEndpoint: `http://localhost:${9090 + this.idCounter}/metrics`,
      seedEndpoint: `http://localhost:${8080 + this.idCounter}/seed`,
      seedToken: `mock-seed-token-${this.idCounter}`,
      p2pPort: 4000 + this.idCounter,
    };
  }

  async stopContainer(dockerId: string): Promise<void> {
    const container = this.containers.get(dockerId);
    if (container) {
      container.running = false;
      container.exitedAt = new Date();
      container.exitCode = 0;
    }
  }

  async removeContainer(dockerId: string): Promise<void> {
    this.containers.delete(dockerId);
  }

  async getStats(_dockerId: string): Promise<OrchestratorStats> {
    return {
      cpuPercent: 5.0,
      memoryBytes: 256 * 1024 * 1024,
      networkRxBytes: 1024 * 1024,
      networkTxBytes: 512 * 1024,
    };
  }

  async isRunning(dockerId: string): Promise<boolean> {
    return this.containers.get(dockerId)?.running ?? false;
  }

  /** Never restarts a child, so `restartCount` stays 0; only an explicit stop records an exit. */
  async inspectRunState(dockerId: string): Promise<ContainerRunState | undefined> {
    const container = this.containers.get(dockerId);
    if (!container) return undefined;
    return {
      running: container.running,
      restartCount: 0,
      ...(container.exitedAt ? { exitedAt: container.exitedAt, exitCode: container.exitCode } : {}),
    };
  }

  async getLogs(_dockerId: string, _tail?: number): Promise<string> {
    return 'Mock container logs\n';
  }
}

