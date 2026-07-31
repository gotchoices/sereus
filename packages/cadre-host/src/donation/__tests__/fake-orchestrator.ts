/**
 * Shared fake orchestrator for the donation unit tests — no real child
 * processes. Records every create / stop / remove, hands out deterministic
 * unique spawn results, and tracks per-`dockerId` liveness so a test can crash
 * one node and let the supervisor observe exactly that one as down.
 *
 * Not collected as a suite — vitest's `include` only matches `*.test.ts`.
 */

import type {
  Orchestrator,
  OrchestratorCreateRequest,
  OrchestratorCreateResult,
  OrchestratorStats,
} from '@serfab/cadre-provider';

import type { ManagedNodeInfo, NodeStateListener } from '../../orchestrator/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** What the fake remembers about one spawned child. */
interface FakeChild {
  containerId: string;
  partyId: string;
  profile: 'storage' | 'transaction';
  running: boolean;
}

export class FakeOrchestrator implements Orchestrator {
  createCalls: OrchestratorCreateRequest[] = [];
  stopped: string[] = [];
  removed: string[] = [];
  failCreate = false;
  createDelayMs = 0;
  /** Observation hook — lets a test inspect the world as the stop happens. */
  onStop?: (dockerId: string) => void;
  /** Observation hook — fires before the spawn resolves or fails. */
  onCreate?: (request: OrchestratorCreateRequest) => void;
  /** Observation hook — fires before the liveness answer is computed. */
  onIsRunning?: (dockerId: string) => void;

  private readonly children = new Map<string, FakeChild>();
  private readonly listeners = new Set<NodeStateListener>();
  private counter = 0;

  async createContainer(request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult> {
    this.createCalls.push(request);
    this.onCreate?.(request);
    if (this.createDelayMs) await sleep(this.createDelayMs);
    if (this.failCreate) throw new Error('spawn boom');
    const n = ++this.counter;
    const dockerId = `dock_${n}`;
    this.children.set(dockerId, {
      containerId: request.containerId,
      partyId: request.partyId,
      profile: request.profile,
      running: true,
    });
    return {
      dockerId,
      healthEndpoint: `http://127.0.0.1:${9000 + n}/health`,
      metricsEndpoint: `http://127.0.0.1:${9000 + n}/metrics`,
      seedEndpoint: `http://127.0.0.1:${9000 + n}/seed`,
      seedToken: `seed-token-${n}`,
      p2pPort: 4000 + n,
    };
  }

  async stopContainer(dockerId: string): Promise<void> {
    this.onStop?.(dockerId);
    this.stopped.push(dockerId);
    this.markStopped(dockerId);
  }

  async removeContainer(dockerId: string): Promise<void> {
    this.removed.push(dockerId);
    this.children.delete(dockerId);
  }

  async getStats(): Promise<OrchestratorStats> {
    return { cpuPercent: 0, memoryBytes: 0, networkRxBytes: 0, networkTxBytes: 0 };
  }

  /** Unknown handles read as not running, matching the real orchestrator. */
  async isRunning(dockerId: string): Promise<boolean> {
    this.onIsRunning?.(dockerId);
    return this.children.get(dockerId)?.running ?? false;
  }

  async getLogs(): Promise<string> {
    return '';
  }

  onStateChange(listener: NodeStateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Kill a child out from under the host — the crash the supervisor exists for. */
  crash(dockerId: string): void {
    this.markStopped(dockerId, { emit: true });
  }

  /** Emit an arbitrary state change (e.g. the owner node stopping). */
  emit(info: ManagedNodeInfo): void {
    for (const listener of this.listeners) listener(info);
  }

  private markStopped(dockerId: string, opts?: { emit?: boolean }): void {
    const child = this.children.get(dockerId);
    if (!child?.running) return;
    child.running = false;
    if (opts?.emit) this.emit(toNodeInfo(dockerId, child));
  }
}

function toNodeInfo(dockerId: string, child: FakeChild): ManagedNodeInfo {
  return {
    id: child.containerId,
    dockerId,
    partyId: child.partyId,
    profile: child.profile,
    status: child.running ? 'running' : 'stopped',
    spawnedAt: new Date(0).toISOString(),
    workdir: `/fake/${child.containerId}`,
    ports: { health: 0, metrics: 0, p2p: 0, admin: 0 },
  };
}
