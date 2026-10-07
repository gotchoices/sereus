import { randomBytes } from 'node:crypto';
import debug from 'debug';
import { multiaddr, CODE_IP4, CODE_IP6, CODE_P2P_CIRCUIT } from '@multiformats/multiaddr';

import { CLAIM_SECRET_BYTES, encodeNodeClaimPayload } from '@serfab/cadre-core';
import type { Orchestrator, OrchestratorCreateResult } from '@serfab/cadre-provider';

import type { NodeReachability } from '../nat/types.js';
import type { HostedSpawnRequest, ManagedNodeInfo, NodeStateListener } from '../orchestrator/types.js';
import type { HostedNodeStore } from './hosted-node-store.js';
import { HostedNodeWatcher } from './hosted-node-watcher.js';
import { PLACEHOLDER_PARTY, errorMessage, readNodeStatus, statusUrlFor } from './node-status.js';
import type {
  HostedNode,
  HostedNodeChange,
  HostedNodeChangeListener,
  HostedNodeStatus,
  HostedNodeView,
} from './types.js';
import { HostedNodeError } from './types.js';

const log = debug('cadre:host:hosted-node-service');

/**
 * The only statuses a node may come back from. An allowlist, not a terminal
 * denylist: `error` is a node the host gave up on, and `spawning` is a join still
 * in flight — replaying its spawn would race that join and strand the record in
 * `spawning`, which only the stuck-`spawning` reap collects.
 *
 * Checked twice in {@link HostedNodeService.respawn} — once on entry, once after
 * the spawn — so the "may this node come back" rule is stated exactly once.
 */
const RESPAWNABLE_STATUSES: ReadonlySet<HostedNodeStatus> = new Set<HostedNodeStatus>([
  'unclaimed',
  'joined',
]);

/**
 * Age after which a record still stuck in `spawning` is marked `error` and its
 * child, if any, reclaimed: the host wrote the row before starting the child, and
 * a crash/kill in that window (or during the spawn itself) leaves nothing to
 * advance it across a restart. A real spawn (identity key read/gen, port
 * allocation, process spawn) completes in well under a second normally, so 5
 * minutes is generously past "any plausible spawn" without risking a false reap
 * of one still genuinely in flight under heavy load.
 */
export const HOSTED_NODE_SPAWNING_TTL_MS = 5 * 60 * 1000;

/** How often the stuck-`spawning` reap runs while cadre-host is up. 5 minutes. */
export const HOSTED_NODE_REAP_SWEEP_MS = 5 * 60 * 1000;

/** What `claimDetails` answers: the QR payload and its parts. */
export interface ClaimDetails {
  /** `encodeNodeClaimPayload` of the three fields below — the text the QR code carries. */
  payload: string;
  peerId: string;
  /** Public addresses first (TCP, then WebSocket), then the node's own non-loopback LAN addresses. */
  multiaddrs: string[];
  /** The NAT layer's verdict for the node, or null when it has no entry yet. A phone at home reaches the LAN address either way. */
  reachability: NodeReachability | null;
}

/**
 * Outcome of {@link HostedNodeService.respawn}:
 *
 * - `respawned` — a new child is up and the record now names its handles.
 * - `abandoned` — the record was removed, or went `error`, while the spawn was in
 *   flight. The ending wins: the record is left exactly as the ending wrote it and
 *   the new child is cleaned up. `status` is the status that won, absent when the
 *   row is gone entirely.
 */
export type RespawnResult =
  | { outcome: 'respawned'; node: HostedNodeView }
  | { outcome: 'abandoned'; status?: HostedNodeStatus };

/**
 * The per-spawn fields a record carries for the child that currently exists.
 * Whatever the record names here is what every later cleanup (`remove` → stop +
 * reclaim) acts on, so a spawn that succeeded must land these on the record even
 * when the surrounding operation then fails.
 */
interface SpawnedHandles {
  dockerId: string;
  statusEndpoint: string;
}

/** A respawn's attempt counters — the record's `respawn` block, never absent. */
type RespawnAttempt = NonNullable<HostedNode['respawn']>;

