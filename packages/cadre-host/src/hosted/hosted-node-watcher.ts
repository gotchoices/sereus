import debug from 'debug';

import type { NodeStateListener } from '../orchestrator/types.js';
import type { HostedNodeStore } from './hosted-node-store.js';
import { errorMessage, readNodeStatus, reportsClaim, type NodeStatus } from './node-status.js';
import type { HostedNode, HostedNodeChange } from './types.js';

const log = debug('cadre:host:hosted-node-watcher');

/** How often an unclaimed node's `/status` is read for the claim. */
export const HOSTED_NODE_CLAIM_POLL_MS = 2_000;

/** How often a joined node's `/status` is read for its connection count. */
export const HOSTED_NODE_CONNECTED_POLL_MS = 15_000;

/** The orchestrator surface the watcher needs: the exit/start signal, when the orchestrator has one. */
export interface WatchedOrchestrator {
  onStateChange?(listener: NodeStateListener): () => void;
}

export interface HostedNodeWatcherOptions {
  store: HostedNodeStore;
  orchestrator: WatchedOrchestrator;
  now: () => Date;
  /** Where a claim or a liveness change is reported (`HostedNodeService.emit`). */
  emit: (change: HostedNodeChange) => void;
}

/**
 * Follows each hosted node's `/status`: an `unclaimed` record becomes `joined` when
 * the node reports a finished claim, and a `joined` record's `connected` follows the
 * node's control-connection count. Best-effort: a poll that fails is retried on the
 * next tick, and nothing here throws out of the timer.
 *
 * One timer at the claim cadence drives both: every tick polls every unclaimed node,
 * and each joined node every {@link HOSTED_NODE_CONNECTED_POLL_MS}, or at once when it
 * was poked — the orchestrator's state change on a respawn pokes the node, and the
 * poke stands until a poll succeeds, so a respawned child is noticed on its first
 * answer rather than at the next 15 s mark. Polls are serialized on one promise
 * tail so a timer pass and a poked pass cannot both write one record.
 *
 * NOTE: the 2 s timer ticks while nothing is unclaimed (one cached store read, no
 * I/O per tick); if it ever shows up in a profile, stop it when no record is
 * unclaimed and restart it from `poke`.
 */
export class HostedNodeWatcher {
  private readonly store: HostedNodeStore;
  private readonly orchestrator: WatchedOrchestrator;
  private readonly now: () => Date;
  private readonly emit: (change: HostedNodeChange) => void;

  private tail: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  /** When each joined node's `/status` last answered (ms since epoch). */
  private readonly lastPolledAt = new Map<string, number>();
  /** Joined nodes to poll on the next pass regardless of cadence. */
  private readonly due = new Set<string>();

  constructor(opts: HostedNodeWatcherOptions) {
    this.store = opts.store;
    this.orchestrator = opts.orchestrator;
    this.now = opts.now;
    this.emit = opts.emit;
  }

  /** Start the timer and the state-change subscription, and poll once. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.orchestrator.onStateChange?.((info) => { this.poke(info.id); });
    this.timer = setInterval(() => { this.poke(); }, HOSTED_NODE_CLAIM_POLL_MS);
    this.timer.unref();
    this.poke();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Ask for a pass now; `id` names a joined node to poll ahead of its cadence. Fire-and-forget. */
  poke(id?: string): void {
    if (id) this.due.add(id);
    void this.poll().catch((err) => { log('status poll failed: %s', errorMessage(err)); });
  }

  /** One pass over every unclaimed and due joined record, serialized against the others. */
  poll(): Promise<void> {
    const next = this.tail.then(() => this.pollOnce(), () => this.pollOnce());
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async pollOnce(): Promise<void> {
    let records: HostedNode[];
    try {
      records = this.store.list().filter((n) => n.status === 'unclaimed' || n.status === 'joined');
    } catch (err) {
      // A malformed hosted-nodes.json throws on every load; log rather than let it escape the timer.
      log('poll could not list hosted nodes: %s', errorMessage(err));
      return;
    }
    this.forgetRemoved(new Set(records.map((r) => r.id)));
    for (const record of records) {
      if (this.shouldPoll(record)) await this.pollOne(record);
    }
  }

  /** Drop the cadence and poke bookkeeping of nodes no longer on record, so neither map grows with removals. */
  private forgetRemoved(live: Set<string>): void {
    for (const id of this.lastPolledAt.keys()) if (!live.has(id)) this.lastPolledAt.delete(id);
    for (const id of this.due) if (!live.has(id)) this.due.delete(id);
  }

  private shouldPoll(record: HostedNode): boolean {
    if (record.status === 'unclaimed' || this.due.has(record.id)) return true;
    const last = this.lastPolledAt.get(record.id);
    return last === undefined || this.now().getTime() - last >= HOSTED_NODE_CONNECTED_POLL_MS;
  }

  private async pollOne(record: HostedNode): Promise<void> {
    if (!record.statusEndpoint) return;
    let status: NodeStatus;
    try {
      status = await readNodeStatus(record.statusEndpoint);
    } catch (err) {
      log('hosted node %s did not answer /status (retried next tick): %s', record.id, errorMessage(err));
      return;
    }
    this.lastPolledAt.set(record.id, this.now().getTime());
    this.due.delete(record.id);

    // Re-read: `record` predates the round-trip and `store.put` replaces the whole
    // row, so writing that copy back would resurrect a node removed meanwhile, or
    // undo a respawn's new handles. The store is synchronous, so this read-decide-
    // write is atomic against the event loop as long as no `await` sneaks in.
    const current = this.store.get(record.id);
    if (!current || current.status !== record.status) return;
    if (current.status === 'unclaimed') {
      this.applyUnclaimed(current, status);
    } else {
      this.applyJoined(current, status);
    }
  }

  /** An unclaimed node that reports a finished claim is `joined`, with the party and owner the claim named. */
  private applyUnclaimed(current: HostedNode, status: NodeStatus): void {
    if (!reportsClaim(status)) return;
    this.store.put({
      ...current,
      status: 'joined',
      partyId: status.node.partyId,
      ownerKey: status.node.claimedBy,
      peerId: current.peerId ?? status.peerId,
      connected: status.node.connectionPaths.total > 0,
      updatedAt: this.now().toISOString(),
    });
    log('hosted node %s was claimed by owner %s into cadre %s', current.id, status.node.claimedBy.slice(0, 8), status.node.partyId);
    this.emit({ kind: 'claimed', id: current.id });
  }

  /** A joined node's `connected` follows its control-connection count; published only on a change. */
  private applyJoined(current: HostedNode, status: NodeStatus): void {
    const connected = status.node.connectionPaths.total > 0;
    if (current.connected === connected) return;
    this.store.put({ ...current, connected, updatedAt: this.now().toISOString() });
    log('hosted node %s is now %s', current.id, connected ? 'connected' : 'disconnected');
    this.emit({ kind: 'changed', id: current.id });
  }
}
