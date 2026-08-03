/**
 * Shared fake orchestrator for the donation unit tests — no real child
 * processes. Records every create / stop / remove, hands out deterministic
 * unique spawn results, and tracks per-`dockerId` liveness so a test can crash
 * one node and let the supervisor observe exactly that one as down.
 *
 * This file holds no tests of its own; its contract is pinned by the sibling
 * `fake-orchestrator.test.ts`, which exists so a future agent cannot make a
 * failing donation test go green by relaxing the fake.
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

/**
 * Mirrors the parts of `HostProcessOrchestrator`'s handle lifecycle the donation
 * code depends on:
 *
 * - a **successful** `createContainer` drops every prior handle for the same
 *   `containerId` (the real `dropStaleHandle`), so an old `dockerId` stops
 *   resolving the moment its container re-spawns;
 * - a **failed** `createContainer` leaves those handles exactly as it found them
 *   (the real `restoreDroppedHandles`);
 * - `stopContainer` / `removeContainer` throw `Container not found: <dockerId>`
 *   for a handle this orchestrator no longer knows (the real `requireHandle`).
 *
 * Consequently `stopped` / `removed` mean **"handles this orchestrator actually
 * acted on"**, not "calls attempted" — a stop aimed at a dropped handle is
 * rejected and never appears. `onStop` still fires for those rejected calls, so
 * a test can observe the attempt separately from its outcome.
 */
export class FakeOrchestrator implements Orchestrator {
  createCalls: OrchestratorCreateRequest[] = [];
  stopped: string[] = [];
  removed: string[] = [];
  failCreate = false;
  createDelayMs = 0;
  /**
   * Observation hook — lets a test inspect the world as the stop happens. Fires
   * even when the handle is unknown and the stop is then rejected.
   */
  onStop?: (dockerId: string) => void;
  /**
   * Observation hook — fires before the spawn resolves or fails, modelling the
   * real class's *pre-drop* `await` window (`ensureNodeIdentity`, `resolvePush`).
   * Work driven from here sees the previous handle still alive. Contrast
   * {@link onSpawned}.
   */
  onCreate?: (request: OrchestratorCreateRequest) => void;
  /**
   * Observation hook — fires once the drop has landed and the new child is
   * registered, immediately before `createContainer` resolves. Models the
   * microtask gap between the real `createContainer` returning and its caller's
   * `await` resuming: the real drop → launch → return runs synchronously, so
   * this is the earliest point other code can observe the post-drop world.
   * Contrast {@link onCreate}.
   */
  onSpawned?: (dockerId: string) => void;
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
    // Drop the prior handles for this container, mirroring `dropStaleHandle`.
    // Success-only, and placed here on purpose: the real drop happens after the
    // spawn's every `await` and cannot fail afterwards, and a create that throws
    // puts the handles back (`restoreDroppedHandles`) — so a failed create must
    // leave them untouched. `DonationSupervisor`'s give-up test depends on that.
    for (const [id, child] of this.children) {
      if (child.containerId === request.containerId) this.children.delete(id);
    }
    const n = ++this.counter;
    const dockerId = `dock_${n}`;
    this.children.set(dockerId, {
      containerId: request.containerId,
      partyId: request.partyId,
      profile: request.profile,
      running: true,
    });
    this.onSpawned?.(dockerId);
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
    // Before the check: a test may want to observe that a stop was *attempted*
    // even when this orchestrator rejects it.
    this.onStop?.(dockerId);
    this.requireChild(dockerId);
    this.stopped.push(dockerId);
    this.markStopped(dockerId);
  }

  async removeContainer(dockerId: string): Promise<void> {
    this.requireChild(dockerId);
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

  /** Resolve a spawn's friendly containerId back to its dockerId. */
  resolveDockerId(containerId: string): string | undefined {
    for (const [dockerId, child] of this.children) {
      if (child.containerId === containerId) return dockerId;
    }
    return undefined;
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

  /** Mirrors `HostProcessOrchestrator.requireHandle` — unknown handles throw. */
  private requireChild(dockerId: string): FakeChild {
    const child = this.children.get(dockerId);
    if (!child) throw new Error(`Container not found: ${dockerId}`);
    return child;
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