/** Options for {@link HostedNodeService.respawn}. */
export interface RespawnOptions {
  /**
   * Whether this respawn spends one of the record's attempts. Default true: a crash
   * respawn does, since the supervisor's backoff and give-up read the count. A
   * deliberate restart of a running node (`HostedNodeSupervisor.restart`) passes false
   * and leaves both the counters and `updatedAt` alone.
   */
  countAttempt?: boolean;
}

/**
 * Orchestrator capabilities the service needs beyond the base `Orchestrator`.
 * `createContainer` takes the claim secret. The rest are optional — only
 * `HostProcessOrchestrator` implements them; absent on a test double or a future
 * orchestrator, the cleanup degrades to terminalizing the record with nothing to
 * reclaim, and the claim details carry LAN addresses only.
 */
export interface HostedNodeOrchestrator extends Orchestrator {
  createContainer(request: HostedSpawnRequest): Promise<OrchestratorCreateResult>;
  /**
   * Resolve a spawn's friendly containerId (== a hosted node's id) back to its
   * current dockerId, so a stuck-`spawning` reap can find and reclaim a child that
   * was actually spawned before the host died.
   */
  resolveDockerId?(containerId: string): string | undefined;
  /**
   * Remove the working directory a spawn created for `containerId` when no handle
   * owns it — the cleanup of last resort for a record that never got a `dockerId`.
   * Returns whether anything was removed. Refuses when a handle still resolves
   * (that child's directory belongs to `removeContainer`).
   */
  reclaimWorkdir?(containerId: string): boolean;
  /** The node's handle, for the ports its public addresses are built from. */
  getNode?(idOrDockerId: string): ManagedNodeInfo | undefined;
  /** The exit/start signal the status watcher follows. */
  onStateChange?(listener: NodeStateListener): () => void;
}

/** The NAT layer's two answers the claim details need. `NatService` satisfies this. */
export interface HostedNodeAddressSource {
  /** The node's public multiaddrs (no `/p2p/` suffix), TCP then WebSocket. */
  publicAddressesFor(nodeId: string, ports: { p2p: number; ws?: number }): string[];
  getStatus(): { nodes: NodeReachability[] };
}

/** Constructor options. */
export interface HostedNodeServiceOptions {
  /** Orchestrator that spawns/stops the hosted child processes. */
  orchestrator: HostedNodeOrchestrator;
  /** Persistent record store (`hosted-nodes.json`). */
  store: HostedNodeStore;
  /** The NAT layer, for the node's public addresses and reachability verdict. */
  addresses: HostedNodeAddressSource;
  /** Clock override for tests. */
  now?: () => Date;
}

/**
 * HostedNodeService — the host's one action, "Join a cadre", and what follows from it.
 *
 * `join` starts a child waiting to be claimed; `claimDetails` reads the node's
 * addresses and builds the QR payload; the status watcher ({@link startWatching})
 * notices the claim and the node's liveness; `respawn` brings a dead child back as
 * the same node with the same secret and ports; `remove` and `reset` end it. The
 * host contributes capacity only: it never holds an owner key, and the node
 * belongs to whoever claims it.
 *
 * **An ending that lands mid-operation wins.** Spawning a child takes seconds, and
 * a `remove` can land inside that window. `hosted-nodes.json` is written a whole row
 * at a time, so every long operation re-reads the record after its wait, decides
 * against what is actually stored, and merges forward only the fields it itself
 * produced — never the entry-time copy.
 *
 * NOTE: about 760 lines, mostly the comments that carry the re-read rule above; when
 * the invitation join kind lands (`cadre-host-join-by-invitation`), move the claim
 * details and address building (`claimDetails` through `isDialableFromLan`) into
 * their own module rather than growing this one.
 */
export class HostedNodeService {
  private readonly orchestrator: HostedNodeOrchestrator;
  private readonly store: HostedNodeStore;
  private readonly addresses: HostedNodeAddressSource;
  private readonly now: () => Date;
  private readonly listeners = new Set<HostedNodeChangeListener>();
  private readonly watcher: HostedNodeWatcher;
  /** Serialization tail for `join`, so two joins at once cannot interleave their store writes. */
  private joinTail: Promise<void> = Promise.resolve();

