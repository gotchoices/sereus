/**
 * Shared fake orchestrator for the hosted-node unit tests — no real child
 * processes. Records every create / stop / remove, hands out deterministic
 * unique spawn results, and tracks per-`dockerId` liveness so a test can crash
 * one node and let the supervisor observe exactly that one as down.
 *
 * This file holds no tests of its own. The handle rules it shares with
 * `HostProcessOrchestrator` live in `src/__tests__/orchestrator-handle-contract.ts`
 * and run against both classes, so the two cannot come to disagree unnoticed.
 * The sibling `fake-orchestrator.test.ts` runs that contract and pins what only
 * the fake has (its recording arrays and hooks). Both exist so a future agent
 * cannot make a failing hosted-node test go green by relaxing the fake.
 */

import type {
  Orchestrator,
  OrchestratorCreateResult,
  OrchestratorStats,
} from '@serfab/cadre-provider';

import type { HostedSpawnRequest, ManagedNodeInfo, NodePorts, NodeStateListener } from '../../orchestrator/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** What the fake remembers about one spawned child. */
interface FakeChild {
  containerId: string;
  partyId: string;
  profile: 'storage' | 'transaction';
  running: boolean;
  /** The ports a re-spawn comes back on (the real `reusedNodePorts`). */
  ports: NodePorts;
}

/**
 * Mirrors the parts of `HostProcessOrchestrator`'s handle lifecycle the hosted-node
 * code depends on:
 *
 * - a **successful** `createContainer` drops every prior handle for the same
 *   `containerId` (the real `dropStaleHandle`), so an old `dockerId` stops
 *   resolving the moment its container re-spawns — and the new child comes back
 *   on the dropped handle's ports (the real `reusedNodePorts`);
 * - a **failed** `createContainer` leaves those handles exactly as it found them
 *   (the real `restoreDroppedHandles`);
 * - `createContainer` refuses a container whose previous child is still running
 *   (the real `refuseRespawnOverLiveChild`), so a test re-spawns only after a
 *   `stopContainer` or a {@link FakeOrchestrator.crash};
 * - `stopContainer` / `removeContainer` throw `Container not found: <dockerId>`
 *   for a handle this orchestrator no longer knows (the real `requireHandle`);
 * - `reclaimWorkdir` refuses a containerId that still resolves to a live
 *   handle (the real guard — that directory belongs to `removeContainer`).
 *
 * Consequently `stopped` / `removed` mean **"handles this orchestrator actually
 * acted on"**, not "calls attempted" — a stop aimed at a dropped handle is
 * rejected and never appears. `onStop` still fires for those rejected calls, so
 * a test can observe the attempt separately from its outcome.
 */
export class FakeOrchestrator implements Orchestrator {
  createCalls: HostedSpawnRequest[] = [];
  stopped: string[] = [];
  removed: string[] = [];
  /**
   * Container ids whose workdir this orchestrator actually removed. Same
   * "acted on, not attempted" rule as `stopped` / `removed`: a refused reclaim
   * leaves no entry.
   */
  reclaimedWorkdirs: string[] = [];
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
  onCreate?: (request: HostedSpawnRequest) => void;
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

  async createContainer(request: HostedSpawnRequest): Promise<OrchestratorCreateResult> {
    this.createCalls.push(request);
    this.onCreate?.(request);
    if (this.createDelayMs) await sleep(this.createDelayMs);
    if (this.failCreate) throw new Error('spawn boom');
    // After the delay, as in the real class, where the check is the last `await`
    // before the drop: a stop that lands during the spawn window is seen here.
    this.refuseRespawnOverLiveChild(request.containerId);
    // Drop the prior handles for this container, mirroring `dropStaleHandle`.
    // Success-only, and placed here on purpose: the real drop happens after the
    // spawn's every `await` and cannot fail afterwards, and a create that throws
    // puts the handles back (`restoreDroppedHandles`) — so a failed create must
    // leave them untouched. `HostedNodeSupervisor`'s give-up test depends on that.
    let ports: NodePorts | undefined;
    for (const [id, child] of this.children) {
      if (child.containerId === request.containerId) {
        ports = child.ports;
        this.children.delete(id);
      }
    }
    const n = ++this.counter;
    const dockerId = `dock_${n}`;
    ports ??= { health: 9000 + n, metrics: 9100 + n, p2p: 4000 + n, ws: 4100 + n };
    this.children.set(dockerId, {
      containerId: request.containerId,
      partyId: request.partyId,
      profile: request.profile,
      running: true,
      ports,
    });
    this.onSpawned?.(dockerId);
    return {
      dockerId,
      healthEndpoint: `http://127.0.0.1:${ports.health}/health`,
      metricsEndpoint: `http://127.0.0.1:${ports.metrics}/metrics`,
      seedEndpoint: `http://127.0.0.1:${ports.health}/seed`,
      seedToken: `seed-token-${n}`,
      p2pPort: ports.p2p,
    };
  }

