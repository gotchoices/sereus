/**
 * Container orchestrator abstraction.
 * Allows swapping between Docker, Kubernetes, etc.
 */

import type { ContainerResources } from '../types.js';

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

/**
 * Mock orchestrator for testing.
 */
export class MockOrchestrator implements Orchestrator {
  private containers = new Map<string, { running: boolean; request: OrchestratorCreateRequest }>();
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

  async getLogs(_dockerId: string, _tail?: number): Promise<string> {
    return 'Mock container logs\n';
  }
}