  constructor(opts: HostedNodeServiceOptions) {
    this.orchestrator = opts.orchestrator;
    this.store = opts.store;
    this.addresses = opts.addresses;
    this.now = opts.now ?? (() => new Date());
    this.watcher = new HostedNodeWatcher({
      store: this.store,
      orchestrator: this.orchestrator,
      now: this.now,
      emit: (change) => this.emit(change),
    });
    log('HostedNodeService initialized');
  }

  /** Register a change listener (the server publishes each change as an SSE event). Returns an unsubscribe fn. */
  onChange(listener: HostedNodeChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Report a change to the listeners. Public for the supervisor's give-up, which
   * writes the record itself; a listener that throws is logged, never propagated.
   */
  emit(change: HostedNodeChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        log('change listener threw for %s: %s', change.id, errorMessage(err));
      }
    }
  }

  /** Start following every node's `/status` (claims and liveness). Idempotent. */
  startWatching(): void {
    this.watcher.start();
  }

  stopWatching(): void {
    this.watcher.stop();
  }

  /** One status pass now, awaited — for tests and callers that need the result before going on. */
  pollStatuses(): Promise<void> {
    return this.watcher.poll();
  }

  /**
   * Start a node waiting to be claimed: mint its claim secret, write the record,
   * spawn the child with the placeholder party, and record its handles. On any
   * orchestrator failure the reserved resources are reclaimed and the record is
   * marked `error`. Resolves once the child is spawned; its `/status` may take a
   * few seconds more, which `claimDetails` reports as `node_unavailable`.
   */
  join(): Promise<HostedNodeView> {
    return this.serializeJoin(() => this.joinLocked());
  }

  private async joinLocked(): Promise<HostedNodeView> {
    const id = generateHostedNodeId();
    const nowIso = this.now().toISOString();
    const record: HostedNode = {
      id,
      join: { kind: 'claim', secret: generateClaimSecret() },
      partyId: PLACEHOLDER_PARTY,
      profile: 'storage',
      status: 'spawning',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.put(record);

    // The spawn is the only step that can fail before anything is allocated, so
    // it gets a `try` of its own — a wider one would swallow the abandon decision
    // below and mark a removal as a host-side `error`.
    let result: OrchestratorCreateResult;
    try {
      result = await this.orchestrator.createContainer(spawnRequestFor(record));
    } catch (err) {
      const message = errorMessage(err);
      log('spawn of hosted node %s failed: %s', id, message);
      this.markSpawnFailed(id, message);
      throw new HostedNodeError('orchestrator_error', `Failed to start hosted node: ${message}`);
    }

    // Re-read: `record` predates the orchestrator round-trip (seconds of wall
    // clock) and `store.put` replaces the whole row, so writing that copy back
    // would resurrect a node removed while the spawn was in flight. The store is
    // synchronous, so this read-decide-write is atomic against the event loop
    // only as long as no `await` sneaks in between.
    const current = this.store.get(id);
    if (!current || current.status !== 'spawning') {
      // The removal cleaned up nothing: the record named no `dockerId` yet, so
      // `remove`'s stop-and-reclaim never ran and this child is the only thing
      // holding the spawn's ports and workdir. Reclaim (not merely stop) — the
      // workdir was created by this very spawn, so there is nothing to preserve.
      log('hosted node %s went %s during its spawn — abandoning new child %s', id, current?.status ?? 'missing', result.dockerId);
      await this.safeReclaim(result.dockerId);
      throw current
        ? new HostedNodeError('invalid_state', `Hosted node ${id} was ${current.status} before it finished starting`)
        : new HostedNodeError('not_found', `No such hosted node: ${id}`);
    }

    const unclaimed: HostedNode = {
      ...current,
      ...handlesOf(result),
      status: 'unclaimed',
      updatedAt: this.now().toISOString(),
    };
    try {
      this.store.put(unclaimed);
    } catch (err) {
      const message = errorMessage(err);
      log('recording hosted node %s failed: %s', id, message);
      await this.safeReclaim(result.dockerId);
      this.markSpawnFailed(id, message);
      throw new HostedNodeError('orchestrator_error', `Failed to start hosted node: ${message}`);
    }
    log('hosted node %s is up and waiting to be claimed', id);
    this.emit({ kind: 'added', id });
    this.watcher.poke(id);
    return redact(unclaimed);
  }

  /**
   * Mark a still-`spawning` record as failed — and ONLY such a record. A row that
   * was removed while the spawn was in flight must not be recreated.
   *
   * Best-effort (mirroring {@link storeRespawnAttempt}): we are already unwinding a
   * spawn failure, and a store error here must not mask the error being reported
   * to the caller.
   */
  private markSpawnFailed(id: string, message: string): void {
    try {
      const current = this.store.get(id);
      if (current?.status !== 'spawning') return;
      this.store.put({ ...current, status: 'error', error: message, updatedAt: this.now().toISOString() });
      this.emit({ kind: 'changed', id });
    } catch (err) {
      log('failed to mark hosted node %s as errored: %s', id, errorMessage(err));
    }
  }

  /**
   * What the QR code carries for a node waiting to be claimed: its peer id, the
   * addresses a phone may dial it at, and its claim secret — the only place the
   * secret ever leaves the host. `409 invalid_state` unless the node is `unclaimed`;
   * `503 node_unavailable` until the child's `/status` answers (callers poll).
   */
  async claimDetails(id: string): Promise<ClaimDetails> {
    const node = this.requireNode(id);
    if (node.status !== 'unclaimed') {
      throw new HostedNodeError('invalid_state', `Hosted node ${id} is ${node.status}; only a node waiting to be claimed has claim details`);
    }
    if (!node.statusEndpoint) {
      throw new HostedNodeError('node_unavailable', `Hosted node ${id} has no status endpoint yet`);
    }
    const status = await readNodeStatus(node.statusEndpoint);
    this.recordPeerId(id, status.peerId);
    const multiaddrs = this.dialAddressesFor(id, status.peerId, status.multiaddrs);
    if (multiaddrs.length === 0) {
      throw new HostedNodeError('node_unavailable', `Hosted node ${id} reports no address a phone could dial yet`);
    }
    return {
      payload: encodeNodeClaimPayload({ peerId: status.peerId, multiaddrs, secret: node.join.secret }),
      peerId: status.peerId,
      multiaddrs,
      reachability: this.addresses.getStatus().nodes.find((n) => n.nodeId === id) ?? null,
    };
  }

  /** Cache the peer id on the record, once. Best-effort: the claim details do not depend on it. */
  private recordPeerId(id: string, peerId: string): void {
    try {
      // Re-read: the entry-time copy predates the `/status` round-trip.
      const current = this.store.get(id);
      if (!current || current.peerId === peerId) return;
      this.store.put({ ...current, peerId });
    } catch (err) {
      log('failed to record peer id of hosted node %s: %s', id, errorMessage(err));
    }
  }

  /**
   * The addresses the QR code names, in dial order: the node's public addresses
   * from the NAT layer with the peer id appended (a phone away from home needs
   * these), then the node's own non-loopback addresses as `/status` reports them
   * (they already carry `/p2p/`; a phone at home dials these). Loopback and relay
   * entries are dropped — nothing off this machine can use the former, and no
   * hosted node holds a relay reservation today.
   */
  private dialAddressesFor(id: string, peerId: string, reported: string[]): string[] {
    const ports = this.orchestrator.getNode?.(id)?.ports;
    const publicAddrs = ports
      ? this.addresses.publicAddressesFor(id, ports).map((a) => `${a}/p2p/${peerId}`)
      : [];
    const lanAddrs = reported.filter((a) => isDialableFromLan(a));
    return [...new Set([...publicAddrs, ...lanAddrs])];
  }

  /**
   * Re-spawn a node that is no longer running, replaying the record's party and
   * claim secret. The node keeps its workdir — and with it its identity key and
   * node-local stores — and comes back on the same ports, so it is the *same*
   * peer at the same addresses: a QR code already shown stays valid, and a claimed
   * node's cadre finds it where it was. Keeping the secret after the claim is
   * deliberate: `cadre-cli` honours `claim.json` and, with the secret still set,
   * answers a rival `already-claimed`.
   *
   * **Status is deliberately unchanged.** A `joined` node stays `joined`; an
   * `unclaimed` one keeps waiting. `connected` is dropped until the watcher reads
   * the new child.
   *
   * **An ending that lands mid-spawn wins.** The record is re-read after the
   * orchestrator returns; if it was removed (or went `error`) while the child was
   * starting, that write stands and the new child is abandoned — see
   * {@link abandonRespawn}. An abandoned respawn is a skip, not a failure, so a
   * sweep over the store keeps going. Orchestrator failures DO throw; the caller
   * owns backoff/give-up.
   *
   * NOTE: not serialized. Two overlapping calls for the same id both spawn a
   * child, and the second spawn drops the first's orchestrator handle — leaving
   * an unmanaged process. The supervisor serializes its passes for this reason.
   */
  async respawn(id: string, opts: RespawnOptions = {}): Promise<RespawnResult> {
    const node = this.requireNode(id);
    // Callers filter for this already; the guard is here so no future one can
    // resurrect or double-spawn a node by omission.
    if (!RESPAWNABLE_STATUSES.has(node.status)) {
      throw new HostedNodeError('invalid_state', `Hosted node ${id} cannot be respawned in status ${node.status}`);
    }

    // Just the counters, never a whole row copy: both exits below merge these
    // onto whatever the store holds *after* the spawn, and an entry-time record
    // in scope is a standing invitation to write the stale row back.
    const attempt: RespawnAttempt | undefined = opts.countAttempt === false
      ? undefined
      : { attempts: (node.respawn?.attempts ?? 0) + 1, lastAttemptAt: this.now().toISOString() };

    let spawned: SpawnedHandles | undefined;
    try {
      const result = await this.orchestrator.createContainer(spawnRequestFor(node));
      spawned = handlesOf(result);

      // Re-read: see `joinLocked`. A removal or a give-up that landed while the
      // spawn was in flight must stand.
      const current = this.store.get(id);
      if (!current || !RESPAWNABLE_STATUSES.has(current.status)) {
        return this.abandonRespawn(id, result.dockerId, current);
      }

      const { connected: _connected, ...rest } = current;
      const respawned: HostedNode = {
        ...rest,
        ...(attempt ? { respawn: attempt, updatedAt: this.now().toISOString() } : {}),
        ...spawned,
      };
      this.store.put(respawned);
      log('respawned hosted node %s → %s (status %s)', id, result.dockerId, respawned.status);
      this.emit({ kind: 'changed', id });
      this.watcher.poke(id);
      return { outcome: 'respawned', node: redact(respawned) };
    } catch (err) {
      const message = errorMessage(err);
      log('respawn of hosted node %s failed: %s', id, message);
      // Stop — never reclaim — a child we spawned but failed to record:
      // `removeContainer` deletes the workdir, which holds the identity key and
      // node-local stores that are the whole reason a respawn is the same node.
      // The new handles go onto the record below, so it names the child that
      // actually exists and a later `remove()` reclaims that one.
      if (spawned) await this.safeStop(spawned.dockerId);
      this.storeRespawnAttempt(id, attempt, spawned);
      throw new HostedNodeError('orchestrator_error', `Failed to respawn hosted node: ${message}`);
    }
  }

  /**
   * Give up on a respawn whose record ended while the child was starting: stop
   * the new child and, unless the record went `error`, reclaim it.
   *
   * Reclaim, not merely stop. The removal's own cleanup already ran and found
   * nothing: `HostProcessOrchestrator.createContainer` calls `dropStaleHandle`
   * *while* spawning, so by the time the concurrent `remove` reached its
   * stop/reclaim the old handle was gone and both calls were swallowed as
   * best-effort no-ops. The new handle is now the only thing holding that
   * spawn's ports and workdir, so stopping alone would leak both.
   *
   * `error` is the deliberate exception: `removeContainer` deletes the workdir,
   * and `HostedNodeSupervisor.giveUp` keeps it on purpose so the identity key the
   * node's cadre approved survives. Since both spawns share one workdir
   * (`<rootDir>/<containerId>`), reclaiming here would delete exactly what
   * `giveUp` meant to keep.
   *
   * NOTE: that skipped reclaim leaks the new spawn's ports — the record still
   * names the *previous* `dockerId`, so a later `remove` cleans up the old
   * handle, not this one. Unreachable today (`giveUp` is only called from the
   * supervisor's serialized pass, so it cannot overlap a respawn); if a second
   * `respawn` caller ever appears, write the new `dockerId` onto the `error`
   * record here so that later `remove` reclaims the right child.
   */
  private async abandonRespawn(id: string, dockerId: string, current: HostedNode | undefined): Promise<RespawnResult> {
    const status = current?.status;
    log('hosted node %s went %s during respawn — abandoning new child %s', id, status ?? 'missing', dockerId);
    await this.safeStop(dockerId);
    if (status !== 'error') await this.safeReclaim(dockerId);
    return status ? { outcome: 'abandoned', status } : { outcome: 'abandoned' };
  }

  /**
   * Remove a hosted node: delete the row FIRST, then stop and reclaim the child
   * (its workdir, identity key and data go with it). The node's cadre keeps the
   * node's row until its owner removes it there.
   *
   * Order matters: stopping the child fires the orchestrator's `onStateChange`,
   * and the supervisor's exit-triggered pass must find no record — otherwise it
   * observes "node gone, record still `joined`" and brings back a node the admin
   * just removed. The tradeoff: a crash between the delete and the stop leaves a
   * running child no record names, which `remove` on its id still reclaims (below).
   *
   * A handle no record names — `hosted-nodes.json` lost, or a handle an older
   * build persisted — is removed the same way, so `/api/nodes` cannot list a node
   * for good that nothing can end.
   */
  async remove(id: string): Promise<void> {
    const node = this.store.get(id);
    if (!node) {
      await this.removeOrphanHandle(id);
      return;
    }
    this.store.remove(id);
    if (node.dockerId) {
      await this.safeStop(node.dockerId);
      await this.safeReclaim(node.dockerId);
    } else {
      // No `dockerId` — the spawn never got far enough to produce one, so the
      // stop-and-reclaim above has nothing to aim at and the node's working
      // directory would be stranded on disk with nothing able to name it.
      //
      // NOTE: this can race an in-flight `join` for the same record — the delete
      // may land between that spawn's `mkdirSync` and its `spawn`. The end state
      // is still correct (`joinLocked`'s post-spawn re-read sees no record and
      // reclaims the new child, which deletes the workdir anyway); the interim
      // delete can only make that child fail to start noisily, which is strictly
      // better than a permanent strand.
      this.safeReclaimWorkdir(id);
    }
    log('hosted node %s removed', id);
    this.emit({ kind: 'removed', id });
  }

  private async removeOrphanHandle(id: string): Promise<void> {
    const dockerId = this.orchestrator.resolveDockerId?.(id);
    if (!dockerId) throw new HostedNodeError('not_found', `No such hosted node: ${id}`);
    log('hosted node %s has a handle but no record — removing the handle', id);
    await this.safeStop(dockerId);
    await this.safeReclaim(dockerId);
    this.emit({ kind: 'removed', id });
  }

  /**
   * Remove a node and start a fresh one with a new secret and identity. For the
   * case where someone else photographed the QR code and claimed the node first,
   * and for an `error` node the admin wants to try again.
   */
  async reset(id: string): Promise<HostedNodeView> {
    await this.remove(id);
    return this.join();
  }

  /**
   * Mark records stuck in `spawning` past `ttlMs` as `error` and reclaim whatever
   * the orchestrator can still find for them — the record is written before the
   * child spawn starts, so a host crash/kill anywhere in that window (including
   * mid-spawn) leaves nothing to advance it across a restart. Run once at
   * startup and on a periodic sweep. Age is measured from `updatedAt`, which for
   * a genuinely-stuck row equals `createdAt` — `joinLocked` never touches a
   * `spawning` record again except to advance it out of this predicate.
   * Best-effort per record: a failed reap is logged and the sweep continues.
   * Returns the reaped ids.
   */
  async reapStuckSpawning(ttlMs: number = HOSTED_NODE_SPAWNING_TTL_MS): Promise<string[]> {
    const cutoff = this.now().getTime() - ttlMs;
    const stale = this.store.list().filter((n) => isStuckSpawning(n, cutoff));
    const reaped: string[] = [];
    for (const node of stale) {
      try {
        // Re-read: an in-flight (same-process) `joinLocked` call can still
        // advance this exact record between the snapshot above and now.
        const current = this.store.get(node.id);
        if (!current || !isStuckSpawning(current, cutoff)) continue;
        await this.reclaimStuckSpawning(current);
        reaped.push(node.id);
        log('reaped stuck spawning hosted node %s (age > %dms)', node.id, ttlMs);
      } catch (err) {
        log('failed to reap stuck spawning hosted node %s: %s', node.id, errorMessage(err));
      }
    }
    return reaped;
  }

  /**
   * Terminalize a stuck-`spawning` record as `error` and reclaim any child the
   * orchestrator can still find for it. Status is written FIRST (same ordering
   * rule as {@link remove}): reclaiming fires `onStateChange`, and anything
   * listening must already see a terminal record.
   *
   * NOTE: the stop only reaches a child the orchestrator has a handle for.
   * `HostProcessOrchestrator.launchChild` spawns the process and persists the
   * handle in the same synchronous step, so the only child this misses is one
   * whose host died between the OS spawn and that write — an orphan *process*
   * this reap terminalizes the record for but cannot kill (its ports stay held
   * until a reboot). Its working directory is reclaimed by container name when
   * no handle resolves, which also covers the far commoner case of a host that
   * died before any child existed at all.
   */
  private async reclaimStuckSpawning(node: HostedNode): Promise<void> {
    this.store.put({
      ...node,
      status: 'error',
      error: 'stuck starting past its deadline — the host likely restarted mid-spawn',
      updatedAt: this.now().toISOString(),
    });
    this.emit({ kind: 'changed', id: node.id });
    const dockerId = this.orchestrator.resolveDockerId?.(node.id);
    if (dockerId) {
      await this.safeStop(dockerId);
      await this.safeReclaim(dockerId);
    } else {
      this.safeReclaimWorkdir(node.id);
    }
  }

  /** One node (secret stripped), or undefined when unknown. */
  get(id: string): HostedNodeView | undefined {
    const node = this.store.get(id);
    return node ? redact(node) : undefined;
  }

  /** Every node (secret stripped). */
  list(): HostedNodeView[] {
    return this.store.list().map(redact);
  }

  private requireNode(id: string): HostedNode {
    const node = this.store.get(id);
    if (!node) throw new HostedNodeError('not_found', `No such hosted node: ${id}`);
    return node;
  }

  /** Best-effort stop; logs but never throws (cleanup path). */
  private async safeStop(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.stopContainer(dockerId);
    } catch (err) {
      log('failed to stop container %s: %s', dockerId, errorMessage(err));
    }
  }

  /**
   * Persist a failed respawn's attempt counters (none for an uncounted restart) —
   * plus, when the spawn itself succeeded and it was the record write that failed,
   * the new child's handles. Merged onto whatever is on disk now, never written
   * wholesale: the caller's copy predates the orchestrator round-trip.
   *
   * `status` and `updatedAt` are deliberately untouched — the attempt did not succeed.
   *
   * Recording `spawned` is what keeps the record pointing at the child that
   * actually exists: `createContainer` already dropped the handle the record
   * previously named, so leaving the old `dockerId` there would send every later
   * stop/reclaim at an id the orchestrator cannot resolve — stranding the node's
   * workdir on disk forever.
   *
   * Best-effort: we are already unwinding a respawn failure, and a store error
   * here must not mask it. Losing the write costs the caller one extra attempt
   * before backoff; the supervisor's next pass re-reads the record, finds the
   * named child not running, and respawns again — which drops whatever handle is
   * current, so the ports self-heal either way.
   */
  private storeRespawnAttempt(id: string, respawn: RespawnAttempt | undefined, spawned?: SpawnedHandles): void {
    if (!respawn && !spawned) return;
    try {
      // A row that vanished (a removal) must not be recreated.
      const current = this.store.get(id);
      if (!current) return;
      this.store.put({ ...current, ...(respawn ? { respawn } : {}), ...spawned });
    } catch (err) {
      log('failed to record respawn attempt for %s: %s', id, errorMessage(err));
    }
  }

  /** Best-effort remove; logs but never throws (cleanup path). */
  private async safeReclaim(dockerId: string): Promise<void> {
    try {
      await this.orchestrator.removeContainer(dockerId);
    } catch (err) {
      log('failed to reclaim container %s: %s', dockerId, errorMessage(err));
    }
  }

  /**
   * Best-effort removal of the working directory of a node whose spawn never
   * produced a `dockerId`; logs but never throws (cleanup path). A no-op on an
   * orchestrator without the capability, and on one that refuses because a live
   * handle still owns the directory.
   */
  private safeReclaimWorkdir(id: string): void {
    try {
      if (this.orchestrator.reclaimWorkdir?.(id)) {
        log('reclaimed orphaned workdir for hosted node %s', id);
      }
    } catch (err) {
      log('failed to reclaim workdir for hosted node %s: %s', id, errorMessage(err));
    }
  }

  /** Run `fn` after any in-flight join. */
  private serializeJoin<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.joinTail.then(fn, fn);
    // The stored tail swallows outcomes — a rejected join must not reject the
    // next caller's wait, only defer it.
    this.joinTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** `hn_<high-entropy base64url>` — also the node's orchestrator containerId and workdir name. */