  async stopContainer(dockerId: string): Promise<void> {
    // Before the check: a test may want to observe that a stop was *attempted*
    // even when this orchestrator rejects it.
    this.onStop?.(dockerId);
    const child = this.requireChild(dockerId);
    this.stopped.push(dockerId);
    child.running = false;
  }

  async removeContainer(dockerId: string): Promise<void> {
    // NOTE: the real `removeContainer` stops a still-live child first; this one
    // only deletes, so a remove aimed at a running child records no `stopped`
    // entry and emits no state change. Every hosted-node caller stops before it
    // reclaims, so nothing sees the difference today — if one stops doing that,
    // stop the child here too.
    this.requireChild(dockerId);
    this.removed.push(dockerId);
    this.children.delete(dockerId);
  }

  /**
   * NOTE: this and {@link getLogs} take an unknown `dockerId` where the real
   * class throws (`requireHandle`). No hosted-node path calls either, so the gap
   * is unobservable — route them through `requireChild` if one starts to.
   */
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

  /** The node by containerId or dockerId, as the real `getNode`. */
  getNode(idOrDockerId: string): ManagedNodeInfo | undefined {
    const direct = this.children.get(idOrDockerId);
    if (direct) return toNodeInfo(idOrDockerId, direct);
    for (const [dockerId, child] of this.children) {
      if (child.containerId === idOrDockerId) return toNodeInfo(dockerId, child);
    }
    return undefined;
  }

  listNodes(): ManagedNodeInfo[] {
    return [...this.children].map(([dockerId, child]) => toNodeInfo(dockerId, child));
  }

  /**
   * Remove the workdir of a container no handle owns, mirroring the real
   * `reclaimWorkdir`. Refuses (returns `false`, records nothing) while a child
   * for that containerId still resolves — that directory belongs to
   * `removeContainer`, which stops the child first.
   *
   * There is no directory here to check for existence, so a first reclaim of an
   * unresolvable id always reports `true`; the real class returns `false` when
   * the path is already gone. Nothing in the hosted-node layer branches on the
   * return value, so the gap is unobservable — model it if one starts to.
   */
  reclaimWorkdir(containerId: string): boolean {
    if (this.resolveDockerId(containerId)) return false;
    this.reclaimedWorkdirs.push(containerId);
    return true;
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
    const child = this.children.get(dockerId);
    if (!child?.running) return;
    child.running = false;
    this.emit(toNodeInfo(dockerId, child));
  }

  private emit(info: ManagedNodeInfo): void {
    for (const listener of this.listeners) listener(info);
  }

  /** Mirrors the real method of the same name for a child this process spawned. */
  private refuseRespawnOverLiveChild(containerId: string): void {
    for (const child of this.children.values()) {
      if (child.containerId === containerId && child.running) {
        throw new Error(`container ${containerId} is still running`);
      }
    }
  }

  /** Mirrors `HostProcessOrchestrator.requireHandle` — unknown handles throw. */
  private requireChild(dockerId: string): FakeChild {
    const child = this.children.get(dockerId);
    if (!child) throw new Error(`Container not found: ${dockerId}`);
    return child;
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
    ports: { ...child.ports },
    announcedAddrs: [],
  };
}