function generateHostedNodeId(): string {
  return `hn_${randomBytes(12).toString('base64url')}`;
}

function generateClaimSecret(): string {
  return randomBytes(CLAIM_SECRET_BYTES).toString('base64url');
}

/** The spawn a record describes: its party (the placeholder until the claim), profile and claim secret. Used by `join` and `respawn` alike. */
function spawnRequestFor(node: HostedNode): HostedSpawnRequest {
  return {
    containerId: node.id,
    partyId: node.partyId,
    bootstrapNodes: [],
    profile: node.profile,
    claimSecret: node.join.secret,
  };
}

/** The record fields a spawn result lands. `seedToken` and `seedEndpoint` are the provider's shape; cadre-host ignores both. */
function handlesOf(result: OrchestratorCreateResult): SpawnedHandles {
  return { dockerId: result.dockerId, statusEndpoint: statusUrlFor(result.healthEndpoint) };
}

/** Strip the claim secret. */
function redact(node: HostedNode): HostedNodeView {
  const { join, ...rest } = node;
  return { ...rest, join: { kind: join.kind } };
}

/**
 * Whether a record is still a stuck-`spawning` reap candidate. Stated once and
 * applied twice in {@link HostedNodeService.reapStuckSpawning} — on the sweep's
 * candidate list, and again per record before the terminal write.
 */
function isStuckSpawning(node: HostedNode | undefined, cutoff: number): boolean {
  return node?.status === 'spawning' && Date.parse(node.updatedAt) < cutoff;
}

/**
 * Whether an address the node reports is one a phone on the host's LAN can dial:
 * not loopback, not the unspecified address (libp2p expands a `0.0.0.0` listen into
 * interface addresses, but a raw one names nothing to dial), not a relay circuit,
 * and parsable. A DNS address passes (it names something off this machine); an
 * address with no host component at all is dropped.
 */
function isDialableFromLan(addr: string): boolean {
  let components: ReturnType<ReturnType<typeof multiaddr>['getComponents']>;
  try {
    components = multiaddr(addr).getComponents();
  } catch {
    return false;
  }
  if (components.some((c) => c.code === CODE_P2P_CIRCUIT)) return false;
  const host = components[0];
  if (!host?.value) return false;
  if (host.code === CODE_IP4) return !host.value.startsWith('127.') && host.value !== '0.0.0.0';
  if (host.code === CODE_IP6) return host.value !== '::1' && host.value !== '::';
  return true;
}
